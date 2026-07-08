import { authorizeSpend, refundApiCalls, apiRemaining, COST } from '../_lib/accounts.js';
import { geocodeCity, DEPTH } from '../_lib/places.js';

// POST /api/plan { keyword, location, depth, code, googleKey? }
//
// Step 1 of a deep search. Resolves the city and hands the browser the root
// zones + quadtree config. Costs 1-2 Google calls, far under the 50-subrequest
// Worker limit. The browser then drives /api/zones batch by batch.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));
  const location = (body.location || '').trim();
  const depth = ['deep', 'exhaustive'].includes(body.depth) ? body.depth : 'deep';
  if (!location) return json({ error: 'location is required' }, 400);

  // Grid search is a full-plan feature; trials are capped to 'fast'.
  // Reserve the geocode cost before spending it.
  const auth = await authorizeSpend(context, body, { estimate: COST.geocode, requireDeep: true });
  if (!auth.ok) return json({ error: auth.error, outOfCredits: auth.outOfCredits }, auth.status);

  const geo = await geocodeCity(location, auth.key);
  if (!geo) {
    // Nothing usable came back — don't charge for a plan we couldn't make.
    if (auth.reserved) await refundApiCalls(context.env.REPORTS, auth.account, auth.reserved);
    return json({ cityResolved: false }); // client falls back to a fast search
  }

  const cfg = DEPTH[depth];
  const { low, high } = geo.viewport;
  const N = cfg.rootN;
  const dLat = (high.latitude - low.latitude) / N;
  const dLng = (high.longitude - low.longitude) / N;

  const zones = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      zones.push({
        low: { latitude: low.latitude + i * dLat, longitude: low.longitude + j * dLng },
        high: { latitude: low.latitude + (i + 1) * dLat, longitude: low.longitude + (j + 1) * dLng },
      });
    }
  }

  // Tell the browser how much it can actually afford, so the quadtree can cap
  // its own budget instead of failing mid-search with a 402.
  const affordable = auth.account ? apiRemaining(auth.account) : Infinity;
  const budget = auth.byok || affordable === Infinity ? cfg.budget : Math.min(cfg.budget, affordable);

  return json({
    cityResolved: true,
    resolvedCity: geo.address || geo.name,
    resolvedLevel: geo.level || 'city',
    depth,
    zones,
    byok: auth.byok,
    apiRemaining: affordable === Infinity ? null : affordable,
    budgetCapped: budget < cfg.budget,
    config: { maxDepth: cfg.maxDepth, budget, minSpan: cfg.minSpan },
  });
}
