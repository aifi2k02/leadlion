// Trial/full account model — stored in the REPORTS KV namespace under `acct:<code>`.
// Usage counters live server-side so limits can't be bypassed client-side.
//
// ---------------------------------------------------------------------------
// THE COST MODEL
//
// There are two meters, because there are two different things that cost money:
//
//   apiBudget   — Google Places calls made with OUR key. 1 unit = 1 HTTP call to
//                 Google, exactly like Local Falcon's "1 credit = 1 map pin".
//                 Metering the real unit of cost (not "searches") is the only
//                 honest way to price this: a fast search is 3 calls, a deep
//                 search is hundreds. Charging both as "1 search" is how you
//                 wake up to a bill you didn't sell.
//
//   aiCredits   — Workers AI calls (review mining, reply drafting). Cheap per
//                 unit but metered on OUR Cloudflare account, so it needs a cap.
//
// BYOK (bring your own key): when a request carries the customer's own Google
// key, Places calls cost US nothing, so apiBudget is NOT charged. That is the
// whole business model — see resolveKey().
//
// ⚠️ KV is eventually consistent and has no atomic increment. Two concurrent
// requests can both read the same counter and both write. We reserve BEFORE
// doing the work (never after) so the worst case is over-counting the customer,
// not under-counting our spend. A deep search fires ~3 batches in parallel, so
// the practical drift is bounded by that concurrency. If this ever needs to be
// exact, it wants a Durable Object, not a KV key.

const PREFIX = 'acct:';

// Cost weights, in units of "one Google API call".
// Place Details WITH the `reviews` field bills Google's Enterprise + Atmosphere
// SKU — their most expensive tier — so one review-mine is charged as if it were
// several ordinary calls. This is a deliberate, documented approximation:
// verify against Billing → Reports before pricing anything on it.
export const COST = {
  searchPage: 1,      // one page of Places text search (20 results)
  zonePage: 1,        // one page of a quadtree zone search
  geocode: 2,         // /api/plan: geocoding + a possible Places fallback
  reviewMine: 10,     // Place Details + reviews (Enterprise + Atmosphere SKU)
};

export const AI_COST = {
  mine: 1,
  reply: 1,
};

const TRIAL_DEFAULTS = {
  searches: 3,
  results: 20,
  days: 7,
  apiBudget: 60,   // ~20 fast searches' worth of headroom; searches cap first
  aiCredits: 0,    // review mining is a full-plan feature
};

function shortCode() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function newTrial({ label, searches, results, days, apiBudget, aiCredits, deep = false } = {}) {
  const now = new Date();
  const num = (v, d) => (v === null || v === '' || v === undefined ? d : Number(v));
  return {
    code: 'TRIAL-' + shortCode(),
    label: label || 'Trial user',
    type: 'trial',
    searchLimit: num(searches, TRIAL_DEFAULTS.searches),
    resultCap: num(results, TRIAL_DEFAULTS.results),
    features: { deep: !!deep, download: false, share: false },
    searchesUsed: 0,

    // Cost meters. null = unlimited.
    apiBudget: apiBudget === null ? null : num(apiBudget, TRIAL_DEFAULTS.apiBudget),
    apiCallsUsed: 0,
    aiCredits: aiCredits === null ? null : num(aiCredits, TRIAL_DEFAULTS.aiCredits),
    aiCreditsUsed: 0,

    createdAt: now.toISOString(),
    expiresAt: days ? new Date(now.getTime() + Number(days) * 86400000).toISOString() : null,
    active: true,
  };
}

// Accounts created before the credit ledger existed lack these fields, and
// `undefined - 1` is NaN. Every read goes through here.
function normalize(a) {
  if (!a) return a;
  if (a.apiBudget === undefined) a.apiBudget = TRIAL_DEFAULTS.apiBudget;
  if (a.aiCredits === undefined) a.aiCredits = TRIAL_DEFAULTS.aiCredits;
  a.apiCallsUsed = Number(a.apiCallsUsed) || 0;
  a.aiCreditsUsed = Number(a.aiCreditsUsed) || 0;
  a.searchesUsed = Number(a.searchesUsed) || 0;
  return a;
}

export async function getAccount(kv, code) {
  if (!kv || !code) return null;
  const raw = await kv.get(PREFIX + code);
  return raw ? normalize(JSON.parse(raw)) : null;
}

export async function putAccount(kv, a) {
  await kv.put(PREFIX + a.code, JSON.stringify(a));
}

export async function delAccount(kv, code) {
  await kv.delete(PREFIX + code);
}

export async function listAccounts(kv) {
  const out = [];
  let cursor;
  do {
    const r = await kv.list({ prefix: PREFIX, cursor });
    for (const k of r.keys) {
      const raw = await kv.get(k.name);
      if (raw) out.push(normalize(JSON.parse(raw)));
    }
    cursor = r.cursor;
    if (r.list_complete) break;
  } while (cursor);
  return out;
}

export function isExpired(a) {
  return !!(a.expiresAt && Date.now() > new Date(a.expiresAt).getTime());
}

// --- The ledger ------------------------------------------------------------

export function apiRemaining(a) {
  if (!a || a.apiBudget === null) return Infinity;
  return Math.max(0, a.apiBudget - (a.apiCallsUsed || 0));
}

export function aiRemaining(a) {
  if (!a || a.aiCredits === null) return Infinity;
  return Math.max(0, a.aiCredits - (a.aiCreditsUsed || 0));
}

