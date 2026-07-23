import { resolveAccess, spendAiCredits, aiRemaining, AI_COST } from '../_lib/accounts.js';
import { writeColdEmail, writeGbpDescription } from '../_lib/copy.js';

// POST /api/copy
//   { action: 'coldEmail',      lead:{name,category,location,hasWebsite,topIssues}, service, agency, code }
//   { action: 'gbpDescription', lead:{name,category,location}, service, code }
//
// AI sales copy from the audit findings the client already has — no Google call,
// so it only ever spends a Workers AI credit (like review-reply drafting). Demo
// tier (no code) gets the deterministic template so anonymous use never burns the
// shared neuron pool. AI is never load-bearing: a template is returned on failure.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function sanitizeLead(raw) {
  const l = raw && typeof raw === 'object' ? raw : {};
  const issues = Array.isArray(l.topIssues) ? l.topIssues : [];
  return {
    name: String(l.name || '').slice(0, 160),
    category: String(l.category || '').slice(0, 120),
    location: String(l.location || '').slice(0, 160),
    hasWebsite: !!l.hasWebsite,
    topIssues: issues.slice(0, 6).map((i) => ({ text: String(i?.text || '').slice(0, 240) })).filter((i) => i.text),
  };
}

function sanitizeAgency(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return {
    name: String(a.name || '').slice(0, 120),
    phone: String(a.phone || '').slice(0, 60),
    email: String(a.email || '').slice(0, 120),
  };
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const action = body.action === 'gbpDescription' ? 'gbpDescription' : 'coldEmail';
  const lead = sanitizeLead(body.lead);
  const service = String(body.service || '').slice(0, 80) || null;
  const agency = sanitizeAgency(body.agency);
  const code = (body.code || '').trim();
  const kv = context.env.REPORTS;
  const ai = context.env.AI || null;

  const run = () => action === 'gbpDescription'
    ? writeGbpDescription({ ai, lead, service })
    : writeColdEmail({ ai, lead, service, agency });

  // Demo (no code): template only, never spends AI.
  if (!code) {
    const r = await (action === 'gbpDescription'
      ? writeGbpDescription({ ai: null, lead, service })
      : writeColdEmail({ ai: null, lead, service, agency }));
    return json({ ...r, demo: true });
  }

  const access = await resolveAccess(context, code);
  if (!access.ok) return json({ error: access.error }, access.status);
  const { account } = access;

  if (account && !(await spendAiCredits(kv, account, AI_COST.copy))) {
    return json({
      error: `Out of AI credits (${aiRemaining(account)} left). Top up to keep generating copy.`,
      outOfCredits: true,
    }, 402);
  }

  const result = await run();
  return json({ ...result, aiRemaining: account ? aiRemaining(account) : null });
}
