import { fetchPage } from '../_lib/places.js';
import {
  getAccount, isExpired, resolveKey,
  reserveApiCalls, refundApiCalls, apiRemaining, COST,
} from '../_lib/accounts.js';

// POST /api/rank { keyword, placeId, location?, lat?, lng?, code, googleKey? }
//
// Approximate local rank for one business: search the keyword near it and report
// where its placeId lands in Google's ordered results (and whether that's in the
// top-3 map "3-pack"). ONE Places call — cheap. It is deliberately labelled
// approximate in the UI, because Google personalises local results by the
// searcher's exact position, so a single point isn't the whole picture (a grid
// scan would be — that's a separate, pricier feature). Same honesty rule as the
// rest of the app: we report what we actually measured, not a claimed true rank.

const SCAN = 20; // one page of results — rank up to 20, else "not in the top 20"

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
  const keyword = (body.keyword || '').trim();
  const placeId = (body.placeId || '').trim();
  const location = (body.location || '').trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);
  if (!keyword || !placeId) return json({ ok: false, error: 'keyword and placeId are required' }, 400);
  if (!hasPoint && !location) return json({ ok: false, error: 'need a location or lat/lng' }, 400);

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
  if (metered && !(await reserveApiCalls(kv, account, COST.searchPage))) {
    return json({ ok: false, outOfCredits: true, error: `Out of API credits (${apiRemaining(account)} left).` }, 402);
  }

  // Bias to a ~6km box around the business when we have its coordinates (the most
  // faithful "rank as seen near them"); otherwise fall back to "keyword in city".
  let textQuery = keyword;
  let rectangle = null;
  if (hasPoint) {
    const d = 0.06;
    rectangle = { low: { latitude: lat - d, longitude: lng - d }, high: { latitude: lat + d, longitude: lng + d } };
  } else {
    textQuery = `${keyword} in ${location}`;
  }

  let data;
  try {
    data = await fetchPage(textQuery, ownerKey, null, rectangle);
  } catch (err) {
    if (metered) await refundApiCalls(kv, account, COST.searchPage);
    return json({ ok: false, error: `Google rejected the rank search: ${err.message}` }, 502);
  }

  const places = (data.places || []).slice(0, SCAN);
  const idx = places.findIndex((p) => p.id === placeId);
  const rank = idx === -1 ? null : idx + 1;

  return json({
    ok: true,
    rank,                                 // null = not found in the top `scanned`
    inThreePack: rank !== null && rank <= 3,
    scanned: places.length,
    scanDepth: SCAN,
    keyword,
    biased: hasPoint,                     // true = coord-biased, false = city text search
    checkedAt: new Date().toISOString(),
    byok,
    ...(account ? { apiRemaining: account.apiBudget === null ? null : apiRemaining(account) } : {}),
  });
}
