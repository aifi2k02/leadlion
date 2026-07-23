import { scoreBusiness } from '../_lib/scoring.js';
import { demoSearch } from '../_lib/demo.js';
import {
  getAccount, isExpired, putAccount, resolveKey,
  reserveApiCalls, refundApiCalls, apiRemaining, COST,
} from '../_lib/accounts.js';
import { googleSearch, geocodeCity, cityLabel } from '../_lib/places.js';

// POST /api/search { keyword, location, code, googleKey? }
//
// Handles the single-request paths only: demo data, and the 'fast' (top-60)
// live search. Deep/exhaustive searches are driven by the browser via
// /api/plan + /api/zones, because Cloudflare caps a Worker invocation at 50
// outbound subrequests and a full quadtree needs hundreds.
//
// Cost: up to 3 Google calls (3 pages x 20 results), 1 if the trial cap applies.
// We reserve the upper bound BEFORE calling Google and refund the unused pages.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

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

  const code = (body.code || '').trim();
  const kv = context.env.REPORTS;

  // --- Resolve access tier (server-enforced) -------------------------------
  const isOwner = !!(context.env.ADMIN_PASSWORD && code === context.env.ADMIN_PASSWORD);
  let account = null;
  if (!isOwner && code && kv) {
    account = await getAccount(kv, code);
    if (!account || !account.active) return json({ error: 'Invalid or deactivated access code.' }, 401);
    if (isExpired(account)) return json({ error: 'This trial has expired.' }, 403);
  }

  // --- Whose key, and therefore whose bill? --------------------------------
  // BYOK: the customer's key means the customer pays Google. We don't meter it.
  const { key: resolvedKey, byok } = resolveKey(context, body);
  const ownerKey = isOwner ? (resolvedKey || (body.apiKey || '').trim()) : resolvedKey;
  const canLive = (isOwner || account) && ownerKey;

  let resultCap = null;
  if (account && account.type === 'trial') {
    // Trial limits: enforced here, not on the client.
    if ((account.searchesUsed || 0) >= account.searchLimit) {
      return json({ error: 'Trial search limit reached.', limitReached: true }, 403);
    }
    resultCap = account.resultCap || 20;
  }

  let businesses;
  let mode;
  let meta = {};
  let cityName = location; // canonical city stamped on leads (set by geocode below)
  if (canLive) {
    // 'Quick' = a 1-page scout (≤20 results, 1 Google call) for full users too,
    // not just trials. Cheaper and faster than Fast's 3 pages.
    const quick = body.quick === true;
    const cap = resultCap != null ? resultCap : (quick ? 20 : null);
    const maxPages = (resultCap != null || quick) ? 1 : 3;
    // +COST.geocode: we also geocode the term so the lead stores the real city
    // ("Los Angls" -> "Los Angeles"), not the raw typed string.
    const estimate = maxPages * COST.searchPage + COST.geocode;
    const metered = !!(account && !byok); // only our key, on a capped account

    if (metered && !(await reserveApiCalls(kv, account, estimate))) {
      return json({
        error: `Out of API credits (${apiRemaining(account)} left, this search needs ${estimate}). Add your own Google API key in Settings for unlimited searches.`,
        outOfCredits: true,
      }, 402);
    }

    let calls = estimate;
    try {
      const res = await googleSearch(keyword, location, ownerKey, maxPages, cap);
      businesses = res.places;
      calls = res.calls;
      // Resolve the mistyped/loose term to a canonical city for stamping on leads.
      // Best-effort: a geocode failure just leaves the typed string in place.
      try {
        const geo = await geocodeCity(location, ownerKey);
        if (geo) cityName = cityLabel(geo, location);
      } catch { /* keep typed city; the reserved geocode credits stay spent (conservative) */ }
    } catch (err) {
      // Google search failed before we geocoded — hand back everything we reserved.
      if (metered) await refundApiCalls(kv, account, estimate);
      return json({ error: `Google Places error: ${err.message}` }, 502);
    }
    mode = 'live';

    // Refund the search pages we reserved but never fetched; the geocode credit is
    // always treated as spent (it ran, or we keep it reserved on failure).
    const usedCredits = calls * COST.searchPage + COST.geocode;
    if (metered && usedCredits < estimate) await refundApiCalls(kv, account, estimate - usedCredits);
    // Report search-page calls only. The geocode (~1 call) is intentionally not added
    // to the informational browser tally, matching the deep-search convention.
    meta.apiCalls = calls;
    meta.resolvedCity = cityName;
    meta.byok = byok;

    // Consume one trial search after a successful live search.
    if (account && account.type === 'trial') {
      account.searchesUsed = (account.searchesUsed || 0) + 1;
      await putAccount(kv, account);
      meta.trial = {
        used: account.searchesUsed,
        limit: account.searchLimit,
        remaining: Math.max(0, account.searchLimit - account.searchesUsed),
      };
    }
    if (account) meta.apiRemaining = account.apiBudget === null ? null : apiRemaining(account);
  } else {
    businesses = demoSearch(keyword, location);
    mode = 'demo';
  }

  const results = businesses
    .map((b) => ({ ...b, ...scoreBusiness(b), keyword, location: cityName, foundAt: new Date().toISOString() }))
    .sort((a, b) => b.opportunityScore - a.opportunityScore);

  return json({ mode, count: results.length, ...meta, results });
}
