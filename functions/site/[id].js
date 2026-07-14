// Public shareable demo site:  GET /site/<id>
//
// The stored HTML is the agency's Stitch export — untrusted from our app's point
// of view. Serving it raw on our origin would let its scripts read our app's
// localStorage (session codes, the BYOK Google key). So we serve it INSIDE a
// sandboxed iframe (allow-scripts, but NOT allow-same-origin) which gives the
// page an opaque origin, isolated from leadlion.pages.dev. Tailwind CDN, Google
// Fonts, and its own scripts still run — they just can't touch our data.

const PREFIX = 'site:';

export async function onRequestGet(context) {
  const kv = context.env.REPORTS;
  const id = context.params.id;
  if (!kv) return html('<h1>Hosting not configured</h1>', 501);

  const raw = await kv.get(PREFIX + id);
  if (!raw) return html('<h1>Site not found</h1><p>This preview link may have expired or is incorrect.</p>', 404);

  let record;
  try { record = JSON.parse(raw); } catch { return html('<h1>Site is corrupt</h1>', 500); }

  const isPreview = new URL(context.request.url).searchParams.get('p') === '1';
  if (!isPreview) context.waitUntil(logView(kv, id, context.request));

  // Escape the stored HTML for use inside the iframe srcdoc attribute.
  const srcdoc = String(record.html || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const title = (record.name || 'Website preview').replace(/[<>&"]/g, '');

  const wrapper = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>html,body{margin:0;padding:0;height:100%}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body>
<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" srcdoc="${srcdoc}" title="${title}"></iframe>
</body></html>`;

  return html(wrapper, 200);
}

async function logView(kv, id, request) {
  try {
    const raw = await kv.get(`siteviews:${id}`);
    const v = raw ? JSON.parse(raw) : { count: 0, first: null, last: null };
    const now = new Date().toISOString();
    v.count += 1;
    v.first = v.first || now;
    v.last = now;
    await kv.put(`siteviews:${id}`, JSON.stringify(v));
  } catch { /* best-effort */ }
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
