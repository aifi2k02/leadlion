// Hosted report publish + stats. Backed by Cloudflare KV (binding: REPORTS).
//
//   POST /api/report        { report: {...} }  -> { id, url }
//   GET  /api/report?id=xxx                     -> { id, views, first, last, log }
//
// Requires a KV namespace bound as REPORTS in the Pages project settings.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function noKv() {
  return json({ error: 'Hosted reports need a one-time setup: bind a KV namespace named REPORTS in Cloudflare Pages → Settings → Functions.' }, 501);
}

// short url-safe id
function makeId() {
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return uuid.slice(0, 10);
}

export async function onRequestPost(context) {
  const kv = context.env.REPORTS;
  if (!kv) return noKv();

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const report = body.report;
  if (!report || !report.name) return json({ error: 'report data required' }, 400);

  // Report sharing requires an account whose plan allows it (blocks trial/demo).
  const code = (body.code || '').trim();
  const isOwner = !!(context.env.ADMIN_PASSWORD && code === context.env.ADMIN_PASSWORD);
  if (!isOwner) {
    const { getAccount, isExpired } = await import('../_lib/accounts.js');
    const acct = code ? await getAccount(kv, code) : null;
    if (!acct || !acct.active || isExpired(acct) || !acct.features?.share) {
      return json({ error: 'Report sharing is not available on your plan.' }, 403);
    }
  }

  // Reuse an existing id when re-publishing the same lead, so the link is stable
  // and view history is preserved.
  const id = (typeof body.id === 'string' && /^[a-z0-9]{6,16}$/.test(body.id)) ? body.id : makeId();

  const stored = { ...report, createdAt: report.createdAt || new Date().toISOString(), publishedAt: new Date().toISOString() };
  await kv.put(`report:${id}`, JSON.stringify(stored));

  const origin = new URL(context.request.url).origin;
  return json({ id, url: `${origin}/r/${id}` });
}

export async function onRequestGet(context) {
  const kv = context.env.REPORTS;
  if (!kv) return noKv();

  const id = new URL(context.request.url).searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const raw = await kv.get(`views:${id}`);
  const v = raw ? JSON.parse(raw) : { count: 0, first: null, last: null, log: [] };
  return json({ id, views: v.count, first: v.first, last: v.last, log: v.log || [] });
}
