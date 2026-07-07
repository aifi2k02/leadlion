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

  let businesses;
  let mode;
  if (apiKey) {
    try {
      businesses = await googleSearch(keyword, location, apiKey);
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

  return json({ mode, count: results.length, results });
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

async function fetchPage(textQuery, apiKey, pageToken) {
  const body = { textQuery, pageSize: 20 };
  if (pageToken) body.pageToken = pageToken;
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
