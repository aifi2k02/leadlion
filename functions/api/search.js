import { scoreBusiness } from '../_lib/scoring.js';
import { demoSearch } from '../_lib/demo.js';

// POST /api/search  { keyword, location, apiKey? }
// Uses (in priority order): server env key -> user-supplied key -> demo data.
// Key never appears in responses.

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.businessStatus',
  'places.photos',
  'places.regularOpeningHours',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
  'places.editorialSummary',
  'nextPageToken', // enables pagination (top-level, no places. prefix)
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const keyword = (body.keyword || '').trim();
  const location = (body.location || '').trim();
  if (!keyword || !location) {
    return json({ error: 'keyword and location are required' }, 400);
  }

  const apiKey = context.env.GOOGLE_PLACES_API_KEY || (body.apiKey || '').trim();
  const deep = !!body.deep;

  let businesses;
  let mode;
  let meta = {};
  if (apiKey) {
    try {
      if (deep) {
        const r = await deepSearch(keyword, location, apiKey);
        businesses = r.results;
        meta = { deep: r.deep, cells: r.cells };
      } else {
        businesses = await googleSearch(keyword, location, apiKey);
      }
      mode = 'live';
    } catch (err) {
      return json({ error: `Google Places error: ${err.message}` }, 502);
    }
  } else {
    businesses = demoSearch(keyword, location);
    mode = 'demo';
  }

  const results = businesses
    .map((b) => ({ ...b, ...scoreBusiness(b), keyword, location, foundAt: new Date().toISOString() }))
    .sort((a, b) => b.opportunityScore - a.opportunityScore);

  return json({ mode, count: results.length, ...meta, results });
}

function mapPlace(p) {
  return {
    placeId: p.id,
    demo: false,
    name: p.displayName?.text || 'Unknown',
    address: p.formattedAddress || '',
    category: p.primaryTypeDisplayName?.text || null,
    rating: p.rating || null,
    reviewCount: p.userRatingCount || 0,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
    photoCount: (p.photos || []).length,
    hasHours: !!p.regularOpeningHours,
    // Places API doesn't expose claimed status; heuristic: no website, no
    // hours and <3 photos usually means an auto-generated unclaimed listing.
    claimed: !(!p.websiteUri && !p.regularOpeningHours && (p.photos || []).length < 3),
    description: p.editorialSummary?.text || null,
    businessStatus: p.businessStatus || 'OPERATIONAL',
    mapsUrl: p.googleMapsUri || null,
  };
}

async function fetchPage(textQuery, apiKey, pageToken, rectangle) {
  const body = { textQuery, pageSize: 20 };
  if (pageToken) body.pageToken = pageToken;
  if (rectangle) body.locationRestriction = { rectangle };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Google Text Search caps a single query at 60 results (3 pages of 20).
// We paginate through all available pages and dedupe by place id.
async function googleSearch(keyword, location, apiKey, maxPages = 3) {
  const textQuery = `${keyword} in ${location}`;
  const seen = new Set();
  const out = [];
  let pageToken = null;

  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await fetchPage(textQuery, apiKey, pageToken);
    } catch (err) {
      if (page === 0) throw err; // first page failing = real error
      break; // later page failed (e.g. token not ready) — return what we have
    }
    for (const p of data.places || []) {
      if (p.id && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(mapPlace(p));
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    await sleep(1500); // let Google validate the next page token
  }
  return out;
}

// ---- Deep Search: tile the city into a grid and search each cell ----------

// Get the city's bounding box (viewport) via a single Places lookup — reuses
// the Places API already enabled, so no extra API to turn on.
async function geocodeCity(location, apiKey) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.viewport,places.location,places.displayName',
    },
    body: JSON.stringify({ textQuery: location, pageSize: 1 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.places?.[0]?.viewport || null;
}

// Search one grid cell (strict rectangle boundary), paginating up to 2 pages.
async function fetchCell(keyword, rectangle, apiKey, maxPages = 2) {
  const out = [];
  let token = null;
  for (let p = 0; p < maxPages; p++) {
    let data;
    try {
      data = await fetchPage(keyword, apiKey, token, rectangle);
    } catch {
      break;
    }
    for (const place of data.places || []) out.push(mapPlace(place));
    token = data.nextPageToken;
    if (!token) break;
    await sleep(1500);
  }
  return out;
}

// Concurrency-limited map.
async function mapLimit(items, limit, fn) {
  const results = [];
  const queue = items.map((it, i) => [it, i]);
  const worker = async () => {
    while (queue.length) {
      const [it, i] = queue.shift();
      results[i] = await fn(it, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

async function deepSearch(keyword, location, apiKey) {
  const vp = await geocodeCity(location, apiKey);
  // No bounding box? fall back to the standard 60-result paginated search.
  if (!vp?.low || !vp?.high) {
    return { results: await googleSearch(keyword, location, apiKey), cells: 1, deep: false };
  }

  const latMin = vp.low.latitude, latMax = vp.high.latitude;
  const lngMin = vp.low.longitude, lngMax = vp.high.longitude;
  const N = 4; // 4x4 = 16 cells; each cell up to 40 results
  const dLat = (latMax - latMin) / N;
  const dLng = (lngMax - lngMin) / N;

  const cells = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      cells.push({
        low: { latitude: latMin + i * dLat, longitude: lngMin + j * dLng },
        high: { latitude: latMin + (i + 1) * dLat, longitude: lngMin + (j + 1) * dLng },
      });
    }
  }

  const perCell = await mapLimit(cells, 6, (rect) => fetchCell(keyword, rect, apiKey, 2));

  const seen = new Set();
  const out = [];
  for (const arr of perCell) {
    for (const b of arr) {
      if (b.placeId && !seen.has(b.placeId)) {
        seen.add(b.placeId);
        out.push(b);
      }
    }
  }
  return { results: out, cells: cells.length, deep: true };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
