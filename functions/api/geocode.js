import {
  getAccount, isExpired, resolveKey,
  reserveApiCalls, refundApiCalls, apiRemaining, COST,
} from '../_lib/accounts.js';
import { geocodeCity, cityLabel } from '../_lib/places.js';

// POST /api/geocode { location, code, googleKey? }
//
// Resolves one location string to its canonical "City, Country" — used by the
// "Fix locations" cleanup to backfill older leads that were saved before the
// canonical-city change (bare "Riyadh", typo'd "Los Angls"). One geocode per
// unique location, metered like any geocode on our key; free under BYOK.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }
  const location = (body.location || '').trim();
  if (!location) return json({ ok: false, error: 'location is required' }, 400);

  const code = (body.code || '').trim();
  const kv = context.env.REPORTS;
  const isOwner = !!(context.env.ADMIN_PASSWORD && code === context.env.ADMIN_PASSWORD);
  let account = null;
  if (!isOwner && code && kv) {
    account = await getAccount(kv, code);
    if (!account || !account.active) return json({ ok: false, error: 'Invalid or deactivated access code.' }, 401);
    if (isExpired(account)) return json({ ok: false, error: 'This trial has expired.' }, 403);
  }

  const { key, byok } = resolveKey(context, body);
  const ownerKey = isOwner ? (key || (body.apiKey || '').trim()) : key;
  if (!((isOwner || account) && ownerKey)) return json({ ok: false, error: 'No usable API key.' }, 200);

  const metered = !!(account && !byok);
  if (metered && !(await reserveApiCalls(kv, account, COST.geocode))) {
    return json({ ok: false, outOfCredits: true, error: `Out of API credits (${apiRemaining(account)} left).` }, 402);
  }

  let geo;
  try {
    geo = await geocodeCity(location, ownerKey);
  } catch {
    if (metered) await refundApiCalls(kv, account, COST.geocode);
    return json({ ok: false, resolved: false });
  }
  // Unresolved (zero results): a call was still made, so the reservation stays spent.
  if (!geo) return json({ ok: false, resolved: false, ...(account ? { apiRemaining: apiRemaining(account) } : {}) });

  return json({
    ok: true,
    label: cityLabel(geo, location),
    level: geo.level || 'city',
    ...(account ? { apiRemaining: account.apiBudget === null ? null : apiRemaining(account) } : {}),
  });
}
