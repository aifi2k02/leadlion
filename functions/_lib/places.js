// Shared Google Places helpers.
//
// IMPORTANT: Cloudflare Workers cap outbound subrequests per invocation
// (50 on the free plan, measured). Anything that needs more than ~45 Google
// calls MUST be split across multiple HTTP requests — see /api/plan + /api/zones,
// which the browser drives as a quadtree.

export const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.businessStatus',
  'places.photos',
  'places.regularOpeningHours',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
  'places.editorialSummary',
  'places.location',
  'nextPageToken',
].join(',');

// Google returns at most 60 results (3 pages) per query. Hitting 60 means the
// zone is SATURATED — there is more inside it than we can see.
export const ZONE_CAP = 60;

// Max zones per HTTP request: 15 zones x 3 pages = 45 subrequests, under the 50 cap.
export const MAX_ZONES_PER_REQUEST = 15;

// Quadtree tuning per depth mode. `budget` is a ceiling on total Google calls
// for the whole search (enforced by the client orchestrator).
export const DEPTH = {
  deep:       { rootN: 2, maxDepth: 5, budget: 450,  minSpan: 0.006 },
  exhaustive: { rootN: 2, maxDepth: 7, budget: 1200, minSpan: 0.003 },
};

export function mapPlace(p) {
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
    phoneIntl: p.internationalPhoneNumber || null,
    photoCount: (p.photos || []).length,
    hasHours: !!p.regularOpeningHours,
    // Places API doesn't expose claimed status; heuristic: no website, no
    // hours and <3 photos usually means an auto-generated unclaimed listing.
    claimed: !(!p.websiteUri && !p.regularOpeningHours && (p.photos || []).length < 3),
    description: p.editorialSummary?.text || null,
    businessStatus: p.businessStatus || 'OPERATIONAL',
    mapsUrl: p.googleMapsUri || null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
  };
}

export async function fetchPage(textQuery, apiKey, pageToken, rectangle) {
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

// Plain city-wide search, up to 60 results. Used for 'fast' depth and as the
// fallback when a location can't be resolved to a real place.
export async function googleSearch(keyword, location, apiKey, maxPages = 3, cap = null) {
  const textQuery = `${keyword} in ${location}`;
  const seen = new Set();
  const out = [];
  let pageToken = null;

  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await fetchPage(textQuery, apiKey, pageToken);
    } catch (err) {
      if (page === 0) throw err;
      break;
    }
    for (const p of data.places || []) {
      if (p.id && !seen.has(p.id)) { seen.add(p.id); out.push(mapPlace(p)); }
    }
    if (cap && out.length >= cap) return out.slice(0, cap);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    // Places API (New) validates nextPageToken immediately — no delay needed.
  }
  return cap ? out.slice(0, cap) : out;
}

// Search a single zone (strict rectangle), paginating to the 60-result ceiling.
export async function fetchZone(keyword, rectangle, apiKey, maxPages = 3) {
  const out = [];
  let token = null;
  let calls = 0;
  for (let p = 0; p < maxPages; p++) {
    let data;
    try {
      calls++;
      data = await fetchPage(keyword, apiKey, token, rectangle);
    } catch {
      break;
    }
    for (const place of data.places || []) out.push(mapPlace(place));
    token = data.nextPageToken;
    if (!token) break;
  }
  return { places: out, calls, saturated: out.length >= ZONE_CAP };
}

export function splitRect(r) {
  const midLat = (r.low.latitude + r.high.latitude) / 2;
  const midLng = (r.low.longitude + r.high.longitude) / 2;
  return [
    { low: { latitude: r.low.latitude, longitude: r.low.longitude }, high: { latitude: midLat, longitude: midLng } },
    { low: { latitude: r.low.latitude, longitude: midLng }, high: { latitude: midLat, longitude: r.high.longitude } },
    { low: { latitude: midLat, longitude: r.low.longitude }, high: { latitude: r.high.latitude, longitude: midLng } },
    { low: { latitude: midLat, longitude: midLng }, high: { latitude: r.high.latitude, longitude: r.high.longitude } },
  ];
}

export function rectSpan(r) {
  return Math.max(r.high.latitude - r.low.latitude, r.high.longitude - r.low.longitude);
}

// --- City resolution -------------------------------------------------------
// Place types ranked from "city-level or bigger" down to "neighbourhood".
// Bare 'political' is excluded — neighbourhoods carry it too, which is how
// "São Paulo" used to resolve to the Bela Vista district.
const GEO_TIERS = [
  ['locality', 'postal_town'],
  ['administrative_area_level_3', 'administrative_area_level_2', 'administrative_area_level_1'],
  ['country'],
  ['sublocality_level_1', 'sublocality', 'neighborhood'],
];

function viewportFromGeocoding(vp) {
  return {
    low: { latitude: vp.southwest.lat, longitude: vp.southwest.lng },
    high: { latitude: vp.northeast.lat, longitude: vp.northeast.lng },
  };
}

async function geocodeViaGeocodingApi(location, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.status === 'ZERO_RESULTS') return { ok: false, reason: 'zero' };
    if (data.status !== 'OK' || !data.results?.length) return { ok: false, reason: 'unavailable' };
    for (const tier of GEO_TIERS) {
      const hit = data.results.find((r) => (r.types || []).some((t) => tier.includes(t)) && r.geometry?.viewport);
      if (hit) {
        return {
          ok: true,
          geo: {
            viewport: viewportFromGeocoding(hit.geometry.viewport),
            name: hit.formatted_address,
            address: hit.formatted_address,
            level: tier.includes('sublocality') ? 'area' : 'city',
          },
        };
      }
    }
    return { ok: false, reason: 'zero' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

async function geocodeViaPlaces(location, apiKey) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.types,places.viewport',
    },
    body: JSON.stringify({ textQuery: location, pageSize: 20 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const places = (data.places || []).filter((p) => p.viewport?.low && p.viewport?.high);
  for (const tier of GEO_TIERS) {
    const hit = places.find((p) => (p.types || []).some((t) => tier.includes(t)));
    if (hit) {
      return {
        viewport: hit.viewport,
        name: hit.displayName?.text || location,
        address: hit.formattedAddress || '',
        level: tier.includes('sublocality') ? 'area' : 'city',
      };
    }
  }
  return null;
}

export async function geocodeCity(location, apiKey) {
  const g = await geocodeViaGeocodingApi(location, apiKey);
  if (g.ok) return g.geo;
  if (g.reason === 'zero') return null;
  return await geocodeViaPlaces(location, apiKey);
}
