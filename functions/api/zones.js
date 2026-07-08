import { resolveAccess } from '../_lib/accounts.js';
import { fetchZone, MAX_ZONES_PER_REQUEST } from '../_lib/places.js';
import { scoreBusiness } from '../_lib/scoring.js';

// POST /api/zones { keyword, location, zones: [rect], code }
//
// Step 2 of a deep search. Searches a BATCH of zones and reports which ones came
// back saturated, so the browser can subdivide them. Hard-capped at
// MAX_ZONES_PER_REQUEST zones (x3 pages = 45 Google calls) to stay under
// Cloudflare's 50-subrequest-per-invocation limit.

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

  const access = await resolveAccess(context, (body.code || '').trim());
  if (!access.ok) return json({ error: access.error }, access.status);
  if (!access.isOwner && !access.account?.features?.deep) {
    return json({ error: 'Deep search is not available on your plan.' }, 403);
  }

  const apiKey = context.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'Search is not configured.' }, 501);

  let calls = 0;
  const found = new Map();
  const saturated = [];

  const out = await mapLimit(zones, 5, (rect) => fetchZone(keyword, rect, apiKey, 3));
  for (let i = 0; i < zones.length; i++) {
    const r = out[i];
    calls += r.calls;
    if (r.saturated) saturated.push(i);
    for (const b of r.places) if (b.placeId && !found.has(b.placeId)) found.set(b.placeId, b);
  }

  const now = new Date().toISOString();
  const results = [...found.values()].map((b) => ({
    ...b, ...scoreBusiness(b), keyword, location, foundAt: now,
  }));

  return json({ results, saturated, calls, zonesSearched: zones.length });
}
