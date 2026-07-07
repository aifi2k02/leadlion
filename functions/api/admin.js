import { newTrial, putAccount, getAccount, delAccount, listAccounts } from '../_lib/accounts.js';

// POST /api/admin { password, action, ... } — password-gated account management.
// actions: list | create | revoke | reset | delete

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));

  if (!context.env.ADMIN_PASSWORD) {
    return json({ error: 'Admin is not set up. Add an ADMIN_PASSWORD secret in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.' }, 501);
  }
  if (body.password !== context.env.ADMIN_PASSWORD) {
    return json({ error: 'Wrong admin password.' }, 401);
  }

  const kv = context.env.REPORTS;
  if (!kv) return json({ error: 'KV namespace REPORTS is not bound.' }, 501);

  switch (body.action) {
    case 'list': {
      const accounts = await listAccounts(kv);
      accounts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return json({ accounts });
    }
    case 'create': {
      const a = newTrial({ label: body.label, searches: body.searches, results: body.results, days: body.days });
      await putAccount(kv, a);
      return json({ account: a });
    }
    case 'revoke': {
      const a = await getAccount(kv, body.code);
      if (!a) return json({ error: 'Account not found' }, 404);
      a.active = !a.active;
      await putAccount(kv, a);
      return json({ account: a });
    }
    case 'reset': {
      const a = await getAccount(kv, body.code);
      if (!a) return json({ error: 'Account not found' }, 404);
      a.searchesUsed = 0;
      await putAccount(kv, a);
      return json({ account: a });
    }
    case 'delete': {
      await delAccount(kv, body.code);
      return json({ ok: true });
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
}
