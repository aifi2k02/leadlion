import { resolveAccess } from '../_lib/accounts.js';

// Demo-site publish + view stats. Stores a Stitch-designed HTML page in KV and
// serves it at /site/<id> as a shareable preview.
//
//   POST /api/site   { html, name, code, id? }  -> { id, url }
//   GET  /api/site?id=xxx                        -> { id, views, first, last }
//
// The HTML is stored verbatim (it's the agency's own Stitch export). Publishing
// is a share-capable feature (owner/full); trials/demo are blocked, same as
// hosted reports. No Google/AI cost — this is pure storage + serving.

const PREFIX = 'site:';
const MAX_HTML = 400_000; // a generous cap for a single-page site

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

export async function onRequestPost(context) {
  const kv = context.env.REPORTS;
  if (!kv) return json({ error: 'Hosting needs a KV namespace named REPORTS bound in Cloudflare Pages.' }, 501);

  let body;
  try { body = await context.request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const access = await resolveAccess(context, (body.code || '').trim());
  if (!access.ok) return json({ error: access.error }, access.status);
  // Publishing a hosted site is a full-plan feature (like sharing a report).
  if (!access.isOwner && !access.account?.features?.share) {
    return json({ error: 'Publishing demo sites is not available on your plan.' }, 403);
  }

  const htmlBody = String(body.html || '');
  if (!htmlBody.trim()) return json({ error: 'No HTML to publish.' }, 400);
  if (htmlBody.length > MAX_HTML) return json({ error: `Site is too large (${Math.round(htmlBody.length / 1000)} KB, max ${MAX_HTML / 1000} KB).` }, 413);
  if (!/<html[\s>]/i.test(htmlBody) && !/<body[\s>]/i.test(htmlBody)) {
    return json({ error: 'That does not look like a full HTML page — paste the complete Stitch export.' }, 400);
  }

  // Reuse an existing id when re-publishing the same lead, so the link is stable.
  const id = (typeof body.id === 'string' && /^[a-z0-9]{6,16}$/.test(body.id)) ? body.id : makeId();
  const record = {
    html: htmlBody,
    name: String(body.name || '').slice(0, 160),
    publishedAt: new Date().toISOString(),
  };
  await kv.put(PREFIX + id, JSON.stringify(record));

  const origin = new URL(context.request.url).origin;
  return json({ id, url: `${origin}/site/${id}` });
}

export async function onRequestGet(context) {
  const kv = context.env.REPORTS;
  if (!kv) return json({ error: 'Not configured' }, 501);
  const id = new URL(context.request.url).searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);
  const raw = await kv.get(`siteviews:${id}`);
  const v = raw ? JSON.parse(raw) : { count: 0, first: null, last: null };
  return json({ id, views: v.count, first: v.first, last: v.last });
}
