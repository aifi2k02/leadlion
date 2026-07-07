import { runPageSpeed } from '../_lib/pagespeed.js';

// POST /api/pagespeed  { url }
// Runs Google Lighthouse (mobile) against the URL. Slow (~10-30s) by nature.

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const url = (body.url || '').trim();
  if (!url) return json({ error: 'url is required' }, 400);

  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    if (!['http:', 'https:'].includes(u.protocol) || u.hostname === 'localhost' || /^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname)) {
      return json({ error: 'URL not allowed' }, 400);
    }
  } catch {
    return json({ error: 'Invalid URL' }, 400);
  }

  // Prefer a dedicated PageSpeed key; else reuse the Places key (works once the
  // user enables PageSpeed Insights API + adds it to that key's restrictions).
  const key = context.env.PAGESPEED_API_KEY || context.env.GOOGLE_PLACES_API_KEY;
  const result = await runPageSpeed(url, key);
  return json(result, result.ok ? 200 : 502);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
