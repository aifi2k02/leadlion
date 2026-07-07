import { auditWebsite } from '../_lib/webaudit.js';

// POST /api/webaudit  { url }
// Fetches the lead's website server-side and returns a scored audit.

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const url = (body.url || '').trim();
  if (!url) return json({ error: 'url is required' }, 400);

  // basic SSRF guard: only audit public http(s) hosts
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    const host = u.hostname;
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      host === 'localhost' ||
      /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return json({ error: 'URL not allowed' }, 400);
    }
  } catch {
    return json({ error: 'Invalid URL' }, 400);
  }

  const result = await auditWebsite(url);
  return json(result);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
