// Public shareable report:  GET /r/<id>
// Renders the stored report server-side and logs the view (unless ?p=1, which
// the agency uses to preview its own report without inflating the count).

import { renderReportPage } from '../_lib/reportPage.js';

export async function onRequestGet(context) {
  const kv = context.env.REPORTS;
  const id = context.params.id;

  if (!kv) {
    return html('<h1>Reports not configured</h1><p>Bind a KV namespace named REPORTS in Cloudflare Pages settings.</p>', 501);
  }

  const raw = await kv.get(`report:${id}`);
  if (!raw) {
    return html('<h1>Report not found</h1><p>This link may have expired or is incorrect.</p>', 404);
  }

  const data = JSON.parse(raw);

  // Log the view unless it's the agency previewing (?p=1)
  const isPreview = new URL(context.request.url).searchParams.get('p') === '1';
  if (!isPreview) {
    context.waitUntil(logView(kv, id, context.request));
  }

  return html(renderReportPage(data), 200);
}

async function logView(kv, id, request) {
  try {
    const raw = await kv.get(`views:${id}`);
    const v = raw ? JSON.parse(raw) : { count: 0, first: null, last: null, log: [] };
    const now = new Date().toISOString();
    v.count += 1;
    v.first = v.first || now;
    v.last = now;
    v.log = [...(v.log || []), { at: now, ua: (request.headers.get('user-agent') || '').slice(0, 80) }].slice(-30);
    await kv.put(`views:${id}`, JSON.stringify(v));
  } catch {
    /* tracking is best-effort; never breaks the report */
  }
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', // ensure every open is counted
    },
  });
}
