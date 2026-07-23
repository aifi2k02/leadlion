import { resolveKey, getAccount, isExpired } from '../_lib/accounts.js';

// POST /api/autocomplete { input, sessionToken?, code, googleKey? }
//
// City autocomplete for the search box. Proxies Google Places Autocomplete (New)
// so the server key is never exposed to the browser. Returns pre-disambiguated
// place descriptions ("Hyderabad, Pakistan" vs "Hyderabad, Telangana, India"), so
// picking one gives the existing search paths an unambiguous, correctly-spelled
// location string to geocode — no typos, no "which Hyderabad?" guessing.
//
// Deliberately NOT metered against the credit ledger: keystroke requests are kept
// cheap by the client (min length + debounce) and grouped by a session token so
// Google bills them as one session. Requires a live-capable account (demo/no key
// returns no suggestions). Rate limiting is a separate hardening item.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// City/region types only — we don't want businesses in a location box. If Google
// rejects the type filter (some combinations/regions do), we retry unfiltered.
const CITY_TYPES = ['locality', 'administrative_area_level_3', 'administrative_area_level_1', 'country'];

async function placesAutocomplete(input, sessionToken, apiKey) {
  const call = async (withTypes) => {
    const reqBody = { input };
    if (sessionToken) reqBody.sessionToken = sessionToken;
    if (withTypes) reqBody.includedPrimaryTypes = CITY_TYPES;
    return fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(6000),
    });
  };
  let res = await call(true);
  if (!res.ok) res = await call(false);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({
      placeId: p.placeId || '',
      description: p.text?.text || '',
      main: p.structuredFormat?.mainText?.text || p.text?.text || '',
      secondary: p.structuredFormat?.secondaryText?.text || '',
    }))
    .filter((x) => x.description)
    .slice(0, 6);
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const input = (body.input || '').trim();
  if (input.length < 2) return json({ suggestions: [] });

  const code = (body.code || '').trim();
  const kv = context.env.REPORTS;
  const isOwner = !!(context.env.ADMIN_PASSWORD && code === context.env.ADMIN_PASSWORD);
  let account = null;
  if (!isOwner && code && kv) {
    account = await getAccount(kv, code);
    if (!account || !account.active) return json({ error: 'Invalid or deactivated access code.' }, 401);
    if (isExpired(account)) return json({ error: 'This trial has expired.' }, 403);
  }

  const { key } = resolveKey(context, body);
  const ownerKey = isOwner ? (key || (body.apiKey || '').trim()) : key;
  // Demo / no key: no live suggestions (the box still accepts free text).
  if (!((isOwner || account) && ownerKey)) return json({ suggestions: [] });

  try {
    const suggestions = await placesAutocomplete(input, (body.sessionToken || '').trim(), ownerKey);
    return json({ suggestions });
  } catch {
    return json({ suggestions: [] });
  }
}
