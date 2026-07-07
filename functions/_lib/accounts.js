// Trial/full account model — stored in the REPORTS KV namespace under `acct:<code>`.
// Usage counters live server-side so trial limits can't be bypassed client-side.

const PREFIX = 'acct:';

function shortCode() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

export function newTrial({ label, searches = 3, results = 20, days = 7 } = {}) {
  const now = new Date();
  return {
    code: 'TRIAL-' + shortCode(),
    label: label || 'Trial user',
    type: 'trial',
    searchLimit: Number(searches) || 3,
    resultCap: Number(results) || 20,
    features: { deep: false, download: false, share: false },
    searchesUsed: 0,
    createdAt: now.toISOString(),
    expiresAt: days ? new Date(now.getTime() + Number(days) * 86400000).toISOString() : null,
    active: true,
  };
}

export async function getAccount(kv, code) {
  if (!kv || !code) return null;
  const raw = await kv.get(PREFIX + code);
  return raw ? JSON.parse(raw) : null;
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
      if (raw) out.push(JSON.parse(raw));
    }
    cursor = r.cursor;
    if (r.list_complete) break;
  } while (cursor);
  return out;
}

export function isExpired(a) {
  return !!(a.expiresAt && Date.now() > new Date(a.expiresAt).getTime());
}

// Sanitized profile sent to the client (no server-only fields).
export function profileOf(a) {
  const remaining = a.searchLimit == null ? null : Math.max(0, a.searchLimit - (a.searchesUsed || 0));
  return {
    code: a.code, label: a.label, type: a.type,
    live: true, features: a.features,
    searchLimit: a.searchLimit, resultCap: a.resultCap,
    searchesUsed: a.searchesUsed || 0, remaining, expiresAt: a.expiresAt,
  };
}

export function fullProfile() {
  return {
    code: 'OWNER', label: 'Full access', type: 'full',
    live: true, features: { deep: true, download: true, share: true },
    searchLimit: null, resultCap: null, searchesUsed: 0, remaining: null, expiresAt: null,
  };
}
