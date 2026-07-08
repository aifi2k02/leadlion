import { fetchReviews, mineReviews, draftReply, demoMining } from '../_lib/reviews.js';
import { resolveAccess } from '../_lib/accounts.js';

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

  // Review mining is a full-tier feature: it spends the priciest Google SKU.
  if (!access.isOwner && access.account?.type !== 'full') {
    return json({ error: 'AI review mining is available on the full plan.' }, 403);
  }

  // --- reply drafting: no Google call, so it needs no key -------------------
  if (action === 'reply') {
    const review = sanitizeReview(body.review);
    if (!review.text) return json({ error: 'review.text is required' }, 400);
    const result = await draftReply({
      ai,
      businessName: (body.businessName || 'this business').slice(0, 120),
      review,
      tone: typeof body.tone === 'string' && body.tone.trim() ? body.tone.trim().slice(0, 80) : undefined,
    });
    return json(result);
  }

  // --- mining ---------------------------------------------------------------
  const placeId = (body.placeId || '').trim();
  if (!placeId || !/^[A-Za-z0-9_-]{5,255}$/.test(placeId)) {
    return json({ error: 'A valid placeId is required' }, 400);
  }

  const apiKey = context.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'No Google API key is configured on the server.' }, 501);

  const cacheKey = CACHE_PREFIX + placeId;
  if (kv && !body.refresh) {
    const hit = await kv.get(cacheKey);
    if (hit) {
      try {
        return json({ ...JSON.parse(hit), cached: true });
      } catch { /* corrupt entry — fall through and re-mine */ }
    }
  }

  let fetched;
  try {
    fetched = await fetchReviews(placeId, apiKey);
  } catch (err) {
    return json({ ok: false, error: `Google rejected the review request: ${err.message}` }, 502);
  }

  const result = await mineReviews({ ai, ...fetched, name: fetched.name || body.name || '' });
  if (!ai) result.aiUnavailable = true; // surfaced in the UI: heuristic, not a model

  if (kv) {
    // Cache even the heuristic result — re-mining costs the Enterprise SKU again.
    context.waitUntil(kv.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL }));
  }
  return json(result);
}

function sanitizeReview(r) {
  const x = r && typeof r === 'object' ? r : {};
  return {
    text: String(x.text || '').slice(0, 2000).trim(),
    rating: Number(x.rating) || 3,
    author: String(x.author || 'A customer').slice(0, 80),
  };
}
