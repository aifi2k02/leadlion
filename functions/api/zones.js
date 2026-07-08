import { authorizeSpend, refundApiCalls, apiRemaining, COST } from '../_lib/accounts.js';
import { fetchZone, MAX_ZONES_PER_REQUEST } from '../_lib/places.js';
import { scoreBusiness } from '../_lib/scoring.js';

// POST /api/zones { keyword, location, zones: [rect], code, googleKey? }
//
// Step 2 of a deep search. Searches a BATCH of zones and reports which ones came
// back saturated, so the browser can subdivide them. Hard-capped at
// MAX_ZONES_PER_REQUEST zones (x3 pages = 45 Google calls) to stay under
// Cloudflare's 50-subrequest-per-invocation limit.
//
// This is the most expensive endpoint in the product: a deep search calls it
// dozens of times. We reserve the worst case (every zone paginating to 3 pages)
// up front, then refund the difference — an empty countryside zone costs 1 call,
// not 3, and the customer should only pay for what Google actually billed.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

async function mapLimit(items, limit, fn) {
  const results = [];
  const queue = items.map((it, i) => [it, i]);
  const worker = async () => {
    while (queue.length) {
      const [it, i] = queue.shift();
      results[i] = await fn(it);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));
  const keyword = (body.keyword || '').trim();
  const location = (body.location || '').trim();
  const zones = Array.isArray(body.zones) ? body.zones : [];
  if (!keyword || !zones.length) return json({ error: 'keyword and zones are required' }, 400);
  if (zones.length > MAX_ZONES_PER_REQUEST) {
    return json({ error: `Too many zones in one request (max ${MAX_ZONES_PER_REQUEST}).` }, 400);
  }

  // Worst case: every zone paginates to 3 pages.
  const estimate = zones.length * 3 * COST.zonePage;
  const auth = await authorizeSpend(context, body, { estimate, requireDeep: true });
  if (!auth.ok) return json({ error: auth.error, outOfCredits: auth.outOfCredits }, auth.status);

  let calls = 0;
  const found = new Map();
  const saturated = [];

  const out = await mapLimit(zones, 5, (rect) => fetchZone(keyword, rect, auth.key, 3));
  for (let i = 0; i < zones.length; i++) {
    const r = out[i];
    calls += r.calls;
    if (r.saturated) saturated.push(i);
    for (const b of r.places) if (b.placeId && !found.has(b.placeId)) found.set(b.placeId, b);
  }

  // Give back the pages we reserved but never fetched.
  if (auth.reserved > calls) {
    await refundApiCalls(context.env.REPORTS, auth.account, auth.reserved - calls);
  }

  const now = new Date().toISOString();
  const results = [...found.values()].map((b) => ({
    ...b, ...scoreBusiness(b), keyword, location, foundAt: now,
  }));

  return json({
    results, saturated, calls, zonesSearched: zones.length,
    byok: auth.byok,
    apiRemaining: auth.account ? apiRemaining(auth.account) : null,
  });
}
