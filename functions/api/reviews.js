import { fetchReviews, mineReviews, draftReply, demoMining } from '../_lib/reviews.js';
import {
  resolveAccess, resolveKey, reserveApiCalls, refundApiCalls,
  spendAiCredits, aiRemaining, apiRemaining, COST, AI_COST,
} from '../_lib/accounts.js';

// POST /api/reviews
//   { action: 'mine',  placeId, name, code }        -> mined themes + quotes
//   { action: 'reply', review:{text,rating,author}, businessName, tone, code }
//
// ⚠️ `mine` spends the most expensive Google SKU (Places Details + `reviews`
// = Enterprise + Atmosphere). It is therefore:
//   - full-tier only (trials get 403, same as /api/plan and /api/zones),
//   - one lead per request — never bulk,
//   - cached in KV for 30 days, keyed by placeId.
// A cache hit costs nothing: KV reads are free and don't count as subrequests.
//
// Subrequest budget: 1 Google call + 1 Workers AI call. Nowhere near the 50 cap.

const CACHE_PREFIX = 'rev:';
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const action = body.action === 'reply' ? 'reply' : 'mine';
  const code = (body.code || '').trim();
  const kv = context.env.REPORTS;
  const ai = context.env.AI || null; // unbound in local dev without `--ai AI`

  // Demo tier (no access code) gets canned data — never touches Google or AI.
  if (!code) {
    if (action === 'reply') {
      const r = await draftReply({
        ai: null,
        businessName: (body.businessName || 'this business').slice(0, 120),
        review: sanitizeReview(body.review),
      });
      return json({ ...r, demo: true });
    }
    return json(demoMining(body.name || undefined));
  }

  const access = await resolveAccess(context, code);
  if (!access.ok) return json({ error: access.error }, access.status);

  const { account, isOwner } = access;
  const { key: googleKey, byok } = resolveKey(context, body);

  // Gate on AFFORDABILITY, not on tier. Mining spends two different budgets:
  // Google's Enterprise SKU (skipped when the customer brings their own key)
  // and our Workers AI allocation (never skippable). An account that can pay
  // for both may mine, whatever it's called.
  const noAi = () =>
    json({
      error: `Out of AI credits (${aiRemaining(account)} left). Review mining is available on the full plan, or top up your credits.`,
      outOfCredits: true,
    }, 402);

  // --- reply drafting: no Google call, so it needs no key -------------------
  if (action === 'reply') {
    const review = sanitizeReview(body.review);
    if (!review.text) return json({ error: 'review.text is required' }, 400);
    if (account && !(await spendAiCredits(kv, account, AI_COST.reply))) return noAi();
    const result = await draftReply({
      ai,
      businessName: (body.businessName || 'this business').slice(0, 120),
      review,
      tone: typeof body.tone === 'string' && body.tone.trim() ? body.tone.trim().slice(0, 80) : undefined,
    });
    return json({ ...result, aiRemaining: account ? aiRemaining(account) : null });
  }

  // --- mining ---------------------------------------------------------------
  const placeId = (body.placeId || '').trim();
  if (!placeId || !/^[A-Za-z0-9_-]{5,255}$/.test(placeId)) {
    return json({ error: 'A valid placeId is required' }, 400);
  }
  if (!googleKey) return json({ error: 'No Google API key is configured on the server.' }, 501);

  // A cache hit costs nothing — check it BEFORE spending any budget.
  const cacheKey = CACHE_PREFIX + placeId;
  if (kv && !body.refresh) {
    const hit = await kv.get(cacheKey);
    if (hit) {
      try {
        return json({ ...JSON.parse(hit), cached: true });
      } catch { /* corrupt entry — fall through and re-mine */ }
    }
  }

  // Reserve the Google spend (Enterprise + Atmosphere SKU, weighted 10x).
  const metered = !!(account && !byok);
  if (metered && !(await reserveApiCalls(kv, account, COST.reviewMine))) {
    return json({
      error: `Out of API credits (${apiRemaining(account)} left, mining costs ${COST.reviewMine}). Add your own Google API key in Settings.`,
      outOfCredits: true,
    }, 402);
  }
  // Then the AI spend. If this fails, hand back the Google reservation.
  if (account && !(await spendAiCredits(kv, account, AI_COST.mine))) {
    if (metered) await refundApiCalls(kv, account, COST.reviewMine);
    return noAi();
  }

  let fetched;
  try {
    fetched = await fetchReviews(placeId, googleKey);
  } catch (err) {
    if (metered) await refundApiCalls(kv, account, COST.reviewMine);
    return json({ ok: false, error: `Google rejected the review request: ${err.message}` }, 502);
  }

  const result = await mineReviews({ ai, ...fetched, name: fetched.name || body.name || '' });
  if (!ai) result.aiUnavailable = true; // surfaced in the UI: heuristic, not a model

  if (kv) {
    // Cache even the heuristic result — re-mining costs the Enterprise SKU again.
    // Cache the mined data ONLY: this KV entry is shared across every account,
    // so per-account balances must never be written into it.
    context.waitUntil(kv.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL }));
  }

  // Per-account fields are added to the RESPONSE after caching, never before.
  return json({
    ...result,
    byok,
    ...(account ? {
      apiRemaining: account.apiBudget === null ? null : apiRemaining(account),
      aiRemaining: aiRemaining(account),
    } : {}),
  });
}

function sanitizeReview(r) {
  const x = r && typeof r === 'object' ? r : {};
  return {
    text: String(x.text || '').slice(0, 2000).trim(),
    rating: Number(x.rating) || 3,
    author: String(x.author || 'A customer').slice(0, 80),
  };
}
