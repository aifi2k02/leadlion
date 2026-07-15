import { isPlausibleGoogleKey } from '../_lib/accounts.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST /api/testkey { googleKey }
//
// Makes ONE live Places call with the user's OWN key — and never falls back to
// ours (unlike resolveKey). This is the whole point: confirm BYOK actually works
// before the customer relies on it, and surface the two silent failure modes —
// a malformed key (which would quietly bill OUR budget) and a well-shaped but
// Google-rejected key (which fails mid-search with an opaque error).
//
// The key is used once and never stored, same contract as every other endpoint.
export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ status: 'error', message: 'Invalid JSON body.' }, 400);
  }
  const key = (body?.googleKey || '').trim();
  if (!key) return json({ status: 'empty', message: 'Enter a key first.' });

  // Shape check mirrors resolveKey: a key that fails this would be IGNORED by the
  // server and searches would silently run on our key instead.
  if (!isPlausibleGoogleKey(key)) {
    return json({
      status: 'invalid-format',
      message: 'That doesn’t look like a Google API key (they start with “AIza…”). Searches would fall back to our key, not yours — double-check what you pasted.',
    });
  }

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName',
      },
      body: JSON.stringify({ textQuery: 'coffee shop', maxResultCount: 1 }),
    });
    if (res.ok) {
      return json({ status: 'ok', message: 'Working — ran a live search on your key. You’re all set.' });
    }
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || '';
    } catch { /* non-JSON error body */ }
    return json({
      status: 'rejected',
      code: res.status,
      message: `Google rejected the key${detail ? ` — ${detail}` : '.'} Check that Places API (New) is enabled on the project and the key isn’t restricted to a website (Application restrictions must be None).`,
    });
  } catch (e) {
    return json({ status: 'error', message: `Couldn’t reach Google: ${e.message || 'network error'}. Try again.` });
  }
}
