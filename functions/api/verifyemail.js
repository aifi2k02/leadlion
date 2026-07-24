import { resolveAccess } from '../_lib/accounts.js';

// POST /api/verifyemail { email, code }
//
// Checks whether an address is worth sending to, using DNS-over-HTTPS (free —
// no Google call, nothing metered). We verify the DOMAIN's mail setup, NOT the
// individual mailbox: SMTP mailbox probing is unreliable, gets you blocklisted,
// and most servers accept-then-bounce. So we report exactly what we checked and
// never claim an address "exists" — same honesty rule as the rest of the app.
//
//   deliverable   — domain publishes MX records (it accepts mail)
//   risky         — no MX but an A record exists (some hosts still accept; may bounce)
//   undeliverable — domain resolves to nothing that can take mail
//   invalid       — not a valid address shape

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

async function dns(name, type) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const email = String(body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();
  if (code) {
    const access = await resolveAccess(context, code);
    if (!access.ok) return json({ error: access.error }, access.status);
  }

  const m = /^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(email);
  if (!m) return json({ ok: true, status: 'invalid', label: 'Not a valid address' });
  const domain = m[1];

  const mx = await dns(domain, 'MX');
  if (mx === null) return json({ ok: false, status: 'unknown', label: 'Could not check right now' });
  const hasMx = (mx.Answer || []).some((a) => a.type === 15);
  if (hasMx) return json({ ok: true, status: 'deliverable', domain, label: 'Domain accepts mail' });

  const a = await dns(domain, 'A');
  const hasA = (a?.Answer || []).some((r) => r.type === 1);
  return hasA
    ? json({ ok: true, status: 'risky', domain, label: 'No mail server — may bounce' })
    : json({ ok: true, status: 'undeliverable', domain, label: "Domain can't receive mail" });
}
