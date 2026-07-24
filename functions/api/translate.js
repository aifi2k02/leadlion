import { resolveAccess, spendAiCredits, aiRemaining, AI_COST } from '../_lib/accounts.js';

// POST /api/translate { texts: [..], to: 'urdu', code }
//
// Translates client-facing copy (outreach drafts, report findings) into ~100
// languages via Cloudflare Workers AI (m2m100) — free, already-bound, no new key.
// Every (language, text) result is CACHED in KV, so a given string is translated
// once ever and reused across every lead and report. Fails SOFT: on any error, or
// no AI binding, the original English is returned — a translation feature must
// never break the thing it's translating.
//
// We translate COPY only; the client sends just the sentences, never business
// names, numbers or the agency's branding.

const MODEL = '@cf/meta/m2m100-1.2b';
const CACHE_PREFIX = 'tr:';
const CACHE_TTL = 60 * 60 * 24 * 60; // 60 days
const MAX_TEXTS = 40;
const CONCURRENCY = 5;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const to = String(body.to || '').trim().toLowerCase();
  const texts = Array.isArray(body.texts) ? body.texts.slice(0, MAX_TEXTS).map((t) => String(t == null ? '' : t)) : [];
  if (!to || !texts.length) return json({ error: 'to and texts are required' }, 400);

  const kv = context.env.REPORTS;
  const ai = context.env.AI || null;
  const code = (body.code || '').trim();

  let account = null;
  if (code) {
    const access = await resolveAccess(context, code);
    if (!access.ok) return json({ error: access.error }, access.status);
    account = access.account;
  }
  if (account && !(await spendAiCredits(kv, account, AI_COST.copy))) {
    return json({ error: `Out of AI credits (${aiRemaining(account)} left).`, outOfCredits: true }, 402);
  }

  // No AI binding → hand back the originals so the caller degrades gracefully.
  if (!ai) return json({ ok: true, translations: texts, untranslated: true });

  const translations = await mapLimit(texts, CONCURRENCY, async (t) => {
    const clean = String(t).trim();
    if (!clean) return t;
    let key;
    if (kv) {
      key = CACHE_PREFIX + to + ':' + (await sha(clean));
      const hit = await kv.get(key);
      if (hit != null) return hit;
    }
    try {
      const out = await ai.run(MODEL, { text: clean, source_lang: 'english', target_lang: to });
      const tr = (out?.translated_text || '').trim() || t;
      if (kv && key && tr && tr !== t) context.waitUntil(kv.put(key, tr, { expirationTtl: CACHE_TTL }));
      return tr;
    } catch {
      return t; // fail soft — keep the English
    }
  });

  return json({ ok: true, translations, ...(account ? { aiRemaining: aiRemaining(account) } : {}) });
}
