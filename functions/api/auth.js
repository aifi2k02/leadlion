import { getAccount, isExpired, profileOf, fullProfile } from '../_lib/accounts.js';

// POST /api/auth { code } -> validates an access code, returns its profile.
// The admin password doubles as the owner's full-access login.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));
  const code = (body.code || '').trim();
  if (!code) return json({ error: 'Enter an access code' }, 400);

  // Owner login via the admin password
  if (context.env.ADMIN_PASSWORD && code === context.env.ADMIN_PASSWORD) {
    return json({ ok: true, profile: fullProfile() });
  }

  const kv = context.env.REPORTS;
  if (!kv) return json({ error: 'Accounts are not configured yet.' }, 501);

  const a = await getAccount(kv, code);
  if (!a || !a.active) return json({ error: 'Invalid or deactivated access code.' }, 401);
  if (isExpired(a)) return json({ error: 'This trial has expired.' }, 403);

  return json({ ok: true, profile: profileOf(a) });
}
