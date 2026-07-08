import { resolveAccess } from '../_lib/accounts.js';
import { geocodeCity, DEPTH } from '../_lib/places.js';

// POST /api/plan { keyword, location, depth, code }
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

  const access = await resolveAccess(context, (body.code || '').trim());
  if (!access.ok) return json({ error: access.error }, access.status);
  // Grid search is a full-plan feature. Trials are capped to 'fast'.
  if (!access.isOwner && !access.account?.features?.deep) {
    return json({ error: 'Deep search is not available on your plan.' }, 403);
  }

  const apiKey = context.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'Search is not configured.' }, 501);

  const geo = await geocodeCity(location, apiKey);
  if (!geo) return json({ cityResolved: false }); // client falls back to a fast search

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

  return json({
    cityResolved: true,
    resolvedCity: geo.address || geo.name,
    resolvedLevel: geo.level || 'city',
    depth,
    zones,
    config: { maxDepth: cfg.maxDepth, budget: cfg.budget, minSpan: cfg.minSpan },
  });
}