// Reserve BEFORE spending Google's quota. Returns false if the budget can't
// cover it — the caller must then refuse the work, not do it and apologise.
export async function reserveApiCalls(kv, a, n) {
  if (!a || a.apiBudget === null) return true; // owner / unlimited
  if (apiRemaining(a) < n) return false;
  a.apiCallsUsed = (a.apiCallsUsed || 0) + n;
  await putAccount(kv, a);
  return true;
}

// Hand back what the reservation over-estimated (a zone that returned 1 page,
// not 3). Never let this push the counter below zero.
export async function refundApiCalls(kv, a, n) {
  if (!a || a.apiBudget === null || n <= 0) return;
  a.apiCallsUsed = Math.max(0, (a.apiCallsUsed || 0) - n);
  await putAccount(kv, a);
}

export async function spendAiCredits(kv, a, n) {
  if (!a || a.aiCredits === null) return true;
  if (aiRemaining(a) < n) return false;
  a.aiCreditsUsed = (a.aiCreditsUsed || 0) + n;
  await putAccount(kv, a);
  return true;
}

// --- Access + key resolution ------------------------------------------------

// Sanitized profile sent to the client. Never contains a key.
export function profileOf(a, { byok = false } = {}) {
  const remaining = a.searchLimit == null ? null : Math.max(0, a.searchLimit - (a.searchesUsed || 0));
  return {
    code: a.code, label: a.label, type: a.type,
    live: true, features: a.features,
    searchLimit: a.searchLimit, resultCap: a.resultCap,
    searchesUsed: a.searchesUsed || 0, remaining, expiresAt: a.expiresAt,
    byok,
    apiBudget: a.apiBudget, apiCallsUsed: a.apiCallsUsed || 0,
    apiRemaining: a.apiBudget === null ? null : apiRemaining(a),
    aiCredits: a.aiCredits, aiCreditsUsed: a.aiCreditsUsed || 0,
    aiRemaining: a.aiCredits === null ? null : aiRemaining(a),
  };
}

export function fullProfile() {
  return {
    code: 'OWNER', label: 'Full access', type: 'full',
    live: true, features: { deep: true, download: true, share: true },
    searchLimit: null, resultCap: null, searchesUsed: 0, remaining: null, expiresAt: null,
    byok: false,
    apiBudget: null, apiCallsUsed: 0, apiRemaining: null,
    aiCredits: null, aiCreditsUsed: 0, aiRemaining: null,
  };
}

// Resolve an access code to a tier. Used by every endpoint that spends the
// owner's Google quota. Returns { ok:true, isOwner, account } or { ok:false, ... }.
export async function resolveAccess(context, code) {
  const isOwner = !!(context.env.ADMIN_PASSWORD && code === context.env.ADMIN_PASSWORD);
  if (isOwner) return { ok: true, isOwner: true, account: null };

  const kv = context.env.REPORTS;
  if (!code || !kv) return { ok: false, status: 401, error: 'An access code is required.' };

  const account = await getAccount(kv, code);
  if (!account || !account.active) return { ok: false, status: 401, error: 'Invalid or deactivated access code.' };
  if (isExpired(account)) return { ok: false, status: 403, error: 'This trial has expired.' };
  return { ok: true, isOwner: false, account };
}

// Google keys look like AIzaSy... — a loose shape check, not authentication.
// Google will reject a bad key; this only stops obvious garbage reaching them.
export function isPlausibleGoogleKey(k) {
  return typeof k === 'string' && /^AIza[0-9A-Za-z_\-]{20,60}$/.test(k.trim());
}

// BYOK. The customer's key arrives with each request and is NEVER persisted:
// storing customer credentials in KV would mean one KV compromise leaks every
// customer's billable Google key at once. It lives in their browser instead.
//
// Returns { key, byok }. When byok is true the caller must NOT charge apiBudget:
// the customer is paying Google directly. That is the entire business model.
export function resolveKey(context, body) {
  const own = (body?.googleKey || '').trim();
  if (own && isPlausibleGoogleKey(own)) return { key: own, byok: true };
  return { key: context.env.GOOGLE_PLACES_API_KEY || null, byok: false };
}

// Convenience for endpoints: resolve the key, then check we can afford the work.
// `estimate` is in COST units. Returns { ok, key, byok, account, error, status }.
export async function authorizeSpend(context, body, { estimate = 0, requireDeep = false } = {}) {
  const access = await resolveAccess(context, (body?.code || '').trim());
  if (!access.ok) return { ok: false, status: access.status, error: access.error };

  if (requireDeep && !access.isOwner && !access.account?.features?.deep) {
    return { ok: false, status: 403, error: 'Deep search is not available on your plan.' };
  }

  const { key, byok } = resolveKey(context, body);
  if (!key) return { ok: false, status: 501, error: 'Search is not configured.' };

  const { account } = access;
  const kv = context.env.REPORTS;

  // Own key → own bill → no budget to enforce.
  if (byok || access.isOwner || !account) {
    return { ok: true, key, byok, account, isOwner: access.isOwner, reserved: 0 };
  }

  if (estimate > 0) {
    const reserved = await reserveApiCalls(kv, account, estimate);
    if (!reserved) {
      return {
        ok: false, status: 402,
        error: `Out of API credits (${apiRemaining(account)} left, this needs ${estimate}). Add your own Google API key in Settings for unlimited searches.`,
        outOfCredits: true,
      };
    }
  }
  return { ok: true, key, byok, account, isOwner: false, reserved: estimate };
}
