/* LeadLion — local business lead finder & audit tool.
   No build step. Storage: localStorage by default, Supabase when configured
   in Settings (table: leads — see schema.sql). */

// ---------------------------------------------------------------- settings
const SETTINGS_KEY = 'leadlion_settings';

function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(patch) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...getSettings(), ...patch }));
}

// --- Browser-only usage counter -------------------------------------------
// Lives ENTIRELY in this browser. Never sent to or recorded on our server.
// For BYOK users this is the whole picture: their searches bill their own
// Google account, so there is nothing for us to track and nothing to enforce.
// Call counts here are FACT — the server returns the real number of Google
// calls each search made. The dollar figure is a labelled ESTIMATE until the
// real per-SKU prices are pulled from Billing → Reports (LEARNINGS.md §9).
const USAGE_KEY = 'leadlion_usage';

// PLACEHOLDER RATES — rough order-of-magnitude, USD per Google call.
// Replace with the real SKU prices from Billing → Reports. The call *counts*
// are exact; only these multipliers are approximate, and the UI says so.
const EST_USD = {
  apiCall: 0.032,  // Places Text Search / Geocoding (per call)
  mine: 0.020,     // Place Details + reviews (Enterprise + Atmosphere, per call)
};

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getUsage() {
  let u;
  try { u = JSON.parse(localStorage.getItem(USAGE_KEY)); } catch { u = null; }
  if (!u || u.month !== thisMonth()) u = { month: thisMonth(), searches: 0, apiCalls: 0, mines: 0 };
  return u;
}

// Record a unit of usage locally. `apiCalls` is the real count from the server.
function recordUsage({ searches = 0, apiCalls = 0, mines = 0 } = {}) {
  const u = getUsage();
  u.searches += searches;
  u.apiCalls += apiCalls;
  u.mines += mines;
  localStorage.setItem(USAGE_KEY, JSON.stringify(u));
}

function estUsd(u) {
  return (u.apiCalls * EST_USD.apiCall) + (u.mines * EST_USD.mine);
}

// Settings card: this month's usage, computed entirely from the browser ledger.
// Nothing here is fetched from or stored on our server.
function usageCard() {
  const u = getUsage();
  const byok = hasByok();
  const monthName = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const est = estUsd(u);
  const totalCalls = u.apiCalls + u.mines;
  return `
    <div class="card mb">
      <h2 style="margin-top:0">${ic('barChart')} Your usage — ${esc(monthName)}</h2>
      <p class="muted" style="font-size:13.5px">
        ${byok
          ? 'These searches run on <b>your own</b> Google key and bill your Google account directly.'
          : 'A running tally of your activity this month.'}
        Counted <b>in this browser only</b> — LeadLion never records it.
      </p>
      <div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:6px">
        <div><div class="stat-num">${u.searches}</div><div class="stat-label">searches</div></div>
        <div><div class="stat-num">${totalCalls}</div><div class="stat-label">Google API calls</div></div>
        <div><div class="stat-num">~$${est.toFixed(2)}</div><div class="stat-label">est. Google cost</div></div>
      </div>
      <p class="muted" style="font-size:12px;margin-top:10px">
        Call counts are exact. The dollar figure is a <b>rough estimate</b> (${u.mines} review-mine call${u.mines === 1 ? '' : 's'} counted at the higher SKU) —
        check <a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener" style="color:var(--accent)">Google Billing</a> for the exact amount. Resets on the 1st.
      </p>
      <button class="btn-ghost btn-sm" id="s-usage-reset" style="margin-top:8px">Reset counter</button>
    </div>`;
}

// ---------------------------------------------------------------- session / access
const SESSION_KEY = 'leadlion_session';
let SESSION = null;

function loadSession() {
  try { SESSION = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { SESSION = null; }
  return SESSION;
}
function setSession(s) { SESSION = s; localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { SESSION = null; localStorage.removeItem(SESSION_KEY); }
function accessCode() { return SESSION?.code || undefined; }
function feat() { return SESSION?.profile?.features || { deep: false, download: false, share: false }; }
function isDemo() { return !SESSION || SESSION.profile?.type === 'demo'; }
function isTrial() { return SESSION?.profile?.type === 'trial'; }

// BYOK — the user's own Google API key. Deliberately stored in THIS BROWSER and
// sent with each request, never persisted on our servers: if we kept customer
// keys in KV, one breach would leak every customer's billable Google credential.
// When present, their searches bill their Google account, not ours.
function byokKey() { return (getSettings().googleApiKey || '').trim() || undefined; }
// Mirror the server's shape check (isPlausibleGoogleKey). A key that fails this is
// IGNORED server-side and searches silently fall back to OUR key — so treat it as
// "not connected" here too, or the badge/banner would promise BYOK we won't honour.
function looksLikeGoogleKey(k) { return /^AIza[0-9A-Za-z_\-]{20,60}$/.test((k || '').trim()); }
function hasByok() { return looksLikeGoogleKey(byokKey()); }

// First-run BYOK nudge — shown once, then never again whether they set a key or
// chose to explore first. Dismissing is a real answer, so we record it either way.
const BYOK_PROMPTED_KEY = 'leadlion_byok_prompted';
function byokPrompted() { return localStorage.getItem(BYOK_PROMPTED_KEY) === '1'; }
function markByokPrompted() { localStorage.setItem(BYOK_PROMPTED_KEY, '1'); }

const SUPA_PROMPTED_KEY = 'leadlion_supa_prompted';
function supaPrompted() { return localStorage.getItem(SUPA_PROMPTED_KEY) === '1'; }
function markSupaPrompted() { localStorage.setItem(SUPA_PROMPTED_KEY, '1'); }

// Every request that spends a Google API call goes through this.
function spendBody(extra) {
  return JSON.stringify({ ...extra, code: accessCode(), googleKey: byokKey() });
}

// Each session type gets its own lead store so a trial/demo never sees or
// touches the owner's pipeline. Supabase sync is owner-only.
function leadsKey() {
  const t = SESSION?.profile?.type;
  if (t === 'trial') return 'leadlion_leads__trial';
  if (t === 'demo') return 'leadlion_leads__demo';
  return 'leadlion_leads';
}
function dbActive() { return !!supabase && SESSION?.profile?.type === 'full'; }

// ---------------------------------------------------------------- storage
// Same interface for localStorage and Supabase so views don't care which.
const LEADS_KEY = 'leadlion_leads';
let supabase = null;
// Set only when Supabase is CONFIGURED BUT BROKEN. "Not configured" and "broken"
// both used to collapse into a quiet localStorage fallback, which is the same trap
// as the BYOK badge: the user believes their leads are synced when they aren't.
// Broken must be loud — see updateStorageBadge() + injectStorageWarning().
let supaError = null;

async function initSupabase() {
  const s = getSettings();
  supabase = null;
  supaError = null;
  if (!s.supabaseUrl || !s.supabaseKey) return false; // not configured — not an error
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    supabase = createClient(s.supabaseUrl, s.supabaseKey);
    // probe the table so we fail fast rather than at the first save
    const { error } = await supabase.from('leads').select('id').limit(1);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    supabase = null;
    supaError = e.message || 'Connection failed';
    console.warn('Supabase unavailable, using local storage:', e.message);
    return false;
  }
}

// Connecting Supabase flips store.list() to read ONLY the remote table, so any
// leads already saved in this browser would silently vanish from the UI (they're
// still in localStorage, but nothing reads it any more). Offer to lift them up.
// Upsert by id so re-running is harmless, and NEVER delete the local copy — it
// stays as a free backup.
const MIGRATED_KEY = 'leadlion_supa_migrated';

async function maybeOfferLeadMigration() {
  if (!dbActive()) return;
  const local = store.local();
  if (!local.length || localStorage.getItem(MIGRATED_KEY) === '1') return;
  let remoteIds = new Set();
  try {
    const { data, error } = await supabase.from('leads').select('id');
    if (error) throw new Error(error.message);
    remoteIds = new Set((data || []).map((r) => r.id));
  } catch { /* can't read — still offer, upsert is idempotent */ }
  const missing = local.filter((l) => !remoteIds.has(l.id));
  if (!missing.length) { localStorage.setItem(MIGRATED_KEY, '1'); return; }

  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="mig-overlay">
      <div class="modal" style="max-width:540px">
        <h2 style="margin-top:0">${ic('database')} Move your saved leads to Supabase?</h2>
        <p class="muted" style="font-size:14px;line-height:1.65">
          You have <b>${missing.length} lead${missing.length === 1 ? '' : 's'}</b> saved in this browser.
          Now that Supabase is connected, the app reads leads from there — so these
          <b>won't show up until they're uploaded</b>.
        </p>
        <div class="banner banner-info" style="font-size:12.5px;line-height:1.6;margin-top:12px">
          ${ic('lock')} Nothing is deleted. Your browser copy stays exactly where it is as a backup, and uploading twice is harmless.
        </div>
        <div id="mig-result" style="margin-top:10px"></div>
        <div class="flex mt" style="margin-top:20px">
          <button id="mig-go">${ic('upload')} Upload ${missing.length} lead${missing.length === 1 ? '' : 's'}</button>
          <button class="btn-ghost" id="mig-skip">Not now</button>
        </div>
      </div>
    </div>`;
  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#mig-skip').onclick = () => { localStorage.setItem(MIGRATED_KEY, '1'); close(); toast('Skipped — your leads stay in this browser'); };
  $('#mig-overlay').onclick = (e) => { if (e.target.id === 'mig-overlay') close(); };
  $('#mig-go').onclick = async () => {
    const btn = $('#mig-go');
    btn.disabled = true;
    const rows = missing.map((l) => ({ id: l.id, status: l.status || 'new', notes: l.notes || '', data: l }));
    let done = 0, failed = 0;
    const CHUNK = 50; // one round-trip per 50 — 244 single upserts would crawl
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      btn.innerHTML = `<span class="spinner"></span> ${done}/${rows.length}`;
      const { error } = await supabase.from('leads').upsert(slice);
      if (error) { failed += slice.length; } else { done += slice.length; }
    }
    if (failed) {
      $('#mig-result').innerHTML = `<div class="banner banner-warn" style="font-size:12.5px">${sevIcon('critical')} ${done} uploaded, <b>${failed} failed</b>. Your browser copy is untouched — fix the error and try again.</div>`;
      btn.disabled = false;
      btn.innerHTML = `${ic('upload')} Retry`;
      return;
    }
    localStorage.setItem(MIGRATED_KEY, '1');
    close();
    toast(`${done} lead${done === 1 ? '' : 's'} moved to Supabase`);
    render();
  };
}

const store = {
  local() {
    try { return JSON.parse(localStorage.getItem(leadsKey())) || []; }
    catch { return []; }
  },
  writeLocal(leads) { localStorage.setItem(leadsKey(), JSON.stringify(leads)); },

  async list() {
    if (dbActive()) {
      const { data, error } = await supabase.from('leads').select('*').order('created_at', { ascending: false });
      if (error) { toast('Supabase read failed — using local'); return this.local(); }
      return data.map((r) => ({ ...r.data, id: r.id, status: r.status, notes: r.notes || '' }));
    }
    return this.local();
  },

  async save(lead) {
    const record = { ...lead, id: lead.placeId, status: lead.status || 'new', notes: lead.notes || '', savedAt: new Date().toISOString() };
    if (dbActive()) {
      const { error } = await supabase.from('leads').upsert({ id: record.id, status: record.status, notes: record.notes, data: record });
      if (error) { toast('Supabase save failed: ' + error.message); return null; }
      return record;
    }
    const leads = this.local().filter((l) => l.id !== record.id);
    leads.unshift(record);
    this.writeLocal(leads);
    return record;
  },

  async update(id, patch) {
    if (dbActive()) {
      const leads = await this.list();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return;
      const updated = { ...lead, ...patch };
      await supabase.from('leads').upsert({ id, status: updated.status, notes: updated.notes, data: updated });
      return updated;
    }
    const leads = this.local();
    const i = leads.findIndex((l) => l.id === id);
    if (i === -1) return;
    leads[i] = { ...leads[i], ...patch };
    this.writeLocal(leads);
    return leads[i];
  },

  // Apply many patches in a single persist (localStorage rewrite, or one Supabase
  // upsert of all changed rows) — used by the location cleanup so 200 leads don't
  // become 200 round-trips. Returns how many rows changed.
  async bulkUpdate(updates) { // updates: [{ id, patch }]
    if (dbActive()) {
      const leads = await this.list();
      const byId = new Map(leads.map((l) => [l.id, l]));
      const rows = [];
      for (const { id, patch } of updates) {
        const lead = byId.get(id);
        if (!lead) continue;
        const updated = { ...lead, ...patch };
        rows.push({ id, status: updated.status, notes: updated.notes, data: updated });
      }
      if (rows.length) {
        const { error } = await supabase.from('leads').upsert(rows);
        if (error) { toast('Supabase update failed: ' + error.message); return 0; }
      }
      return rows.length;
    }
    const leads = this.local();
    const patchById = new Map(updates.map((u) => [u.id, u.patch]));
    let n = 0;
    for (let i = 0; i < leads.length; i++) {
      const p = patchById.get(leads[i].id);
      if (p) { leads[i] = { ...leads[i], ...p }; n++; }
    }
    this.writeLocal(leads);
    return n;
  },

  async remove(id) {
    if (dbActive()) { await supabase.from('leads').delete().eq('id', id); return; }
    this.writeLocal(this.local().filter((l) => l.id !== id));
  },

  async get(id) {
    return (await this.list()).find((l) => l.id === id);
  },
};

// ---------------------------------------------------------------- helpers
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline icon set (Lucide-style stroke paths). Icons inherit `currentColor`, so a
// glyph takes the colour of its context — dim in a nav link, dark inside the gold
// active pill, red/green when carrying a severity class. Emoji can't do that and
// render differently on every OS, so the whole app uses these instead.
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1-1.6-.5-3.4 1-5 .5 2.5 2 4.4 4 6 1.5 1.2 2 2.5 2 4a6 6 0 1 1-12 0c0-1.3.5-2.5 1-3.5.3 1 .8 1.7 1.5 2Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  snow: '<line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><path d="m20 16-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 0-1.4 1.4L13 16l2 2 2-2 2 2 2-2-6.6-6.6Z"/><circle cx="7.5" cy="15.5" r="1.5"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="9" r="1"/><path d="M12 21a3 3 0 0 1 0-6h1a2 2 0 0 0 2-2 4 4 0 0 0-4-4"/>',
  pin: '<path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/>',
  trendUp: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  trendDown: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>',
  trophy: '<path d="M6 9a6 6 0 0 0 12 0V3H6Z"/><path d="M6 5H4a2 2 0 0 0 0 4h2M18 5h2a2 2 0 0 1 0 4h-2M8 21h8M12 15v6"/>',
  star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z"/>',
  signal: '<path d="M5 12.5a7 7 0 0 1 14 0M8.5 15.5a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
  ticket: '<path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 6 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-6Z"/><line x1="13" y1="7" x2="13" y2="17"/>',
  sprout: '<path d="M12 20v-8M12 12C12 8 9 6 4 6c0 4 3 6 8 6ZM12 12c0-3 2-5 6-5 0 3-2 5-6 5Z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z"/>',
  dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><path d="M12 16h.01"/>',
  alertTriangle: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><path d="M12 17h.01"/>',
  checkCircle: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14 9 11"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><path d="M12 8h.01"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  beaker: '<path d="M9 3h6M10 3v6.6L4.2 18a2 2 0 0 0 1.8 3h12a2 2 0 0 0 1.8-3L14 9.6V3"/><line x1="7" y1="14" x2="17" y2="14"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
};
function ic(name, cls = '') {
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
// Severity → coloured status icon. Keep this mapping exact: it drives what a
// prospect reads (red = critical problem = the sales hook). 'ok' passes are green.
function sevIcon(sev) {
  if (sev === 'ok' || sev === true) return ic('checkCircle', 'ic-ok');
  if (sev === 'critical') return ic('alertCircle', 'ic-critical');
  if (sev === 'warning') return ic('alertTriangle', 'ic-warning');
  return ic('info', 'ic-info');
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function scorePill(opp) {
  const cls = opp >= 55 ? 'score-hot' : opp >= 30 ? 'score-warm' : 'score-cold';
  return `<span class="score-pill ${cls}">${opp}</span>`;
}

function gradeBadge(grade) {
  const cls = grade === 'A' || grade === 'B' ? 'badge-green' : grade === 'C' ? 'badge-yellow' : 'badge-red';
  return `<span class="badge ${cls}">Grade ${grade}</span>`;
}

const STATUSES = ['new', 'contacted', 'meeting', 'won', 'lost'];
const STATUS_LABEL = { new: 'New', contacted: 'Contacted', meeting: 'Meeting', won: 'Won', lost: 'Lost' };

// ---------------------------------------------------------------- outreach
// Findings are SNAPSHOT onto saved leads, so a scoring.js copy fix only helps new
// searches. This rewrites findings that assert something we can't verify — at render
// time — so existing leads read honestly too, in the modal AND in every outreach draft.
// Keyed by the audit factor. The 'claimed' heuristic can't know claim status (Places
// exposes none), so the old "UNCLAIMED — anyone could request ownership" becomes the
// observable "thin/unmanaged listing".
const HONEST_OVERRIDE = {
  claimed: { severity: 'critical', text: 'Likely an unclaimed or barely-managed listing.', pitch: 'This is the foot-in-the-door: claiming the listing and building it out is the fastest, highest-impact first project — and the quickest way to start ranking in local search.' },
};
function normFinding(f) {
  if (!f || f.ok) return f;
  if (HONEST_OVERRIDE[f.factor]) return { ...f, ...HONEST_OVERRIDE[f.factor] };
  // Older snapshots assert "the listing looks inactive" (an inference) — soften it.
  if (/looks inactive/i.test(f.text || '')) return { ...f, text: f.text.replace(/the listing looks inactive/i, 'nothing signals trust to a new customer') };
  return f;
}

function allIssues(lead) {
  // GMB issues first, then website-audit issues, then speed — criticals first.
  // Normalize BEFORE sorting. For a thin/unclaimed listing, LEAD with the claim-&-
  // setup finding: it's the umbrella opportunity (the other gaps are symptoms), so
  // it should head the outreach drafts — not sit 4th behind its own symptoms.
  const rank = { critical: 0, warning: 1, info: 2 };
  const sortKey = (f) => (f.factor === 'claimed' && !f.ok ? -1 : (rank[f.severity] ?? 3));
  const norm = (arr) => (arr || []).map(normFinding);
  const gmb = norm(lead.issues).sort((a, b) => sortKey(a) - sortKey(b));
  const web = norm(lead.webAudit?.issues).sort((a, b) => rank[a.severity] - rank[b.severity]);
  const speed = lead.pageSpeed?.ok && !lead.pageSpeed.finding.ok ? [lead.pageSpeed.finding] : [];
  return [...gmb, ...web, ...speed];
}

// ---------------------------------------------------------------- fix plan
// INTERNAL, agency-only. This is the "how to fix it" — the labour the agency is
// paid for. It must NEVER reach the client (that's the audit report's job — to
// convince, not to teach). So: no share link, no send buttons, labelled internal.
//
// The "how" is a static library keyed by the audit's factor keys, so there's no
// per-lead AI cost — we assemble steps for THIS lead from findings already computed.
const FIX_STEPS = {
  // --- Google Business Profile ---
  website: (l) => ({ eta: 10, steps: [
    l.demoSiteId ? 'They have no site — use the demo website you already generated (open the lead → "Demo website"). Publish it and use that URL.'
      : 'They have no site — spin one up (or generate the demo site from the lead) and get a live URL.',
    'In the Google Business Profile → Edit profile → Contact → Website → paste the URL → Save.',
  ] }),
  rating: (l) => ({ eta: 20, steps: [
    'Address the root cause of the low rating first (whatever the negative reviews complain about) — otherwise new reviews stay low.',
    'Launch a review-request flow (SMS/QR after each job) to bury old scores under fresh 5-stars. LeadLion drafts the request message.',
    'Reply to every existing negative review, professionally — LeadLion drafts these too (open the lead → review reply).',
  ] }),
  reviews: (l) => ({ eta: 15, steps: [
    l.reviewInsight?.toTarget ? `Target: about ${l.reviewInsight.toTarget.needed} more 5-star reviews to reach ${l.reviewInsight.toTarget.target}★.` : 'Set a monthly review target and track it.',
    'Set up a review-request step after every completed job — SMS or a QR code at the counter/invoice.',
    'Use LeadLion to draft the request message; keep the Google review link one tap away.',
  ] }),
  claimed: () => ({ eta: 10, steps: [
    'Claim/verify the listing at business.google.com — search the business, "Claim this business", verify by postcard, phone, or video.',
    'Once verified, lock down the info so it can\'t drift (hours, category, phone, website).',
  ] }),
  photos: (l) => ({ eta: 15, steps: [
    `Currently ${l.photoCount ?? 0} photos — get to 10+.`,
    'Upload a spread: storefront/exterior, 2× interior, the team, a job in progress, and the logo. GBP → Photos → Add.',
    'Ask the owner for real photos — stock hurts trust and can be flagged.',
  ] }),
  hours: () => ({ eta: 5, steps: [
    'GBP → Edit profile → Hours → set regular opening hours.',
    'Add special/holiday hours so "Is it open now?" is always answered.',
  ] }),
  phone: () => ({ eta: 3, steps: [
    'GBP → Edit profile → Contact → Phone → add a number (a local area code beats a mobile for trust).',
    'Make sure it matches the number on their website exactly (NAP consistency).',
  ] }),
  category: (l) => ({ eta: 5, steps: [
    `Set the primary category to the most specific accurate one${l.category ? ` (currently "${esc(l.category)}")` : ''}.`,
    'Add relevant secondary categories — they widen the searches you rank for. GBP → Edit profile → Category.',
  ] }),
  status: () => ({ eta: 30, steps: [
    'The listing is flagged with a wrong status (e.g. closed) — this kills all traffic.',
    'GBP → reopen / mark as operational. If Google resists, request reinstatement via Business Profile support.',
  ] }),
  // --- Website audit ---
  https: () => ({ eta: 15, steps: ['Install an SSL certificate (most hosts offer it free via Let\'s Encrypt).', 'Force an HTTP→HTTPS redirect so the padlock always shows.'] }),
  speed: () => ({ eta: 45, steps: ['Compress and convert images to WebP, enable caching, and defer non-critical JavaScript.', 'Re-test on Google PageSpeed Insights until mobile is green.'] }),
  viewport: () => ({ eta: 5, steps: ['Add the responsive meta tag to <head>: <meta name="viewport" content="width=device-width, initial-scale=1">.'] }),
  title: (l) => ({ eta: 5, steps: [`Write a keyword + location title tag (~60 chars), e.g. "${esc(l.keyword || 'Service')} in ${esc((l.location || 'City'))} | ${esc(l.name || 'Business')}".`] }),
  metaDesc: () => ({ eta: 5, steps: ['Add a meta description (~155 chars) with the service, the city, and a clear call to action.'] }),
  h1: () => ({ eta: 5, steps: ['Add one clear H1 on the homepage with the primary service + city.'] }),
  contact: () => ({ eta: 10, steps: ['Put phone + address in the site header/footer, matching the Google listing exactly (NAP consistency).'] }),
  whatsapp: () => ({ eta: 10, steps: ['Add a click-to-WhatsApp button/link for instant mobile enquiries — the single fastest conversion lift for local service sites.'] }),
  booking: () => ({ eta: 20, steps: ['Add an online booking or quote-request form so visitors convert without having to call.'] }),
  content: () => ({ eta: 60, steps: ['The site is thin — add real service pages: what you do, service areas, pricing/FAQ, a few case photos.'] }),
  schema: () => ({ eta: 20, steps: ['Add LocalBusiness JSON-LD schema (name, address, phone, hours, geo) — helps rich results and local ranking.'] }),
  analytics: () => ({ eta: 10, steps: ['Install analytics (GA4 or similar) so you can prove the results to the client later.'] }),
  social: () => ({ eta: 5, steps: ['Link the business\'s social profiles from the site, and from the Google listing.'] }),
  weight: () => ({ eta: 30, steps: ['The page is heavy — compress oversized images, lazy-load below-the-fold media, drop unused scripts.'] }),
};

function fixItems(lead) {
  // Severity only — a stable sort preserves allIssues' natural order (Google
  // listing first, then website, then speed), so within "critical" the GMB items
  // lead. Don't tiebreak on point-loss: GMB is /20 and web is /100, so that would
  // wrongly float every website issue above the listing ones.
  const rank = { critical: 0, warning: 1, info: 2 };
  return allIssues(lead)
    .slice()
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
    .map((f) => {
      const fx = FIX_STEPS[f.factor] ? FIX_STEPS[f.factor](lead, f) : { eta: 10, steps: [f.pitch || 'Fix this on the listing / site.'] };
      return { finding: f, steps: fx.steps, eta: fx.eta };
    });
}

function fixPlanText(lead) {
  const items = fixItems(lead);
  const nCrit = items.filter((i) => i.finding.severity === 'critical').length;
  const eta = items.reduce((s, i) => s + (i.eta || 0), 0);
  const lines = [
    `GBP FIX PLAN — ${lead.name}  (INTERNAL — do NOT send to the client)`,
    `${lead.address || ''}`,
    `${items.length} item${items.length === 1 ? '' : 's'} · ${nCrit} critical · est ~${eta} min`,
    '',
  ];
  items.forEach((it, i) => {
    lines.push(`[ ] ${i + 1}. ${it.finding.text}  (${it.finding.severity || 'fix'})`);
    if (it.finding.pitch) lines.push(`      Why: ${it.finding.pitch}`);
    it.steps.forEach((s) => lines.push(`      - ${s.replace(/<[^>]+>/g, '')}`));
    lines.push('');
  });
  return lines.join('\n');
}

function buildOutreach(lead) {
  const s = getSettings();
  const agency = s.agencyName || 'Your Agency';
  const topIssues = allIssues(lead).slice(0, 4);
  const bullets = topIssues.map((i) => `  • ${i.text}`).join('\n');
  const services = [...new Set([...(lead.services || []), ...(lead.webAudit?.issues || []).map((i) => i.service)])].filter(Boolean).join(', ') || 'local SEO';

  const c = lead.competitors;
  const compLine = c && c.marketSize && c.reviewTarget
    ? `\n\nFor context: you're ranked #${c.rankByReviews} of ${c.marketSize} for "${lead.keyword}" in your area. Around ${c.reviewTarget.needed} more reviews would move you past ${c.reviewTarget.passN} competitor${c.reviewTarget.passN === 1 ? '' : 's'} — a very reachable first step.`
    : '';

  // Review intelligence line — only when it actually strengthens the pitch.
  const ri = lead.reviewInsight;
  const reviewLine = ri && ri.tier === 'weak' && ri.toTarget
    ? `\n\nOn reviews: an estimated ${ri.minBelow5}${ri.maxBelow5 > ri.minBelow5 && ri.maxBelow5 < ri.count ? `–${ri.maxBelow5}` : '+'} of your ${ri.count} reviews sit below 5 stars. Reaching the 4.5★ threshold most customers filter by would take around ${ri.toTarget.needed} new 5-star reviews — that's a campaign we run.`
    : ri && (ri.tier === 'perfect' || ri.tier === 'strong') && !lead.website
      ? `\n\nOne more thing: you've earned a ${ri.rating}★ rating from ${ri.count} customers — and none of that is visible to anyone who doesn't already find you on Google. That's a lot of trust going to waste.`
      : '';

  // Mined-review line. Quoting a customer back at the owner is the single most
  // persuasive line in the email — and the most dangerous to get wrong, so we
  // only ever use a quote we verified is verbatim, and we frame it as *theirs*
  // to fix, never as an accusation.
  // NB: never assert the review is "unanswered" — Google's API doesn't tell us
  // whether the owner replied, and being wrong about that torches the pitch.
  const topComplaint = (lead.reviewMining?.complaints || []).find((t) => t.quote && t.quoteVerified);
  const miningLine = topComplaint
    ? `\n\nAlso, reading through your public reviews, "${topComplaint.label.toLowerCase()}" comes up more than once — one customer wrote: "${topComplaint.quote}" That's the kind of thing a prospective customer reads before they ever call you. Responding to reviews like that publicly is quick, free, and changes the impression immediately.`
    : '';

  const email = `Subject: Quick question about ${lead.name}'s Google listing

Hi there,

I was searching for "${lead.keyword}" in ${lead.location} and came across ${lead.name}. I ran a quick audit of your Google Business Profile and noticed a few things that are likely costing you customers:

${bullets}${compLine}${reviewLine}${miningLine}

These are all fixable — most within a couple of weeks. I put together a free, no-obligation audit report that shows exactly where you stand against competitors nearby.

Would you be open to a 10-minute call this week? I'll send the full report either way.

Best,
${agency}${s.agencyPhone ? '\n' + s.agencyPhone : ''}${s.agencyEmail ? '\n' + s.agencyEmail : ''}`;

  const call = `CALL SCRIPT — ${lead.name}

Opener:
"Hi, could I speak to the owner or manager? ... Great — I'll be quick. My name is [name] from ${agency}. I was looking up ${lead.keyword} businesses in ${lead.location} and ran a free audit on your Google listing."

Hook (their top problem):
"${topIssues[0] ? topIssues[0].text + ' ' + (topIssues[0].pitch || '') : 'Your online presence has some quick wins available.'}"
${topComplaint ? `
Their customers' own words (use this — it lands harder than any statistic):
"I also read through your Google reviews. ${topComplaint.label} came up more than once — one person wrote, '${topComplaint.quote}'. That's what someone comparing you to a competitor reads first."
` : ''}

Value:
"We help local businesses fix exactly this — ${services}. Most clients see more calls within 30 days."

Close:
"I've already prepared your audit report — can I email it over and grab 10 minutes this week to walk you through it?"

Objection — "not interested":
"Totally understand. Can I still send the free report? No strings — if nothing else you'll know what your competitors are doing better."`;

  // WhatsApp — short, warm, mobile-first. Two issues max, ends with a soft ask.
  const wIssues = topIssues.slice(0, 2).map((i) => `• ${i.text}`).join('\n');
  const greet = s.waGreeting || 'Hello';
  const whatsapp = `${greet}! I came across ${lead.name} on Google while searching "${lead.keyword}" in ${lead.location}.

I did a quick check of your online presence and noticed a couple of things that may be sending customers to competitors:
${wIssues}

Both are quick to fix. I've prepared a *free* audit report for you — no cost, no obligation. Would it be okay if I share it?

${agency}`;

  return { email, call, whatsapp };
}

// Map each audit factor to the agency service that fixes it. Website-audit issues
// already carry a `.service`; GMB findings are mapped here.
const FACTOR_SERVICE = {
  website: 'Website design',
  https: 'Website speed & security', speed: 'Website speed & security', weight: 'Website speed & security', viewport: 'Website speed & security',
  title: 'Local SEO', metaDesc: 'Local SEO', h1: 'Local SEO', schema: 'Local SEO', content: 'Local SEO',
  contact: 'Conversion optimisation', whatsapp: 'Conversion optimisation', booking: 'Conversion optimisation',
  analytics: 'Website analytics', social: 'Social presence',
  rating: 'Reputation & reviews', reviews: 'Reputation & reviews',
  claimed: 'Google Business Profile optimisation', status: 'Google Business Profile optimisation',
  photos: 'Google Business Profile optimisation', hours: 'Google Business Profile optimisation',
  phone: 'Google Business Profile optimisation', category: 'Google Business Profile optimisation',
};

// The ONE service to pitch a lead first (+ 1-2 runners-up), derived from the audit:
// each issue votes for its service, weighted by severity. Deterministic and
// explainable — grounded in the findings, not an AI guess. Agency-facing only.
function serviceSuggestion(lead) {
  const issues = allIssues(lead);
  if (!issues.length) return null;
  const weight = { critical: 3, warning: 2, info: 1 };
  const score = {}, exemplar = {};
  for (const f of issues) {
    const svc = f.service || FACTOR_SERVICE[f.factor] || 'Local SEO';
    score[svc] = (score[svc] || 0) + (weight[f.severity] || 1);
    if (!exemplar[svc]) exemplar[svc] = f;
  }
  const ranked = Object.keys(score).sort((a, b) => score[b] - score[a]);
  return { primary: ranked[0], reason: exemplar[ranked[0]]?.text || '', secondary: ranked.slice(1, 3) };
}

// Cold-email angle from OBSERVABLE signals (website presence), never the unreliable
// claimed guess. no website → "get-online"; has website → established → "grow".
const outreachAngle = (lead) => lead.website ? 'grow' : 'get-online';
const ANGLE_LABEL = { 'get-online': 'Get online (no website)', 'grow': 'Grow & optimise' };

// Compact lead payload for the AI copy endpoint (/api/copy) — findings only, no
// Google call. Shared by the cold-email and GBP-description generators.
function copyLeadPayload(lead) {
  return {
    name: lead.name, category: lead.category, location: lead.location,
    hasWebsite: !!lead.website,
    topIssues: allIssues(lead).slice(0, 5).map((i) => ({ text: i.text })),
  };
}

// Build a wa.me deep link. Prefers Google's international number; falls back to
// national + a default country code from Settings. Empty number → WhatsApp
// opens with the message pre-typed and the user picks the contact.
function waNumber(lead) {
  if (lead.phoneIntl) return lead.phoneIntl.replace(/\D/g, '');
  let p = (lead.phone || '').replace(/\D/g, '');
  if (!p) return '';
  const cc = (getSettings().waCountryCode || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = p.slice(1);
  return cc ? cc + p : ''; // without a country code we can't be sure — let user pick
}

function waLink(lead, message) {
  const num = waNumber(lead);
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}

// The email address harvested from the lead's OWN website during the audit.
// (Compliant — it's the business's public contact address, not scraped from
// Google.) Empty until a website audit has run.
function leadEmail(lead) {
  return (lead.webAudit?.emails || [])[0] || '';
}

// Turn the cold-email text into a mailto: link. The body starts with a
// "Subject: …" line — we lift that into the real subject and drop it from the
// body, so the user's mail client opens correctly pre-filled. Recipient is the
// harvested email if we have one; otherwise the user fills it in.
function mailtoLink(lead, emailText) {
  let body = emailText;
  let subject = `A quick note about ${lead.name}`;
  const m = emailText.match(/^Subject:\s*(.+)\n+/);
  if (m) { subject = m[1].trim(); body = emailText.slice(m[0].length); }
  const to = encodeURIComponent(leadEmail(lead));
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ---------------------------------------------------------------- views
const routes = {
  dashboard: viewDashboard,
  find: viewFind,
  leads: viewLeads,
  map: viewMap,
  settings: viewSettings,
  report: viewReport,
  fixplan: viewFixPlan,
};

let lastSearch = null; // cache results between navigations
// 'niche' = the usual keyword+city sweep. 'name' = look up ONE named business
// (Places text search is business-first, so the same endpoint handles it — a name
// lookup is always a 1-page quick search, never a deep sweep).
let searchMode = 'niche';

async function render() {
  $('#modal-root').innerHTML = ''; // close any open modal on navigation
  const hash = location.hash.replace(/^#\//, '') || 'dashboard';
  const [route, param] = hash.split('/');
  const view = routes[route] || viewDashboard;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route));
  $('#main').innerHTML = '<p class="muted">Loading…</p>';
  await view(param);
  injectStorageWarning();
  // One modal at a time — both write to #modal-root. BYOK first (it gates live
  // searching at all); the storage nudge gets the next render.
  if (!maybeByokPrompt()) maybeSupaPrompt();
}

// First-run nudge: ask once, right after they land, whether to set BYOK up now.
// Never for demo (there's no live search to fund) and never twice — we mark it
// asked the moment it's shown, so navigating away doesn't turn it into a nag.
function maybeByokPrompt() {
  if (!SESSION || isDemo() || hasByok() || byokPrompted()) return false;
  markByokPrompted();
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="bp-overlay">
      <div class="modal" style="max-width:530px">
        <h2 style="margin-top:0">${ic('key')} Run searches on your own Google key?</h2>
        <p class="muted" style="font-size:14px;line-height:1.65">
          LeadLion's live searches can run on <b>your own free Google key</b>. Google bills you
          directly — <b>usually $0</b>, thanks to a one-time $300 credit and a free monthly
          allowance that renews — and <b>we take no cut</b>. Nothing gets rationed.
        </p>
        <div class="banner banner-info" style="font-size:12.5px;line-height:1.6;margin-top:12px">
          ${ic('bulb')} Setup takes about <b>5 minutes</b> and we walk you through every step — then one click tests the key for you.
        </div>
        <div class="flex mt" style="margin-top:20px">
          <button id="bp-setup">${ic('key')} Set up my key (5 min)</button>
          <button class="btn-ghost" id="bp-later">Explore first</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:14px">
          You can start this any time from <b>Settings</b>. <a href="/byok" target="_blank" rel="noopener" style="color:var(--accent)">What is BYOK, and why? ↗</a>
        </p>
      </div>
    </div>`;
  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#bp-later').onclick = close;
  $('#bp-overlay').onclick = (e) => { if (e.target.id === 'bp-overlay') close(); };
  $('#bp-setup').onclick = () => openByokWizard(0);
  return true;
}

// -------- dashboard
const PIPE_COLORS = { new: '#60a5fa', contacted: '#fbbf24', meeting: '#a78bfa', won: '#34d399', lost: '#f87171' };

function funnelChart(leads) {
  const max = Math.max(1, ...STATUSES.map((st) => leads.filter((l) => (l.status || 'new') === st).length));
  return `<div class="chart-card"><h3>Pipeline</h3>
    ${STATUSES.map((st) => {
      const n = leads.filter((l) => (l.status || 'new') === st).length;
      return `<div class="funnel-row"><span class="fl">${STATUS_LABEL[st]}</span>
        <div class="funnel-bar" style="width:${(n / max) * 100}%;background:${PIPE_COLORS[st]}">${n || ''}</div></div>`;
    }).join('')}
  </div>`;
}

function opportunityChart(leads) {
  const hot = leads.filter((l) => combinedOpp(l) >= 55).length;
  const warm = leads.filter((l) => { const o = combinedOpp(l); return o >= 30 && o < 55; }).length;
  const cold = leads.filter((l) => combinedOpp(l) < 30).length;
  const max = Math.max(1, hot, warm, cold);
  const bar = (label, n, color) => `<div class="funnel-row"><span class="fl">${label}</span><div class="funnel-bar" style="width:${(n / max) * 100}%;background:${color}">${n || ''}</div></div>`;
  return `<div class="chart-card"><h3>Opportunity spread</h3>
    ${bar('Hot', hot, '#f87171')}${bar('Warm', warm, '#fbbf24')}${bar('Cold', cold, '#34d399')}
  </div>`;
}

function activityChart(leads) {
  // leads saved per day over the last 7 days
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const n = leads.filter((l) => (l.savedAt || '').slice(0, 10) === key).length;
    days.push({ label: d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2), n });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  return `<div class="chart-card"><h3>Leads saved (7 days)</h3>
    <div class="spark">${days.map((d) => `<div style="height:${Math.max(2, (d.n / max) * 100)}%">${d.n ? `<span>${d.n}</span>` : ''}</div>`).join('')}</div>
    <div class="spark-labels">${days.map((d) => `<div>${d.label}</div>`).join('')}</div>
  </div>`;
}

async function viewDashboard() {
  const leads = await store.list();
  const avgOpp = leads.length ? Math.round(leads.reduce((a, l) => a + combinedOpp(l), 0) / leads.length) : 0;
  const won = leads.filter((l) => l.status === 'won').length;
  const active = leads.filter((l) => ['contacted', 'meeting'].includes(l.status)).length;
  const recent = leads.slice(0, 6);

  $('#main').innerHTML = `
    <h1>Dashboard</h1>
    <p class="subtitle">Your local lead-gen command center.</p>
    <div class="grid grid-4 mb">
      <div class="card"><div class="stat-num">${leads.length}</div><div class="stat-label">Saved leads</div></div>
      <div class="card"><div class="stat-num">${avgOpp}</div><div class="stat-label">Avg. opportunity score</div></div>
      <div class="card"><div class="stat-num">${active}</div><div class="stat-label">In conversation</div></div>
      <div class="card"><div class="stat-num">${won}</div><div class="stat-label">Clients won</div></div>
    </div>
    ${leads.length === 0 ? `
      <div class="card">
        <h2 style="margin-top:0">Get your first leads in 30 seconds</h2>
        <p class="muted mb">Search any niche + city. LeadLion scores every business by how badly they need your help — then generates the audit report and outreach script to close them.</p>
        <a class="btn" href="#/find">${ic('search')} Find leads now</a>
      </div>` : `
      <div class="grid mb" style="grid-template-columns:repeat(auto-fit,minmax(250px,1fr))">
        ${funnelChart(leads)}
        ${opportunityChart(leads)}
        ${activityChart(leads)}
      </div>
      <h2>Recent leads</h2>
      ${bulkBarHtml()}
      <div class="table-wrap">${leadsTable(recent, { selectable: true })}</div>`}
  `;
  bindLeadRows(recent);
  wireSelection(render);
}

// -------- find leads
async function viewFind() {
  const p = SESSION?.profile || {};
  // Search-depth tiers as selectable cards. Colours escalate with cost/coverage
  // (green → blue → orange → red) so the spend axis reads at a glance — this is
  // also the packaging/upsell axis. Native <option> can't show colour or two
  // lines, so this replaces the old <select>. Value is read from the checked
  // radio at search time (see runSearch).
  const curDepth = !lastSearch ? 'quick' : (lastSearch.depth || (lastSearch.deep ? 'deep' : 'quick'));
  const TIERS = [
    ['quick', 'var(--green)', 'Quick scout', '≈20 top leads in seconds. Cheapest way to test a niche.'],
    ['fast', 'var(--blue)', 'Standard search', 'The 60 best-matching leads in the area. ~4s.'],
    ['deep', '#fb923c', 'Deep dive', 'Every neighbourhood, block by block — hundreds of leads. ~10s.'],
    ['exhaustive', 'var(--red)', 'Full sweep', 'Every lead we can possibly find. ~15s, most API calls.'],
  ];
  const cur = TIERS.find((t) => t[0] === curDepth) || TIERS[0];
  const depthPicker = feat().deep ? `
      <div style="margin-top:16px;max-width:460px">
        <label style="margin-bottom:8px">Search depth</label>
        <div class="dd" id="depth-dd">
          <input type="hidden" id="depth" value="${curDepth}">
          <button type="button" class="dd-toggle" id="depth-toggle" aria-haspopup="listbox" aria-expanded="false">
            <span class="tier-dot" id="dd-dot" style="background:${cur[1]}"></span>
            <span class="dd-label" id="dd-label">${cur[2]}</span>
            ${ic('chevron', 'dd-caret')}
          </button>
          <div class="dd-menu" id="depth-menu" role="listbox" hidden>
            ${TIERS.map(([v, dot, title, desc]) => `
            <div class="dd-opt${v === curDepth ? ' sel' : ''}" role="option" data-v="${v}" data-dot="${dot}" data-title="${esc(title)}">
              <span class="tier-dot" style="background:${dot}"></span>
              <span class="tier-body"><span class="tier-title">${title}</span><span class="tier-desc">${desc}</span></span>
              ${ic('checkCircle', 'ic-ok dd-check')}
            </div>`).join('')}
          </div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">The grid adapts to the city's size — big cities get more zones automatically.</div>
      </div>` : '';
  const nameMode = searchMode === 'name';
  $('#main').innerHTML = `
    <h1>Find Leads</h1>
    <p class="subtitle">${nameMode
      ? 'Look up one specific business by name — audit it on the spot.'
      : 'Search any niche in any city — every result is scored by sales opportunity.'}</p>
    <div id="tier-banner">${trialBanner()}</div>
    <div class="card">
      <div class="seg no-print" style="margin-bottom:14px">
        <button class="seg-btn ${!nameMode ? 'on' : ''}" data-smode="niche">Search a niche</button>
        <button class="seg-btn ${nameMode ? 'on' : ''}" data-smode="name">Find one business</button>
      </div>
      <div class="search-row">
        <div class="field"><label>${nameMode ? 'Business name' : 'Niche / keyword'}</label><input id="kw" placeholder="${nameMode ? 'e.g. Arham Dental Clinic' : 'e.g. plumber, dentist, roofing'}" value="${esc(lastSearch?.keyword || '')}"></div>
        <div class="field ac-field"><label>${nameMode ? 'City <span class="muted" style="font-weight:400">(narrows it to the right one)</span>' : 'Location'}</label><input id="loc" placeholder="e.g. Hyderabad, Pakistan" value="${esc(lastSearch?.location || '')}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false"><div id="loc-ac" class="ac-menu" hidden role="listbox"></div></div>
        <button id="go">${nameMode ? 'Find' : 'Search'}</button>
      </div>
      ${nameMode ? '' : depthPicker}
      ${nameMode ? `<p class="muted mt" style="font-size:12.5px">${ic('search')} One quick lookup (1 API call). Use this when a prospect gives you their name, or to re-audit a client.</p>` : ''}
      ${isDemo() ? `<p class="muted mt" style="font-size:13px">${ic('beaker')} Demo mode — sample data only. Enter an access code (Log out → code) for live results.</p>` : ''}
    </div>
    <div id="results"></div>
  `;
  $('#go').onclick = runSearch;
  $('#kw').onkeydown = (e) => { if (e.key === 'Enter') runSearch(); };
  document.querySelectorAll('[data-smode]').forEach((b) => {
    b.onclick = () => { searchMode = b.dataset.smode; viewFind(); };
  });
  wireDepthPicker();
  wireCityAutocomplete(); // owns #loc's keydown (arrows/enter/escape), falls back to runSearch
  if (lastSearch?.results) renderResults(lastSearch);
}

// City autocomplete on the Location box. Suggestions come from Google Places
// Autocomplete (New) via /api/autocomplete, pre-disambiguated ("Hyderabad, Pakistan"
// vs "Hyderabad, India"). Picking one fills the box with the fully-qualified string,
// which the existing search paths already geocode correctly — so typos and same-name
// cities are both solved at the input, with no changes to plan/zones/search.
function wireCityAutocomplete() {
  const input = $('#loc');
  const menu = $('#loc-ac');
  if (!input || !menu) return;

  let items = [];
  let active = -1;
  let token = (window.crypto?.randomUUID ? crypto.randomUUID() : String(Math.random())); // one Google session per typing run
  let debounce = null;
  let ctrl = null;      // aborts a stale in-flight request
  let lastQuery = '';

  const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const paint = () => {
    menu.innerHTML = items.map((it, i) => `
      <div class="ac-opt ${i === active ? 'active' : ''}" role="option" data-i="${i}">
        <span class="ac-main">${esc(it.main)}</span>
        ${it.secondary ? `<span class="ac-sec">${esc(it.secondary)}</span>` : ''}
      </div>`).join('');
    menu.hidden = items.length === 0;
    input.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    // mousedown (not click) so the pick fires before the input's blur hides the menu.
    menu.querySelectorAll('.ac-opt').forEach((el) => {
      el.onmousedown = (e) => { e.preventDefault(); pick(items[+el.dataset.i]); };
    });
  };
  const pick = (it) => {
    if (!it) return;
    input.value = it.description;
    items = []; close();
    token = (window.crypto?.randomUUID ? crypto.randomUUID() : String(Math.random())); // selection ends the session
  };

  const fetchSuggest = async (q) => {
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    try {
      const res = await fetch('/api/autocomplete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: spendBody({ input: q, sessionToken: token }), signal: ctrl.signal,
      });
      const data = await res.json();
      if (q !== lastQuery) return; // a newer keystroke already superseded this
      items = data.suggestions || []; active = -1; paint();
    } catch { /* aborted or offline — leave the box as free text */ }
  };

  input.oninput = () => {
    const q = input.value.trim();
    lastQuery = q;
    clearTimeout(debounce);
    if (isDemo() || q.length < 3) { items = []; close(); return; }
    debounce = setTimeout(() => fetchSuggest(q), 280);
  };
  input.onkeydown = (e) => {
    const open = !menu.hidden && items.length;
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Escape') { close(); }
    else if (e.key === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); pick(items[active]); }
      else { close(); runSearch(); }
    }
  };
  input.onblur = () => setTimeout(close, 120); // let a click/mousedown land first
}

// Custom search-depth dropdown: compact toggle + rich menu (coloured dot, title,
// description per tier). Native <option> can't render those, so this is hand-built.
// The chosen value lives in hidden #depth, read by runSearch.
function wireDepthPicker() {
  const dd = $('#depth-dd');
  if (!dd) return;
  const toggle = $('#depth-toggle');
  const menu = $('#depth-menu');
  const openMenu = () => { dd.classList.add('open'); menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); };
  const closeMenu = () => { dd.classList.remove('open'); menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  toggle.onclick = (e) => { e.stopPropagation(); dd.classList.contains('open') ? closeMenu() : openMenu(); };
  menu.querySelectorAll('.dd-opt').forEach((opt) => {
    opt.onclick = () => {
      $('#depth').value = opt.dataset.v;
      $('#dd-label').textContent = opt.dataset.title;
      $('#dd-dot').style.background = opt.dataset.dot;
      menu.querySelectorAll('.dd-opt').forEach((o) => o.classList.toggle('sel', o === opt));
      closeMenu();
    };
  });
  // Close on outside-click / Escape — registered once, resolves the live picker.
  if (!window.__ddWired) {
    window.__ddWired = true;
    const shut = () => {
      const el = document.getElementById('depth-dd');
      if (!el || !el.classList.contains('open')) return;
      el.classList.remove('open');
      const m = document.getElementById('depth-menu'); if (m) m.hidden = true;
      const t = document.getElementById('depth-toggle'); if (t) t.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('click', (e) => { const el = document.getElementById('depth-dd'); if (el && !el.contains(e.target)) shut(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut(); });
  }
}

// Trial/demo banner shown above search + results.
function trialBanner() {
  const p = SESSION?.profile;
  if (!p) return '';

  // BYOK: their key, their bill — the credit meter no longer applies to them.
  if (hasByok() && p.type !== 'demo') {
    return `<div class="banner banner-info mb">${ic('key')} <b>Using your own Google API key</b> — searches are unlimited and billed to your Google account. <a href="#/settings" style="color:var(--accent)">Manage key</a></div>`;
  }

  if (p.type === 'trial') {
    const left = p.remaining ?? p.searchLimit ?? 0;
    const api = p.apiRemaining;
    const credits = api === null || api === undefined
      ? ''
      : ` · <b>${api}</b> API credit${api === 1 ? '' : 's'} left`;
    // Say what this package actually includes — don't hardcode "exports disabled",
    // since packages now differ on export/share/deep.
    const perks = [];
    if (p.features?.deep) perks.push('deep search');
    if (p.features?.download) perks.push('CSV export');
    if (p.features?.share) perks.push('report sharing');
    const perkText = perks.length ? ` · includes ${perks.join(', ')}` : '';
    return `<div class="banner banner-warn mb">${ic('ticket')} <b>${esc(p.label || 'Trial account')}</b> — ${left} of ${p.searchLimit} searches left${credits} · up to ${p.resultCap} results each${perkText}.<br><span style="font-size:12.5px">Add your own Google API key in <a href="#/settings" style="color:var(--accent)">Settings</a> for unlimited searches.</span></div>`;
  }
  if (p.type === 'demo') {
    return `<div class="banner banner-warn mb">${ic('beaker')} <b>Demo mode</b> — sample data only. Log out and enter an access code for live results.</div>`;
  }
  return '';
}

// Keep the cached session profile's balances in step with what the server just
// charged us, so the banner doesn't lie until the next login.
function syncBalances(data) {
  if (!SESSION?.profile || !data) return;
  if (data.apiRemaining !== undefined) SESSION.profile.apiRemaining = data.apiRemaining;
  if (data.aiRemaining !== undefined) SESSION.profile.aiRemaining = data.aiRemaining;
  if (data.trial?.remaining !== undefined) SESSION.profile.remaining = data.trial.remaining;
  localStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));
  // Repaint the banner in place — a stale credit count is worse than none.
  const el = $('#tier-banner');
  if (el) el.innerHTML = trialBanner();
}

// Cloudflare caps a Worker invocation at 50 outbound subrequests, so a deep
// quadtree (hundreds of Google calls) can't run in one server request. The
// browser drives it instead: /api/plan hands us the root zones, then we search
// them in small batches via /api/zones, subdividing whichever come back
// saturated. Same algorithm, just orchestrated from here.
const ZONES_PER_REQUEST = 15;   // matches MAX_ZONES_PER_REQUEST on the server
const BATCHES_IN_PARALLEL = 3;

function rectSpan(r) {
  return Math.max(r.high.latitude - r.low.latitude, r.high.longitude - r.low.longitude);
}
function splitRect(r) {
  const mLat = (r.low.latitude + r.high.latitude) / 2;
  const mLng = (r.low.longitude + r.high.longitude) / 2;
  return [
    { low: { latitude: r.low.latitude, longitude: r.low.longitude }, high: { latitude: mLat, longitude: mLng } },
    { low: { latitude: r.low.latitude, longitude: mLng }, high: { latitude: mLat, longitude: r.high.longitude } },
    { low: { latitude: mLat, longitude: r.low.longitude }, high: { latitude: r.high.latitude, longitude: mLng } },
    { low: { latitude: mLat, longitude: mLng }, high: { latitude: r.high.latitude, longitude: r.high.longitude } },
  ];
}

// A zone reserves up to 3 pages server-side, all-or-nothing. With few credits
// left, a full 15-zone batch (45 calls) would be refused even though the user
// can still afford several zones — so shrink the batch to what they can pay for.
function affordableBatchSize(creditsLeft) {
  if (creditsLeft === null || creditsLeft === undefined) return ZONES_PER_REQUEST;
  return Math.max(0, Math.min(ZONES_PER_REQUEST, Math.floor(creditsLeft / 3)));
}

async function runQuadtree(keyword, location, plan, onProgress) {
  const { config } = plan;
  const found = new Map();
  let calls = 0, zonesSearched = 0, depthReached = 0, truncatedZones = 0;
  let outOfCredits = false;
  // null => unmetered (owner or BYOK). A number => credits left on our key.
  let credits = plan.byok ? null : (plan.apiRemaining ?? null);
  let frontier = plan.zones.map((rect) => ({ rect, depth: 0 }));

  outer:
  while (frontier.length && calls < config.budget) {
    const perRequest = affordableBatchSize(credits);
    if (perRequest === 0) { outOfCredits = true; truncatedZones += frontier.length; break; }

    // Chunk this level into server-sized batches, a few in parallel.
    const batches = [];
    for (let i = 0; i < frontier.length; i += perRequest) batches.push(frontier.slice(i, i + perRequest));

    const next = [];
    for (let b = 0; b < batches.length; ) {
      if (calls >= config.budget) { truncatedZones += batches.slice(b).flat().length; break; }

      // Batches in a group fire concurrently and each reserves independently, so
      // don't launch more of them than the remaining credits can cover — two
      // parallel 402s would waste a round trip and lose the zones.
      const par = credits === null
        ? BATCHES_IN_PARALLEL
        : Math.max(1, Math.min(BATCHES_IN_PARALLEL, Math.floor(credits / (perRequest * 3))));
      const group = batches.slice(b, b + par);
      b += par;

      const responses = await Promise.all(group.map(async (batch) => {
        const res = await fetch('/api/zones', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: spendBody({ keyword, location, zones: batch.map((z) => z.rect) }),
        });
        const data = await res.json();
        // Running out of credits mid-search must NOT throw away the leads we
        // already paid Google for. Stop, keep what we have, report it honestly.
        if (res.status === 402) return { batch, data, spent: true };
        if (!res.ok) throw new Error(data.error || 'Zone search failed');
        return { batch, data };
      }));

      for (const { batch, data, spent } of responses) {
        if (spent) { outOfCredits = true; truncatedZones += batch.length; continue; }
        calls += data.calls;
        zonesSearched += data.zonesSearched;
        syncBalances(data);
        // Track the server's authoritative balance so the next batch is sized
        // to what we can actually afford.
        if (credits !== null && data.apiRemaining !== null && data.apiRemaining !== undefined) {
          credits = data.apiRemaining;
        }
        for (const r of data.results) if (!found.has(r.placeId)) found.set(r.placeId, r);

        for (const idx of data.saturated) {
          const { rect, depth } = batch[idx];
          depthReached = Math.max(depthReached, depth);
          if (depth >= config.maxDepth || rectSpan(rect) < config.minSpan) { truncatedZones++; continue; }
          for (const kid of splitRect(rect)) next.push({ rect: kid, depth: depth + 1 });
        }
        for (const z of batch) depthReached = Math.max(depthReached, z.depth);
      }
      onProgress?.({ found: found.size, zonesSearched, calls });

      if (outOfCredits) {
        // `b` already points past this group, so slice(b) is exactly what's left
        // unsearched at this level. Plus every child we would have split into.
        truncatedZones += batches.slice(b).flat().length + next.length;
        break outer;
      }
    }
    frontier = next;
  }
  if (frontier.length && !outOfCredits) truncatedZones += frontier.length;

  return {
    results: [...found.values()],
    cells: zonesSearched, apiCalls: calls, depthReached,
    truncatedZones, incomplete: truncatedZones > 0, outOfCredits,
  };
}

async function runSearch() {
  const keyword = $('#kw').value.trim();
  const location = $('#loc').value.trim();
  if (!keyword || !location) return toast('Enter both a keyword and a location');
  // A named-business lookup is always one quick page — never a deep sweep.
  const depth = searchMode === 'name' ? 'quick' : (feat().deep ? ($('#depth')?.value || 'quick') : 'fast');
  // Exhaustive is the single most expensive action in the app (hundreds–1,000+
  // Google calls). It's the only search that gets a spend warning up front —
  // the city size isn't known until /api/plan, so the range is deliberately broad.
  if (depth === 'exhaustive' && !confirm(
    'Exhaustive scan visits every zone in the city and can fire hundreds — 1,000+ on a large metro — Google API calls (roughly $10–$30 est. at our rate). It finds the most leads, and is the most expensive search.\n\nRun the exhaustive scan?'
  )) return;
  const btn = $('#go');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    if (depth === 'fast' || depth === 'quick') {
      const res = await fetch('/api/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: spendBody({ keyword, location, quick: depth === 'quick' }),
      });
      const data = await res.json();
      if (res.status === 403 && data.limitReached) return toast('Trial search limit reached — ask for full access to keep searching.');
      if (res.status === 402 && data.outOfCredits) return toast(data.error);
      if (!res.ok) throw new Error(data.error || 'Search failed');
      syncBalances(data);
      if (data.trial && SESSION?.profile) {
        SESSION.profile.remaining = data.trial.remaining;
        SESSION.profile.searchesUsed = data.trial.used;
        setSession(SESSION); renderSessionFoot();
      }
      attachCompetitorStats(data.results);
      if (data.mode === 'live') recordUsage({ searches: 1, apiCalls: data.apiCalls || 0 });
      lastSearch = { keyword, location, mode: data.mode, deep: false, depth, nameMode: searchMode === 'name', results: data.results, filters: {} };
      return renderResults(lastSearch);
    }

    // --- deep / exhaustive: plan, then drive the quadtree from here ---
    btn.innerHTML = '<span class="spinner"></span> Locating city…';
    const planRes = await fetch('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: spendBody({ keyword, location, depth }),
    });
    const plan = await planRes.json();
    if (planRes.status === 402 && plan.outOfCredits) return toast(plan.error);
    if (!planRes.ok) throw new Error(plan.error || 'Could not plan the search');
    syncBalances(plan);
    if (plan.budgetCapped) {
      toast(`Only ${plan.apiRemaining} API credits left — this search will stop early.`);
    }

    if (!plan.cityResolved) {
      // Couldn't pin the city — do a fast search and tell the user why.
      const res = await fetch('/api/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: spendBody({ keyword, location }),
      });
      const data = await res.json();
      if (res.status === 402 && data.outOfCredits) return toast(data.error);
      if (!res.ok) throw new Error(data.error || 'Search failed');
      syncBalances(data);
      attachCompetitorStats(data.results);
      if (data.mode === 'live') recordUsage({ searches: 1, apiCalls: data.apiCalls || 0 });
      lastSearch = { keyword, location, mode: data.mode, deep: false, depth, cityResolved: false, results: data.results, filters: {} };
      return renderResults(lastSearch);
    }

    const q = await runQuadtree(keyword, location, plan, ({ found, zonesSearched }) => {
      btn.innerHTML = `<span class="spinner"></span> ${found} found · ${zonesSearched} zones`;
    });

    // Stamp the geocoded canonical "City, Country" on every lead (deep search already
    // resolved it in /api/plan), so saved leads store "Riyadh, Saudi Arabia", not a
    // typed "Los Angls".
    const canonCity = (plan.resolvedCity || '').trim();
    if (canonCity) q.results.forEach((r) => { r.location = canonCity; });
    attachCompetitorStats(q.results);
    q.results.sort((a, b) => b.opportunityScore - a.opportunityScore);
    // Zone calls are exact; the ~1 city-geocode call in /api/plan isn't counted
    // (negligible against a hundreds-of-call deep search).
    recordUsage({ searches: 1, apiCalls: q.apiCalls || 0 });
    lastSearch = {
      keyword, location, mode: 'live', deep: true, depth,
      cells: q.cells, apiCalls: q.apiCalls, depthReached: q.depthReached,
      incomplete: q.incomplete, truncatedZones: q.truncatedZones,
      outOfCredits: q.outOfCredits,
      cityResolved: true, resolvedCity: plan.resolvedCity, resolvedLevel: plan.resolvedLevel,
      results: q.results, filters: {},
    };
    if (q.outOfCredits) {
      toast(`Ran out of API credits — kept the ${q.results.length} leads already found.`);
    }
    renderResults(lastSearch);
  } catch (e) {
    toast('Search error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

// Benchmark every result against its market: rank by review volume + averages
// of the top competitors. Attached to each result so saved leads keep it.
function attachCompetitorStats(results) {
  const n = results.length;
  if (!n) return;
  const byReviews = [...results].sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0));
  const rank = new Map(byReviews.map((r, i) => [r.placeId, i + 1]));
  // Median over the WHOLE market — NOT a mean of the top-5. One national chain
  // (e.g. 16,000 reviews) makes a top-5 mean wildly unrepresentative: telling a
  // local shop it's "5,982 behind" reads as naive and kills the pitch. The median
  // is the honest "typical competitor" and is robust to those outliers.
  const median = (f) => {
    const xs = results.map((x) => f(x) || 0).sort((a, b) => a - b);
    const m = xs.length >> 1;
    return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
  };
  const bench = {
    marketSize: n,
    medReviews: Math.round(median((x) => x.reviewCount)),
    medRating: Math.round(median((x) => x.rating) * 10) / 10,
    medPhotos: Math.round(median((x) => x.photoCount)),
    pctWebsite: Math.round((results.filter((x) => x.website).length / n) * 100),
  };

  // A raw "4,986 behind the median" gap is useless when the market is top-heavy
  // (Google returns the most prominent businesses first, so in a big city the
  // median is thousands). Instead give a CLOSABLE next step: how many reviews to
  // overtake the next few rivals within reach. Per-business, since it depends on
  // where each one sits.
  const ascReviews = results.map((x) => x.reviewCount || 0).sort((a, b) => a - b);
  function reviewTargetFor(me) {
    if (me >= bench.medReviews) return null; // already at/above typical — no nudge
    const above = ascReviews.filter((c) => c > me);
    if (!above.length) return null;
    // Aim to overtake the next up to 3 rivals, but only ones within a believable
    // year of growth (~5x, or +500). If even the nearest rival is a huge jump,
    // bail to the plain "vs typical" line rather than promise the unreachable.
    const cap = Math.max(me * 5, me + 500);
    let target = me, passN = 0;
    for (const c of above) {
      if (passN >= 3 || c > cap) break;
      target = c; passN++;
    }
    if (!passN) return null;
    return { needed: Math.max(1, target - me), passN };
  }

  for (const r of results) {
    const myRank = rank.get(r.placeId);
    const t = reviewTargetFor(r.reviewCount || 0);
    r.competitors = { ...bench, rankByReviews: myRank, reviewTarget: t ? { ...t, toRank: Math.max(1, myRank - t.passN) } : null };
  }
}

// Combined opportunity = GMB opportunity + a headroom-scaled boost from a weak
// website. Website weakness can only ADD opportunity, never lower a lead that's
// already weak on GMB. A dead/weak site pushes a strong-GMB business up the list.
function combinedOpp(r) {
  const gmb = r.opportunityScore;
  if (!r.webAudit) return gmb;
  const webOpp = 100 - (r.webAudit.websiteScore || 0);
  return Math.min(100, Math.round(gmb + (100 - gmb) * (webOpp / 100) * 0.6));
}

function applyFilters(search) {
  const f = search.filters || {};
  return search.results.filter((r) =>
    (!f.noWebsite || !r.website) &&
    (!f.unclaimed || r.claimed === false) &&
    (!f.lowRating || (r.rating && r.rating < 4)) &&
    (!f.fewReviews || (r.reviewCount || 0) < 25) &&
    (!f.weakWeb || (r.webAudit && r.webAudit.grade && ['C', 'D', 'F'].includes(r.webAudit.grade))) &&
    (!f.hot || combinedOpp(r) >= 55)
  );
}

// Bulk-audit every listed website (concurrency-limited), then re-rank.
// Auditing every site on a big deep search (Tokyo deep = 6,137 rows) would fire
// thousands of fetches. Cap to the most valuable leads; make the cap explicit.
const AUDIT_CAP = 50;

async function auditAllWebsites(search, btn) {
  let targets = search.results.filter((r) => r.website && !r.webAudit);
  if (!targets.length) return toast('No un-audited websites to check');
  const available = targets.length;
  const capped = available > AUDIT_CAP;
  if (capped) {
    if (!confirm(`${available} un-audited sites found. Auditing them all would fire ${available} requests and take a while.\n\nAudit the top ${AUDIT_CAP} by opportunity instead? (Filter or narrow the search to reach the others.)`)) return;
    targets = [...targets].sort((a, b) => combinedOpp(b) - combinedOpp(a)).slice(0, AUDIT_CAP);
  }
  btn.disabled = true;
  const total = targets.length;
  let done = 0;
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      try {
        const res = await fetch('/api/webaudit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: r.website }),
        });
        const audit = await res.json();
        if (res.ok) r.webAudit = audit;
      } catch { /* skip failed audit, keep going */ }
      done++;
      btn.innerHTML = `<span class="spinner"></span> ${done}/${total}`;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  toast(capped
    ? `Audited the top ${done} of ${available} by opportunity — narrow your filters to audit more.`
    : `Audited ${done} websites — re-ranked by combined opportunity`);
  renderResults(search);
}

function renderResults(search) {
  // Niche sweeps rank by opportunity. A named-business lookup ranks by how closely
  // the name matches what you typed — you want the business you asked for at the
  // top, not whichever nearby match has the worst listing.
  const nameScore = (r) => {
    const n = normKey(r.name), q = normKey(search.keyword);
    if (!q) return 0;
    if (n === q) return 100;
    if (n.startsWith(q)) return 90;
    if (n.includes(q)) return 80;
    // Otherwise score on how many of the typed words appear, so a near-miss like
    // "Arham Dental Care" still outranks an unrelated "Some Other Clinic".
    const words = q.split(/\s+/).filter(Boolean);
    const hits = words.filter((w) => n.includes(w)).length;
    return words.length ? Math.round((hits / words.length) * 70) : 0;
  };
  const shown = applyFilters(search).sort(search.nameMode
    ? (a, b) => (nameScore(b) - nameScore(a)) || (combinedOpp(b) - combinedOpp(a))
    : (a, b) => combinedOpp(b) - combinedOpp(a));
  const saved = new Set(store.local().map((l) => l.id));
  const auditable = search.results.filter((r) => r.website && !r.webAudit).length;
  const audited = search.results.filter((r) => r.webAudit).length;
  $('#results').innerHTML = `
    ${search.mode === 'demo' ? `<div class="banner banner-warn mt">${ic('beaker')} Demo data (deterministic sample). Add your Google Places API key in Settings for live business data.</div>` : search.deep ? `<div class="banner ${search.resolvedLevel === 'area' || search.incomplete ? 'banner-warn' : 'banner-info'} mt">${search.depth === 'exhaustive' ? ic('signal') + ' Exhaustive scan' : ic('building') + ' Deep search'} — covered <b>${esc(search.resolvedCity || search.location)}</b>, subdividing into ${search.cells} zones (depth ${search.depthReached}) and found ${search.results.length} unique businesses.${search.incomplete ? ` <br>${ic('alertTriangle')} ${search.truncatedZones} zone${search.truncatedZones === 1 ? ' is' : 's are'} still denser than we can see — try <b>Exhaustive</b>, or search a narrower area.` : ''}${search.resolvedLevel === 'area' ? ` <br>${ic('alertTriangle')} That matched a <b>district</b>, not a whole city — add a country for full coverage (e.g. “São Paulo, Brazil”).` : ''}</div>`
      : search.cityResolved === false ? `<div class="banner banner-warn mt">${ic('alertTriangle')} Couldn't pin down “${esc(search.location)}” as a city, so we searched the top 60 instead. Add a country or state for full-city coverage — e.g. <b>Springfield, Illinois</b> or <b>Cambridge, UK</b>.</div>`
      : `<div class="banner banner-info mt">${ic('signal')} Live Google data (top 60). Switch <b>Search depth</b> to Deep for full-city coverage.</div>`}
    <div class="filter-bar">
      <span class="muted" style="font-size:13px">${shown.length} of ${search.results.length} businesses${audited ? ` · ${audited} audited` : ''}</span>
      ${chip('hot', ic('flame') + ' Hot leads (55+)', search)}
      ${chip('noWebsite', 'No website', search)}
      ${chip('unclaimed', 'Unclaimed', search)}
      ${chip('lowRating', 'Rating < 4★', search)}
      ${chip('fewReviews', '< 25 reviews', search)}
      ${audited ? chip('weakWeb', ic('globe') + ' Weak website', search) : ''}
      <span style="flex:1"></span>
      ${auditable ? `<button class="btn-sm" id="audit-all">${ic('globe')} ${auditable > AUDIT_CAP ? `Audit top ${AUDIT_CAP} websites` : `Audit all websites (${auditable})`}</button>` : ''}
      <button class="btn-ghost btn-sm" id="save-all">${ic('save')} Save all shown</button>
      ${feat().download ? `<button class="btn-ghost btn-sm" id="csv">${ic('download')} CSV</button>` : ''}
    </div>
    <div class="table-wrap">${leadsTable(shown, { saveBtn: true, saved, showWeb: audited > 0 })}</div>
  `;
  document.querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => { search.filters[c.dataset.f] = !search.filters[c.dataset.f]; renderResults(search); };
  });
  const auditAllBtn = $('#audit-all');
  if (auditAllBtn) auditAllBtn.onclick = () => auditAllWebsites(search, auditAllBtn);
  $('#save-all').onclick = async () => {
    for (const r of shown) await store.save(r);
    toast(`Saved ${shown.length} leads`);
    renderResults(search);
  };
  const csvBtn = $('#csv');
  if (csvBtn) csvBtn.onclick = () => exportCsv(shown, `${search.keyword}-${search.location}`);
  bindLeadRows(shown, search);
}

function chip(key, label, search) {
  return `<span class="chip ${search.filters[key] ? 'on' : ''}" data-f="${key}">${label}</span>`;
}

// -------- shared table
function webCell(r) {
  if (!r.website) return '<span class="badge badge-red">missing</span>';
  if (!r.webAudit) return ic('checkCircle', 'ic-ok');
  if (r.webAudit.reachable === false) return '<span class="badge badge-red">dead site</span>';
  const g = r.webAudit.grade;
  const cls = g === 'A' || g === 'B' ? 'badge-green' : g === 'C' ? 'badge-yellow' : 'badge-red';
  return `<span class="badge ${cls}">Site ${g}</span>`;
}

function oppCell(r) {
  const combined = combinedOpp(r);
  const boosted = r.webAudit && combined > r.opportunityScore;
  return `${scorePill(combined)}${boosted ? '<div class="sub" style="color:var(--accent);font-size:11px">+web</div>' : ''}`;
}

// Email found on the business's own site during the website audit. Shown so you can
// see at a glance which leads are reachable by email (run the audit to populate it).
function emailCell(r) {
  const e = leadEmail(r);
  if (!e) {
    return r.website
      ? '<span class="muted" style="font-size:12px" title="Run the website audit on this lead to look for an email.">—</span>'
      : '<span class="muted" style="font-size:12px" title="No website on this listing, so there is no email to find.">—</span>';
  }
  return `<span title="${esc(e)}" style="display:inline-block;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;font-size:12.5px">${esc(e)}</span>`;
}

function leadsTable(rows, opts = {}) {
  if (!rows.length) return '<div class="card muted">Nothing here yet.</div>';
  return `<table>
    <thead><tr>
      ${opts.selectable ? '<th style="width:30px"><input type="checkbox" class="sel-all" title="Select all"></th>' : ''}
      <th>Opportunity</th><th>Business</th><th>Rating</th><th>Reviews</th><th>Website</th><th>Email</th><th>Grade</th>${opts.saveBtn ? '<th></th>' : '<th>Status</th>'}
    </tr></thead>
    <tbody>
      ${rows.map((r, i) => `
        <tr class="row-click" data-i="${i}">
          ${opts.selectable ? `<td><input type="checkbox" class="sel-box" data-id="${esc(r.id || r.placeId)}"></td>` : ''}
          <td>${opts.saveBtn ? oppCell(r) : scorePill(r.opportunityScore)}</td>
          <td><div><b>${esc(r.name)}</b></div><div class="sub">${esc(r.address)}</div></td>
          <td>${r.rating ? r.rating + '★' : '<span class="badge badge-red">none</span>'}</td>
          <td>${r.reviewCount ?? 0}</td>
          <td>${webCell(r)}</td>
          <td>${emailCell(r)}</td>
          <td>${gradeBadge(r.grade)}</td>
          ${opts.saveBtn
            ? `<td>${opts.saved?.has(r.placeId) ? '<span class="badge badge-green">saved</span>' : `<button class="btn-sm save-one" data-i="${i}">Save</button>`}</td>`
            : `<td><span class="badge badge-blue">${STATUS_LABEL[r.status] || r.status || ''}</span></td>`}
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function bindLeadRows(rows, search) {
  document.querySelectorAll('tr.row-click').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.save-one') || e.target.closest('.sel-box')) return;
      openLeadModal(rows[Number(tr.dataset.i)]);
    });
  });
  document.querySelectorAll('.save-one').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await store.save(rows[Number(btn.dataset.i)]);
      toast('Lead saved');
      if (search) renderResults(search);
    });
  });
}

// Wire checkbox selection + bulk-delete bar (used on saved-lead tables).
function wireSelection(afterDelete) {
  const bar = $('#bulk-bar');
  if (!bar) return;
  const boxes = () => [...document.querySelectorAll('.sel-box')];
  const selectedIds = () => boxes().filter((b) => b.checked).map((b) => b.dataset.id);
  const update = () => {
    const n = selectedIds().length;
    bar.style.display = n ? 'flex' : 'none';
    const c = $('#bulk-count');
    if (c) c.textContent = `${n} selected`;
    const all = document.querySelector('.sel-all');
    if (all) {
      const bs = boxes();
      all.checked = bs.length > 0 && bs.every((b) => b.checked);
      all.indeterminate = !all.checked && bs.some((b) => b.checked);
    }
  };
  boxes().forEach((b) => (b.onchange = update));
  const all = document.querySelector('.sel-all');
  if (all) all.onchange = () => { boxes().forEach((b) => (b.checked = all.checked)); update(); };
  $('#bulk-clear').onclick = () => { boxes().forEach((b) => (b.checked = false)); update(); };
  $('#bulk-del').onclick = async () => {
    const ids = selectedIds();
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} lead${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    for (const id of ids) await store.remove(id);
    toast(`Deleted ${ids.length} lead${ids.length > 1 ? 's' : ''}`);
    afterDelete();
  };
}

function bulkBarHtml() {
  return `<div class="bulk-bar" id="bulk-bar" style="display:none">
    <span id="bulk-count">0 selected</span>
    <button class="btn-danger btn-sm" id="bulk-del">${ic('trash')} Delete selected</button>
    <button class="btn-ghost btn-sm" id="bulk-clear">Clear</button>
  </div>`;
}

// -------- website audit block (inside lead modal)
function webAuditBlock(l) {
  const w = l.webAudit;
  if (!w) {
    return `
      <div class="card mb" style="padding:14px 16px">
        <div class="flex spread">
          <div>
            <b>${ic('globe')} Website audit</b>
            <div class="muted" style="font-size:13px">Their GMB may be strong — their website is where the deal often hides.</div>
          </div>
          <button class="btn-sm" id="run-webaudit">Run website audit</button>
        </div>
      </div>`;
  }
  if (w.reachable === false) {
    return `
      <h2 style="font-size:15px">Website audit ${gradeBadge(w.grade)}</h2>
      <div class="mb">
        <div class="finding"><span class="icon">${sevIcon('critical')}</span>
          <div><div><b>${esc(w.findings[0].text)}</b></div>
          <div class="pitch">${ic('dollar','ic-pitch')} ${esc(w.findings[0].pitch)}</div></div>
        </div>
      </div>`;
  }
  const passed = w.findings.filter((f) => f.ok);
  return `
    <h2 style="font-size:15px">Website audit ${gradeBadge(w.grade)} <span class="muted" style="font-size:12px;font-weight:400">score ${w.websiteScore}/100 · ${(w.ms / 1000).toFixed(1)}s response</span></h2>
    <div class="mb">
      ${w.issues.map((f) => `
        <div class="finding">
          <span class="icon">${sevIcon(f.severity)}</span>
          <div><div>${esc(f.text)}</div>
          ${f.pitch ? `<div class="pitch">${ic('dollar','ic-pitch')} ${esc(f.pitch)}</div>` : ''}</div>
        </div>`).join('')}
      ${passed.length ? `<div class="finding"><span class="icon">${sevIcon('ok')}</span><div class="muted">${passed.length} checks passed: ${passed.map((f) => f.label).join(', ')}</div></div>` : ''}
      ${w.emails?.length ? `<div class="finding"><span class="icon">${ic('mail')}</span><div><b>Email found on site:</b> ${w.emails.map(esc).join(', ')}</div></div>` : ''}
    </div>
    ${pageSpeedBlock(l)}`;
}

// -------- PageSpeed (real Lighthouse mobile score) block
function pageSpeedBlock(l) {
  const p = l.pageSpeed;
  if (!p) {
    return `
      <div class="card mb" style="padding:14px 16px">
        <div class="flex spread">
          <div>
            <b>${ic('zap')} Mobile speed test</b>
            <div class="muted" style="font-size:13px">Real Google Lighthouse score — hard numbers for your pitch. Takes ~15s.</div>
          </div>
          <button class="btn-sm" id="run-pagespeed">Run speed test</button>
        </div>
      </div>`;
  }
  if (!p.ok) {
    return `<div class="banner banner-warn mb">${ic('zap')} Speed test unavailable: ${esc(p.error || 'failed')}</div>`;
  }
  const ring = p.score >= 90 ? 'var(--green)' : p.score >= 50 ? 'var(--yellow)' : 'var(--red)';
  const m = p.metrics || {};
  const metricRow = (label, x) => x?.value ? `<div class="flex spread" style="font-size:13px"><span class="muted">${label}</span><span>${esc(x.value)}</span></div>` : '';
  return `
    <h2 style="font-size:15px">${ic('zap')} Mobile speed ${gradeBadge(p.grade)}</h2>
    <div class="flex mb" style="align-items:center;gap:16px">
      <div class="score-pill" style="min-width:56px;font-size:20px;background:${ring}22;color:${ring}">${p.score}</div>
      <div style="flex:1;min-width:180px">
        ${metricRow('Largest Contentful Paint', m.lcp)}
        ${metricRow('Speed Index', m.si)}
        ${metricRow('Total Blocking Time', m.tbt)}
        ${metricRow('Cumulative Layout Shift', m.cls)}
      </div>
    </div>
    ${!p.finding.ok ? `<div class="finding"><span class="icon">${sevIcon(p.finding.severity)}</span><div><div>${esc(p.finding.text)}</div><div class="pitch">${ic('dollar','ic-pitch')} ${esc(p.finding.pitch)}</div></div></div>` : `<div class="finding"><span class="icon">${sevIcon('ok')}</span><div>${esc(p.finding.text)}</div></div>`}`;
}

// -------- competitor benchmark block (inside lead modal + report)
// -------- review intelligence block (derived from rating + count, no API call)
function reviewBlock(l) {
  const r = l.reviewInsight;
  if (!r) return '';
  const icon = r.tier === 'perfect' ? ic('trophy','ic-pitch') : r.tier === 'strong' ? ic('star','ic-pitch') : r.tier === 'weak' ? sevIcon('critical') : sevIcon('warning');
  return `
    <h2 style="font-size:15px">Review intelligence <span class="badge badge-muted" style="font-weight:400">estimated</span></h2>
    <div class="mb">
      <div class="finding">
        <span class="icon">${icon}</span>
        <div>
          <div>${esc(r.headline)}</div>
          <div class="pitch">${ic('dollar','ic-pitch')} ${esc(r.pitch)}</div>
        </div>
      </div>
      ${r.toTarget ? `<div class="finding"><span class="icon">${ic('trendUp')}</span><div><b>${r.toTarget.needed}</b> new 5★ reviews needed to reach ${r.toTarget.target}★</div></div>` : ''}
      ${!r.perfect && r.starDeficit ? `<div class="finding"><span class="icon">${ic('trendDown','ic-info')}</span><div class="muted">${r.starDeficit} stars short of a perfect record · derived from the public ${r.rating}★ average across ${r.count} reviews.</div></div>` : ''}
    </div>`;
}

// -------- AI review mining block (reads the actual review TEXT)
// Distinct from reviewBlock() above, which is pure arithmetic on rating+count.
// Costs Google's priciest SKU, so it's on-demand, per-lead, and cached server-side.
function miningBlock(l) {
  const m = l.reviewMining;
  if (!m) {
    const locked = !feat().deep && !isDemo(); // trials: mining is full-plan only
    return `
      <div class="card mb" style="padding:14px 16px">
        <div class="flex spread">
          <div>
            <b>${ic('sparkles')} AI review mining</b>
            <div class="muted" style="font-size:13px">Read what customers actually wrote — real complaints, in their words, to quote on the call.</div>
          </div>
          ${locked
            ? `<span class="badge badge-muted">${ic('lock')} Full plan</span>`
            : `<button class="btn-sm" id="run-mining">Mine reviews</button>`}
        </div>
      </div>`;
  }
  if (m.ok === false) {
    return `<div class="banner banner-warn mb">${ic('sparkles')} Review mining unavailable: ${esc(m.error || 'failed')}</div>`;
  }

  const themeRow = (t) => {
    const icon = t.sentiment === 'praise' ? ic('heart','ic-praise') : sevIcon('critical');
    return `
      <div class="finding">
        <span class="icon">${icon}</span>
        <div style="flex:1">
          <div><b>${esc(t.label)}</b> <span class="muted" style="font-size:12px">· ${t.count} of ${m.sampled} shown</span></div>
          ${t.quote && t.quoteVerified
            ? `<blockquote class="review-quote">“${esc(t.quote)}”
                 <cite>— ${esc(t.quoteAuthor || 'a customer')}${t.quoteRating ? `, ${t.quoteRating}★` : ''}</cite>
               </blockquote>`
            : ''}
          ${t.pitch ? `<div class="pitch">${ic('dollar','ic-pitch')} ${esc(t.pitch)}</div>` : ''}
        </div>
      </div>`;
  };

  const negativeQuotes = (m.quotes || []).filter((q) => (q.rating || 5) <= 3);
  const sourceNote =
    m.source === 'demo' ? 'Demo data — enter an access code for live review mining.'
    : m.source === 'heuristic' ? 'Keyword analysis (the AI model was unavailable) — themes are literal keyword matches.'
    : 'Read by AI.';

  return `
    <h2 style="font-size:15px">${ic('sparkles')} What customers actually say
      <span class="badge badge-muted" style="font-weight:400">${m.source === 'ai' ? 'AI-read' : m.source === 'demo' ? 'demo' : 'keyword'}</span>
    </h2>
    <p class="muted" style="font-size:13px">${esc(m.summary || '')}</p>
    <div class="mb" style="margin-top:8px">
      ${(m.themes || []).map(themeRow).join('') || `<div class="finding"><span class="icon">${sevIcon('info')}</span><div class="muted">No recurring theme found in the reviews Google exposes.</div></div>`}
    </div>
    ${negativeQuotes.length ? `
      <div class="card mb" style="padding:12px 14px">
        <div class="flex spread" style="gap:10px">
          <div><b>${ic('pen')} Sellable deliverable</b>
            <div class="muted" style="font-size:13px">Draft the owner's public reply to a negative review — something to hand over on the call.</div>
          </div>
          <button class="btn-sm" id="draft-reply">Draft a reply</button>
        </div>
      </div>` : ''}
    <p class="muted" style="font-size:12px;margin-bottom:14px">
      ${ic('alertTriangle','ic-warning')} Based on the <b>${m.sampled}</b> review${m.sampled === 1 ? '' : 's'} Google exposes${m.totalReviews ? ` of ${m.totalReviews} total` : ''} — Google returns only its “most relevant” few, which skew positive. Indicative, not exhaustive. ${sourceNote}
      ${m.cached ? ' <span title="Served from cache — no API cost">· cached</span>' : ''}
    </p>`;
}

function competitorBlock(l) {
  const c = l.competitors;
  if (!c || !c.marketSize) return '';
  const cmp = (label, you, typical, higherIsBetter = true) => {
    const behind = higherIsBetter ? (you || 0) < typical : (you || 0) > typical;
    return `<div class="finding"><span class="icon">${behind ? sevIcon('critical') : sevIcon('ok')}</span>
      <div class="flex spread" style="flex:1"><span>${label}</span>
      <span><b>${you ?? 0}</b> <span class="muted">vs ${typical} typical${behind ? ` · ${+Math.abs(typical - (you || 0)).toFixed(1)} behind` : ''}</span></span></div></div>`;
  };
  return `
    <h2 style="font-size:15px">Competitor benchmark</h2>
    <p class="muted" style="font-size:13px">Ranked <b style="color:var(--accent)">#${c.rankByReviews}</b> of ${c.marketSize} by review volume for "${esc(l.keyword)}" in ${esc(l.location)} — vs the typical competitor:</p>
    <div class="mb">
      ${c.reviewTarget
        ? `<div class="finding"><span class="icon">${sevIcon('warning')}</span><div class="flex spread" style="flex:1"><span>Reviews</span><span><b>${l.reviewCount ?? 0}</b> <span class="muted">· ~${c.reviewTarget.needed} more to pass ${c.reviewTarget.passN} rival${c.reviewTarget.passN === 1 ? '' : 's'} → #${c.reviewTarget.toRank}</span></span></div></div>`
        : cmp('Reviews', l.reviewCount, c.medReviews)}
      ${cmp('Rating', l.rating, c.medRating)}
      ${cmp('Photos', l.photoCount, c.medPhotos)}
      <div class="finding"><span class="icon">${l.website ? sevIcon('ok') : sevIcon('critical')}</span><div class="flex spread" style="flex:1"><span>Website</span><span><b>${l.website ? 'Yes' : 'No'}</b> <span class="muted">· ${c.pctWebsite}% of competitors have one</span></span></div></div>
    </div>`;
}

// -------- Demo-website: build a Google Stitch prompt from the lead's own data.
// Deterministic (no API cost) — it just assembles what we already know into a
// ready-to-paste design brief. Most valuable for no-website leads (the pitch is
// "I already built you a preview"), but available for any lead.
function buildStitchPrompt(lead) {
  const name = lead.name || 'this business';
  const category = (lead.keyword || 'local business').trim();
  const city = (lead.location || '').trim();
  const p = [];
  p.push(`Design a clean, trustworthy, mobile-first single-page marketing website for "${name}", a ${category}${city ? ` in ${city}` : ''}.`);
  p.push(`Tone: professional, local, and approachable — built to turn a phone visitor into a call.`);
  if (lead.rating && lead.reviewCount) {
    p.push(`Feature their ${lead.rating}★ rating from ${lead.reviewCount} Google reviews prominently as a trust badge near the top.`);
  }
  p.push(`Sections, in order: (1) a hero with a strong headline and a primary call-to-action button ("Call now" / "Get a free quote"); (2) a services section covering the services a ${category} typically offers; (3) a testimonials strip; (4) service area and opening hours; (5) a contact block with a phone number and a "Book now" button.`);

  // Real testimonials from mining, verbatim. Feeding these in reduces (but does
  // not eliminate — Stitch is an LLM) how much it fabricates. The import tool is
  // the guarantee; this is the "give it good input" half.
  const realQuotes = [];
  for (const t of (lead.reviewMining?.themes || [])) {
    if (t.sentiment === 'praise' && t.quote && t.quoteVerified) realQuotes.push(t.quote);
  }
  for (const q of (lead.reviewMining?.quotes || [])) {
    if ((q.rating || 0) >= 4 && q.text && !realQuotes.includes(q.text)) realQuotes.push(q.text);
  }
  const quotes = realQuotes.slice(0, 3);
  if (quotes.length) {
    p.push(`Use ONLY these real customer testimonials, verbatim, in the testimonials section — do NOT invent, embellish, or add any others:${quotes.map((q) => `\n  • "${q}"`).join('')}`);
    if (quotes.length < 3) p.push(`Only ${quotes.length} real testimonial${quotes.length === 1 ? ' is' : 's are'} available — show exactly ${quotes.length}, do not pad the section with made-up reviews.`);
  } else {
    p.push(`Do NOT invent any customer testimonials. If no real reviews are provided, omit the testimonials section entirely rather than fabricating quotes.`);
  }

  const contact = [];
  if (lead.phone) contact.push(`phone ${lead.phone}`);
  if (lead.address) contact.push(`real address "${lead.address}"`);
  else if (city) contact.push(`service area of ${city}`);
  if (contact.length) p.push(`Contact details to include exactly as given: ${contact.join(', ')}.`);
  // We only know a listing HAS hours, never the actual times — so forbid inventing them.
  p.push(lead.hasHours
    ? `Include an opening-hours block, but do NOT invent specific times — use the label "Hours: call to confirm" as a placeholder for the owner to fill in.`
    : `Do not show specific opening hours (none are known).`);

  const year = new Date().getFullYear();
  p.push(`Footer: use the current year ${year} in the copyright line (e.g. "© ${year} ${name}"). For social links, use a WhatsApp link and only standard, widely-recognised platform icons (Facebook, Instagram, WhatsApp) — never invent or use obscure icon names.`);
  p.push(`Style: modern, generous whitespace, a warm professional colour palette, large readable type, and subtle rounded cards.`);
  p.push(`Imagery: include real, high-quality photographic images (not blank placeholders, illustrations, or grey boxes) — a photographic hero image that reflects a ${category} business, and relevant photos where the design calls for them. The site should look like a finished, photographed website, not a wireframe.`);
  p.push(`Make it fully responsive and polished on BOTH mobile and desktop — this is important. On large screens, constrain the main content to a maximum width of about 1200px, centred, with section background colours running full width but their inner content centred. Use proper multi-column grid layouts on desktop (for example, show testimonials as a 2-3 column grid on desktop, NOT a horizontal-scroll carousel). Nothing should look stretched, cramped, or edge-to-edge at any screen width.`);
  return p.join(' ');
}

function demoSiteUrl(l) {
  return l.demoSiteId ? `${location.origin}/site/${l.demoSiteId}` : '';
}

function demoSiteBlock(l) {
  const noSite = !l.website;
  const url = demoSiteUrl(l);
  return `
    <div class="card mb" style="padding:14px 16px">
      <div class="flex spread" style="gap:10px">
        <div>
          <b>${ic('palette')} Demo website${noSite ? ' <span class="badge" style="background:var(--accent);color:#1a1205">best fit</span>' : ''}${url ? ' <span class="badge" style="background:var(--green);color:#04210f">published</span>' : ''}</b>
          <div class="muted" style="font-size:13px">${noSite
            ? "They have no website — the strongest pitch is “I already built you a preview.” Generate a Stitch design brief from their own data."
            : 'Generate a Google Stitch design brief for a modern replacement site, built from their own data.'}</div>
        </div>
        <button class="btn-sm" id="gen-stitch">${url ? 'New prompt' : 'Generate Stitch prompt'}</button>
      </div>
      ${url ? `
      <div class="banner banner-info" style="margin-top:12px;font-size:13px">
        ${ic('globe')} <b>Live preview:</b> <a href="${esc(url)}" target="_blank" style="color:var(--accent);word-break:break-all">${esc(url)} ↗</a>
        <div class="flex mt" style="gap:8px">
          <button class="btn-sm" id="copy-demo-url">Copy link</button>
          <button class="btn-sm btn-ghost" id="wa-demo-url">${ic('chat')} Send on WhatsApp</button>
          <button class="btn-sm btn-ghost" id="update-demo">Update / re-publish</button>
        </div>
      </div>` : ''}
    </div>`;
}

function openStitchPromptModal(lead) {
  const prompt = buildStitchPrompt(lead);
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <button class="modal-close" id="close">✕</button>
        <h2>${ic('palette')} Stitch prompt — ${esc(lead.name)}</h2>
        <p class="muted mb">Built from this lead's own Google data${lead.reviewMining ? ' and mined reviews' : ''}. Paste it into Google Stitch to generate the design, then bring the export into the Template Studio.</p>
        <div class="flex spread"><label>Design brief</label><button class="btn-ghost btn-sm" id="copy-stitch">Copy</button></div>
        <textarea class="script" id="stitch-text" rows="10">${esc(prompt)}</textarea>
        <ol class="muted" style="font-size:12.5px;margin:10px 0 0 18px;line-height:1.7">
          <li>Copy the brief above → open Stitch → paste → <b>Generate</b>.</li>
          <li>In Stitch: click <b>Export</b> (top-right) → select <b>Code to Clipboard</b> → click <b>Copy</b>.</li>
          <li>Back here, click <b>Import the export</b> below and paste (⌘V / Ctrl+V) to publish.</li>
        </ol>
        <p class="muted" style="font-size:11.5px;margin:8px 0 0">${ic('inbox')} Stitch usually copies <b>two</b> documents (a mobile and a desktop version) — that's fine, paste all of it. The importer keeps the desktop one automatically.</p>
        <div class="flex mt spread">
          <div class="flex">
            <a class="btn" href="https://stitch.withgoogle.com/" target="_blank" rel="noopener">Open Google Stitch ↗</a>
            <button class="btn-wa" id="to-import">Import the export →</button>
          </div>
          <button class="btn-ghost" id="close-bottom">✕ Close</button>
        </div>
      </div>
    </div>`;
  const back = () => openLeadModal(lead);
  $('#close').onclick = back;
  $('#close-bottom').onclick = back;
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') $('#modal-root').innerHTML = ''; };
  $('#copy-stitch').onclick = () => { navigator.clipboard.writeText($('#stitch-text').value); toast('Stitch prompt copied'); };
  $('#to-import').onclick = () => openImportSiteModal(lead);
}

// -------- Import & publish the Stitch export as a hosted /site/<id> preview.
// Stitch is a generative tool — it FABRICATES testimonials, hours, etc. So before
// publishing to a real business, we surface the lead's REAL reviews and make the
// user confirm the site uses real content. The AI makes it pretty; the human
// (with real data in front of them) makes it true.
function realReviewList(lead) {
  const out = [];
  for (const t of (lead.reviewMining?.themes || [])) {
    if (t.sentiment === 'praise' && t.quote && t.quoteVerified) out.push({ text: t.quote, who: t.quoteAuthor });
  }
  for (const q of (lead.reviewMining?.quotes || [])) {
    if ((q.rating || 0) >= 4 && q.text && !out.some((r) => r.text === q.text)) out.push({ text: q.text, who: q.author });
  }
  return out.slice(0, 5);
}

// Every real review text we have for this lead — used to tell real quotes in the
// pasted design from ones Stitch invented.
function allRealReviewTexts(lead) {
  const set = [];
  for (const q of (lead.reviewMining?.quotes || [])) if (q.text) set.push(q.text);
  for (const t of (lead.reviewMining?.themes || [])) if (t.quote) set.push(t.quote);
  return set;
}
const normQ = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The verifyQuotes() idea, applied to a whole pasted design: pull every quoted
// string out of the VISIBLE text and flag any that isn't one of this lead's real
// reviews — i.e. the ones Stitch fabricated. Deterministic; no AI HTML surgery.
function flagFabricatedQuotes(html, lead) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return []; }
  doc.querySelectorAll('script, style').forEach((e) => e.remove());
  const text = doc.body ? doc.body.textContent || '' : '';
  const real = allRealReviewTexts(lead).map(normQ).filter((r) => r.length > 8);
  const found = [];
  const seen = new Set();
  const re = /["“”'']([^"“”'\n]{20,220})["“”'']/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1].trim();
    const n = normQ(raw);
    if (n.length < 20 || seen.has(n)) continue;
    seen.add(n);
    const isReal = real.some((r) => r.includes(n) || n.includes(r));
    if (!isReal) found.push(raw);
  }
  return found.slice(0, 10);
}

// Real brand icons as inline SVG (Material Symbols has no brand logos, which is
// why Stitch emits broken names like "face_nod"). currentColor = inherits the
// link's text colour.
const SOCIAL_SVG = {
  facebook: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.49 0-1.96.93-1.96 1.89v2.25h3.32l-.53 3.49h-2.79V24C19.61 23.1 24 18.1 24 12.07z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.43.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.43.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 01-1.38-.9c-.42-.42-.68-.82-.9-1.38-.16-.43-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.43-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 00-2.13 1.38A5.9 5.9 0 00.63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.31.79.72 1.46 1.38 2.13.67.66 1.34 1.07 2.13 1.38.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.9 5.9 0 002.13-1.38 5.9 5.9 0 001.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 00-1.38-2.13A5.9 5.9 0 0019.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1018.16 12 6.16 6.16 0 0012 5.84zm0 10.16A4 4 0 1116 12a4 4 0 01-4 4zm6.41-10.4a1.44 1.44 0 11-1.44-1.44 1.44 1.44 0 011.44 1.44z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.5 0 1.47 1.08 2.9 1.23 3.1.15.2 2.12 3.24 5.14 4.54.72.31 1.28.5 1.71.64.72.23 1.38.2 1.9.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35zM12.05 21.5a9.5 9.5 0 01-4.84-1.33l-.35-.2-3.6.94.96-3.5-.23-.36a9.5 9.5 0 01-1.45-5.05c0-5.25 4.27-9.52 9.52-9.52 2.54 0 4.93.99 6.73 2.79a9.46 9.46 0 012.79 6.73c0 5.25-4.27 9.52-9.52 9.52zm8.1-17.62A11.44 11.44 0 0012.05.5C5.79.5.7 5.59.7 11.85c0 2.01.53 3.98 1.53 5.71L.6 23.5l6.08-1.59a11.4 11.4 0 005.37 1.37c6.26 0 11.35-5.09 11.35-11.35 0-3.03-1.18-5.88-3.32-8.03z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 6h-2.95a15.65 15.65 0 00-1.38-3.56A8.03 8.03 0 0118.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a7.82 7.82 0 010-4h3.38a16.5 16.5 0 000 4H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 015.08 16zm2.95-8H5.08a7.99 7.99 0 014.33-3.56A15.65 15.65 0 008.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82A15.4 15.4 0 0112 19.96zM14.34 14H9.66a14.7 14.7 0 010-4h4.68a14.7 14.7 0 010 4zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 01-4.33 3.56zM16.36 14a16.5 16.5 0 000-4h3.38a7.82 7.82 0 010 4h-3.38z"/></svg>',
};

// Which brand a footer social link is aiming at — from its href first, then its
// (often broken) icon name. Returns null for non-social links (tel:, mailto:,
// real content URLs) so they are left untouched.
function classifySocial(href, iconName) {
  const h = (href || '').toLowerCase();
  const ic = (iconName || '').toLowerCase();
  if (/^(tel:|mailto:)/.test(h)) return null;
  if (/wa\.me|whatsapp|api\.whatsapp/.test(h)) return 'whatsapp';
  if (/facebook|fb\.com|fb\.me/.test(h)) return 'facebook';
  if (/instagram/.test(h)) return 'instagram';
  if (/twitter|x\.com/.test(h)) return 'globe';
  if (/linkedin|tiktok|youtube/.test(h)) return 'globe';
  // Non-social real URL -> leave it alone.
  if (/^https?:\/\//.test(h)) return null;
  // href is "#" (placeholder) — infer from the icon name Stitch chose.
  if (/photo|camera|instagram/.test(ic)) return 'instagram';
  if (/chat|message|forum|whatsapp|comment/.test(ic)) return 'whatsapp';
  if (/face|thumb|public|facebook|share|group/.test(ic)) return 'facebook';
  return null; // unknown icon-only "#" link — don't guess
}

// A "directions card" for a map slot: real address + a Google Maps link. Used
// because a live Maps iframe can't run inside our security sandbox.
function mapCardHtml(cls, place, gradient) {
  if (!place) return `<div class="${cls}" style="width:100%;height:100%;min-height:200px;background:${gradient}"></div>`;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
  const safe = place.replace(/[<>&"]/g, '');
  return `<a href="${url}" target="_blank" rel="noopener" class="${cls}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-decoration:none;width:100%;height:100%;min-height:220px;padding:20px;text-align:center;background:${gradient};color:#1f3a5c">`
    + `${ic('pin','ic-xl')}`
    + `<span style="font-weight:700;font-size:15px;line-height:1.4">${safe}</span>`
    + `<span style="font-size:13px;font-weight:600;text-decoration:underline">Get directions on Google Maps ↗</span>`
    + `</a>`;
}

// loremflickr keyword list (literal commas — %2C breaks its parsing).
function flickrKeywords(keyword) {
  return keyword.trim().split(/\s+/).slice(0, 2).map(encodeURIComponent).join(',');
}
// A CSS `background` value that layers a real category stock photo OVER the
// gradient: if the photo loads it covers the gradient; if it's slow/blocked the
// gradient shows through — so the slot is never an empty box.
function photoBackground(keyword, gradient) {
  if (!keyword) return gradient;
  const src = `https://loremflickr.com/1200/900/${flickrKeywords(keyword)}`;
  return `url('${src}') center/cover no-repeat, ${gradient}`;
}
function photoDivHtml(cls, keyword, gradient) {
  return `<div class="${cls}" style="width:100%;height:100%;min-height:180px;background:${photoBackground(keyword, gradient)}"></div>`;
}

const getCls = (tag) => (tag.match(/class=(['"])([\s\S]*?)\1/i) || [, , ''])[2];
const isMapSlot = (tag) => /\bdata-location=/i.test(tag) || /data-alt=(['"])[^'"]*\bmap\b[^'"]*\1/i.test(tag);

// Deterministic clean-ups applied to the export before publishing:
//   - keep only the FIRST document (Stitch sometimes exports desktop+mobile)
//   - map slots -> a Google Maps directions card
//   - other placeholder images -> a real category stock photo (or gradient)
//   - broken/generic social icons -> real inline-SVG brand logos
//   - stale copyright year -> current year
// opts: { address, keyword }. Real, working content images are left as-is.
function sanitizeStitchHtml(html, opts = {}) {
  const { address = '', keyword = '' } = opts;
  const gradient = 'linear-gradient(135deg, #dbeafe 0%, #ede9fe 55%, #d1fae5 100%)';
  const year = new Date().getFullYear();

  let s = String(html);
  // Stitch often pastes SEVERAL full documents (a mobile screen AND a desktop
  // screen). Publishing them stacked looks broken. Keep just one — and prefer the
  // most desktop-responsive document (the one with the most md:/lg:/xl:
  // breakpoints), since that one also handles mobile. Stitch tends to list the
  // mobile-only version first, so "keep the first" would pick the wrong one.
  const docs = s.split(/<\/html\s*>/i).filter((d) => /<html[\s>]/i.test(d));
  if (docs.length > 1) {
    const score = (d) => (d.match(/\b(?:sm|md|lg|xl):/g) || []).length;
    const best = docs.reduce((a, b) => (score(b) > score(a) ? b : a));
    s = best + '</html>';
  }

  return s
    // MAP DIV: empty <div ... data-alt="...map..." style="background-image:placeholder"></div>
    .replace(/<div\b([^>]*?)>\s*<\/div>/gi, (m, attrs) => {
      if (!/stitch-placeholder/.test(attrs) || !isMapSlot(attrs)) return m;
      return mapCardHtml(getCls(m), address, gradient);
    })
    // MAP IMG: <img ... data-location / data-alt="...map..." ... src="...placeholder...">
    .replace(/<img\b[^>]*?stitch-placeholder[^>]*?>/gi, (m) => {
      if (isMapSlot(m)) return mapCardHtml(getCls(m), address, gradient);
      return photoDivHtml(getCls(m), keyword, gradient);
    })
    // background-image placeholder (non-map hero/decorative divs) -> stock photo
    // layered over the gradient (never empty). Explicit width/height so it fills
    // its container even without Tailwind.
    .replace(/style="([^"]*)background-image:\s*url\((['"]?)[^)]*stitch-placeholder[^)]*\2\)([^"]*)"/gi, (m, pre, q, post) => {
      const size = '; width:100%; height:100%; min-height:180px';
      return `style="${pre}background: ${photoBackground(keyword, gradient)}${size}${post}"`;
    })
    // Footer social links: icon-only <a> whose content is one material-symbols
    // span -> real brand SVG. Matches spans with EXTRA classes too (e.g.
    // "material-symbols-outlined text-primary"), and prefers the span's data-icon
    // hint over its (often broken) glyph name. classifySocial() leaves
    // tel:/content links alone.
    .replace(/<a\b([^>]*?)>\s*<span\b([^>]*?)>\s*([a-z_]+)\s*<\/span>\s*<\/a>/gi, (m, aAttrs, spanAttrs, iconText) => {
      if (!/material-symbols-outlined/.test(spanAttrs)) return m; // only icon spans
      const href = (aAttrs.match(/href=(['"])([\s\S]*?)\1/i) || [, , ''])[2];
      const dataIcon = (spanAttrs.match(/data-icon=(['"])([\s\S]*?)\1/i) || [, , ''])[2];
      const brand = classifySocial(href, dataIcon || iconText);
      if (!brand) return m;
      return `<a${aAttrs} aria-label="${brand}">${SOCIAL_SVG[brand]}</a>`;
    })
    // stale copyright year in the footer -> current year
    .replace(/(©|&copy;)(\s*)((?:19|20)\d\d)/gi, (m, sym, sp, y) => (Number(y) < year ? `${sym}${sp}${year}` : m));
}

function openImportSiteModal(lead) {
  const reviews = realReviewList(lead);
  const publishedId = lead.demoSiteId || null;
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <button class="modal-close" id="close">✕</button>
        <h2>${ic('inbox')} Import & publish — ${esc(lead.name)}</h2>
        <p class="muted mb">In Stitch, click <b>Export → Code to Clipboard → Copy</b>, then paste it below. It publishes to a private, shareable link you can send the prospect.</p>

        <div class="banner banner-warn mb" style="font-size:13px">
          ${ic('alertTriangle')} <b>Stitch invents content.</b> It commonly fabricates testimonials and opening hours. Before you send this to a real business, open the preview and make sure every review and detail is real.
          ${reviews.length
            ? `<div style="margin-top:8px">This lead's <b>real</b> reviews (use these, delete any others Stitch invented):</div>
               <ul style="margin:6px 0 0 16px">${reviews.map((r) => `<li>“${esc(r.text)}”${r.who ? ` — ${esc(r.who)}` : ''}</li>`).join('')}</ul>`
            : `<div style="margin-top:8px">We have <b>no mined reviews</b> for this lead — the site should have <b>no testimonials at all</b>. Delete any Stitch invented.</div>`}
        </div>

        <label>Stitch HTML export</label>
        <textarea class="script" id="import-html" rows="7" placeholder="Paste the HTML from Stitch → Export → Code to Clipboard → Copy…"></textarea>
        <div id="quote-check" class="mt"></div>

        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:12px;font-weight:400;font-size:13px;cursor:pointer">
          <input type="checkbox" id="import-confirm" style="width:auto;margin-top:3px">
          <span>I've checked the design and confirm it contains no invented reviews or false details — only this business's real information.</span>
        </label>

        <div class="flex mt spread">
          <button class="btn" id="publish-site" disabled>${publishedId ? 'Re-publish' : 'Publish'} preview</button>
          <button class="btn-ghost" id="close-bottom">← Back</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:6px">On publish, the grey placeholder images are swapped for a gradient automatically.</p>
        <div id="publish-result" class="mt"></div>
      </div>
    </div>`;
  $('#close').onclick = () => openLeadModal(lead);
  $('#close-bottom').onclick = () => openStitchPromptModal(lead);
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') $('#modal-root').innerHTML = ''; };

  const confirmBox = $('#import-confirm');
  const btn = $('#publish-site');
  const sync = () => { btn.disabled = !(confirmBox.checked && $('#import-html').value.trim()); };
  // Live fabrication check: flag quotes in the paste that aren't real reviews.
  const runCheck = () => {
    const html = $('#import-html').value;
    const box = $('#quote-check');
    if (!html.trim()) { box.innerHTML = ''; return; }
    const fakes = flagFabricatedQuotes(html, lead);
    if (!fakes.length) {
      box.innerHTML = `<div class="banner banner-info" style="font-size:12.5px">${ic('checkCircle','ic-ok')} No fabricated-looking quotes detected — every quoted line matches a real review (or there are none).</div>`;
    } else {
      box.innerHTML = `<div class="banner banner-warn" style="font-size:12.5px">
        ${ic('flag','ic-warning')} <b>${fakes.length} quote${fakes.length === 1 ? '' : 's'} not found in this lead's real reviews</b> — likely invented by Stitch. Delete ${fakes.length === 1 ? 'it' : 'them'} from the HTML above:
        <ul style="margin:6px 0 0 16px">${fakes.map((q) => `<li>“${esc(q.slice(0, 120))}${q.length > 120 ? '…' : ''}”</li>`).join('')}</ul>
      </div>`;
    }
  };
  confirmBox.onchange = sync;
  $('#import-html').oninput = () => { sync(); runCheck(); };

  btn.onclick = async () => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Publishing…';
    try {
      const cleaned = sanitizeStitchHtml($('#import-html').value, { address: lead.address, keyword: lead.keyword });
      const res = await fetch('/api/site', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: spendBody({ html: cleaned, name: lead.name, id: publishedId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Publish failed');
      lead.demoSiteId = data.id;
      if (await store.get(lead.placeId || lead.id)) await store.update(lead.id, { demoSiteId: data.id });
      $('#publish-result').innerHTML = `
        <div class="banner banner-info" style="font-size:13px">
          ${ic('checkCircle','ic-ok')} Published. <a href="${esc(data.url)}" target="_blank" style="color:var(--accent)"><b>${esc(data.url)}</b> ↗</a>
          <div class="flex mt"><button class="btn-sm" id="copy-site-url">Copy link</button> <a class="btn-sm btn-ghost" href="${esc(data.url)}?p=1" target="_blank">Preview</a></div>
        </div>`;
      $('#copy-site-url').onclick = () => { navigator.clipboard.writeText(data.url); toast('Preview link copied'); };
      toast('Demo site published');
    } catch (e) {
      $('#publish-result').innerHTML = `<div class="banner banner-warn" style="font-size:13px">${esc(e.message)}</div>`;
    } finally {
      btn.innerHTML = (publishedId ? 'Re-publish' : 'Publish') + ' preview';
      sync();
    }
  };
}

// -------- lead modal
async function openLeadModal(lead) {
  const savedLead = await store.get(lead.placeId || lead.id);
  const l = savedLead || lead;
  const isSaved = !!savedLead;
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <button class="modal-close" id="close">✕</button>
        <h2>${esc(l.name)}</h2>
        <p class="muted">${esc(l.address)} ${l.mapsUrl ? `· <a href="${esc(l.mapsUrl)}" target="_blank" style="color:var(--accent)">Maps ↗</a>` : ''}</p>
        <div class="flex mb mt">
          ${scorePill(l.opportunityScore)} <span class="muted" style="font-size:13px">opportunity</span>
          ${gradeBadge(l.grade)}
          ${l.phone ? `<span class="badge badge-muted">${ic('phone')} ${esc(l.phone)}</span>` : ''}
          ${l.website ? `<a class="badge badge-muted" href="${esc(l.website)}" target="_blank" style="text-decoration:none">${ic('globe')} website ↗</a>` : ''}
        </div>
        ${(() => { const sg = serviceSuggestion(l); return sg ? `<div class="banner banner-info mb" style="font-size:13px">${ic('dollar','ic-pitch')} <b>Pitch this first:</b> ${esc(sg.primary)} — ${esc(sg.reason)}${sg.secondary.length ? ` <span class="muted">· also worth offering: ${sg.secondary.map(esc).join(', ')}</span>` : ''}</div>` : ''; })()}
        <h2 style="font-size:15px">GMB audit findings</h2>
        <div class="mb">
          ${l.findings.map(normFinding).map((f) => `
            <div class="finding">
              <span class="icon">${f.ok ? sevIcon('ok') : sevIcon(f.severity)}</span>
              <div><div>${esc(f.text)} <span class="muted" style="font-size:12px">(${f.points}/${f.max} pts)</span></div>
              ${f.pitch ? `<div class="pitch">${ic('dollar','ic-pitch')} ${esc(f.pitch)}</div>` : ''}</div>
            </div>`).join('')}
        </div>
        ${l.website ? webAuditBlock(l) : ''}
        ${reviewBlock(l)}
        ${miningBlock(l)}
        ${demoSiteBlock(l)}
        ${competitorBlock(l)}
        ${isSaved ? `
          <label>Pipeline status <span id="status-fb" class="save-fb"></span></label>
          <select id="lead-status">${STATUSES.map((st) => `<option value="${st}" ${l.status === st ? 'selected' : ''}>${STATUS_LABEL[st]}</option>`).join('')}</select>
          <div class="muted" style="font-size:12px;margin-top:4px">Changes save automatically.</div>
          <label>Notes <span id="notes-fb" class="save-fb"></span></label>
          <textarea id="lead-notes" rows="3" placeholder="Call outcomes, contact name, next steps…">${esc(l.notes || '')}</textarea>` : ''}
        <!-- Prospect = pitch & close; Deliver = fulfilment once the client is won. -->
        <div class="seg no-print" style="margin-top:16px">
          <button class="seg-btn on" data-ltab="prospect">Prospect &amp; close</button>
          <button class="seg-btn" data-ltab="deliver">Deliver</button>
        </div>
        <div id="ltab-prospect" class="flex mt" style="flex-wrap:wrap">
          ${isSaved
            ? `<a class="btn" href="#/report/${encodeURIComponent(l.id)}">${ic('file')} Audit report</a>`
            : `<button id="save-lead">${ic('save')} Save lead</button>`}
          <button class="btn-wa" id="wa-quick">${ic('chat')} WhatsApp</button>
          ${(leadEmail(l) || l.website)
            ? `<button class="btn-ghost" id="email-quick">${ic('mail')} Email</button>`
            : `<button class="btn-ghost" id="email-quick" disabled title="No website on this listing, so there's no email to find — reach them by WhatsApp or phone." style="opacity:.45;cursor:not-allowed">${ic('mail')} Email</button>`}
          <button class="btn-ghost" id="outreach">${ic('mail')} Scripts</button>
        </div>
        <div id="ltab-deliver" class="mt" style="display:none">
          <p class="muted" style="font-size:12.5px;margin:0 0 10px">${ic('checkCircle')} For <b>after you've closed the client</b> — your team's fulfilment deliverables. These are drafts your team applies; LeadLion never touches the client's live listing.</p>
          <div class="flex" style="flex-wrap:wrap">
            ${isSaved
              ? `<a class="btn-ghost btn" href="#/fixplan/${encodeURIComponent(l.id)}" title="Internal fix checklist — for you, not the client">${ic('checkCircle')} Fix plan</a>`
              : `<span class="muted" style="font-size:12.5px;align-self:center">Save this lead to build its fix plan.</span>`}
            <button class="btn-ghost" id="gbp-desc" title="AI-write a Google Business Profile description to hand the client">${ic('pen')} GBP description</button>
          </div>
        </div>
        <div class="flex mt spread">
          <span></span>
          <div class="flex">
            <button class="btn-ghost" id="close-bottom">✕ Close</button>
            ${isSaved ? `<button class="btn-danger btn-sm" id="del-lead">Delete</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#close').onclick = close;
  $('#close-bottom').onclick = close;
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') close(); };

  // Prospect / Deliver tabs — scoped to the modal so they never touch the board's
  // own .seg-btn toggle elsewhere in the document.
  $('#modal-root').querySelectorAll('[data-ltab]').forEach((t) => {
    t.onclick = () => {
      $('#modal-root').querySelectorAll('[data-ltab]').forEach((x) => x.classList.toggle('on', x === t));
      // Use style.display, not [hidden]: the .flex class sets display:flex and
      // would override the hidden attribute (low-specificity UA rule).
      const pv = $('#ltab-prospect'), dv = $('#ltab-deliver');
      if (pv) pv.style.display = t.dataset.ltab === 'prospect' ? '' : 'none';
      if (dv) dv.style.display = t.dataset.ltab === 'deliver' ? '' : 'none';
    };
  });

  const auditBtn = $('#run-webaudit');
  if (auditBtn) {
    auditBtn.onclick = async () => {
      auditBtn.disabled = true;
      auditBtn.innerHTML = '<span class="spinner"></span> Auditing…';
      try {
        const res = await fetch('/api/webaudit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: l.website }),
        });
        const audit = await res.json();
        if (!res.ok) throw new Error(audit.error || 'Audit failed');
        l.webAudit = audit;
        if (isSaved) await store.update(l.id, { webAudit: audit });
        // keep search results in sync so re-opening shows the audit
        if (lastSearch?.results) {
          const r = lastSearch.results.find((x) => x.placeId === (l.placeId || l.id));
          if (r) r.webAudit = audit;
        }
        toast(`Website graded ${audit.grade} (${audit.websiteScore}/100)`);
        openLeadModal(l);
      } catch (e) {
        toast('Audit error: ' + e.message);
        auditBtn.disabled = false;
        auditBtn.textContent = 'Run website audit';
      }
    };
  }

  const psBtn = $('#run-pagespeed');
  if (psBtn) {
    psBtn.onclick = async () => {
      psBtn.disabled = true;
      psBtn.innerHTML = '<span class="spinner"></span> Testing… (~15s)';
      try {
        const res = await fetch('/api/pagespeed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: l.website }),
        });
        const ps = await res.json();
        l.pageSpeed = ps;
        if (isSaved) await store.update(l.id, { pageSpeed: ps });
        if (lastSearch?.results) {
          const r = lastSearch.results.find((x) => x.placeId === (l.placeId || l.id));
          if (r) r.pageSpeed = ps;
        }
        toast(ps.ok ? `Mobile speed: ${ps.score}/100` : 'Speed test failed');
        openLeadModal(l);
      } catch (e) {
        toast('Speed test error: ' + e.message);
        psBtn.disabled = false;
        psBtn.textContent = 'Run speed test';
      }
    };
  }

  const mineBtn = $('#run-mining');
  if (mineBtn) {
    mineBtn.onclick = async () => {
      mineBtn.disabled = true;
      mineBtn.innerHTML = '<span class="spinner"></span> Reading reviews…';
      try {
        const res = await fetch('/api/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: spendBody({ action: 'mine', placeId: l.placeId || l.id, name: l.name }),
        });
        const mining = await res.json();
        if (res.status === 402 && mining.outOfCredits) {
          toast(mining.error);
          mineBtn.disabled = false;
          mineBtn.textContent = 'Mine reviews';
          return;
        }
        if (!res.ok) throw new Error(mining.error || 'Mining failed');
        syncBalances(mining);
        // Only a live, uncached, non-demo mine actually spends a Google call.
        if (mining.source !== 'demo' && !mining.cached) recordUsage({ mines: 1 });
        l.reviewMining = mining;
        if (isSaved) await store.update(l.id, { reviewMining: mining });
        if (lastSearch?.results) {
          const r = lastSearch.results.find((x) => x.placeId === (l.placeId || l.id));
          if (r) r.reviewMining = mining;
        }
        const nComplaints = (mining.complaints || []).length;
        toast(nComplaints ? `${nComplaints} complaint theme${nComplaints === 1 ? '' : 's'} found` : 'No complaint themes in the visible reviews');
        openLeadModal(l);
      } catch (e) {
        toast('Review mining error: ' + e.message);
        mineBtn.disabled = false;
        mineBtn.textContent = 'Mine reviews';
      }
    };
  }

  const replyBtn = $('#draft-reply');
  if (replyBtn) replyBtn.onclick = () => openReplyModal(l);

  const stitchBtn = $('#gen-stitch');
  if (stitchBtn) stitchBtn.onclick = () => openStitchPromptModal(l);

  const demoUrl = demoSiteUrl(l);
  if (demoUrl) {
    const copyBtn = $('#copy-demo-url');
    if (copyBtn) copyBtn.onclick = () => { navigator.clipboard.writeText(demoUrl); toast('Preview link copied'); };
    const waBtn = $('#wa-demo-url');
    if (waBtn) waBtn.onclick = () => {
      const msg = `Hi — I put together a preview website for ${l.name}: ${demoUrl}`;
      window.open(waLink(l, msg), '_blank');
      if (!isSaved) store.save(l);
    };
    const updBtn = $('#update-demo');
    if (updBtn) updBtn.onclick = () => openImportSiteModal(l);
  }

  if (isSaved) {
    $('#lead-status').onchange = async (e) => {
      l.status = e.target.value;
      await store.update(l.id, { status: e.target.value });
      const fb = $('#status-fb');
      fb.textContent = `✓ Moved to ${STATUS_LABEL[e.target.value]}`;
      fb.classList.add('show');
      toast(`Moved to ${STATUS_LABEL[e.target.value]}`);
      setTimeout(() => fb.classList.remove('show'), 2500);
      // Keep the board/list behind the modal in sync (modal lives in #modal-root,
      // so re-rendering #main via viewLeads doesn't close it). Matches drag-drop.
      if (location.hash.includes('/leads')) viewLeads();
    };
    $('#lead-notes').onblur = async (e) => {
      l.notes = e.target.value;
      await store.update(l.id, { notes: e.target.value });
      const fb = $('#notes-fb');
      fb.textContent = '✓ Saved';
      fb.classList.add('show');
      setTimeout(() => fb.classList.remove('show'), 2000);
    };
    $('#del-lead').onclick = async () => { await store.remove(l.id); toast('Lead deleted'); close(); render(); };
  } else {
    $('#save-lead').onclick = async () => { await store.save(l); toast('Lead saved — audit report unlocked'); openLeadModal(l); };
  }
  $('#outreach').onclick = () => openOutreachModal(l);
  if ($('#gbp-desc')) $('#gbp-desc').onclick = () => openGbpModal(l);
  $('#wa-quick').onclick = () => {
    if (!isSaved) store.save(l); // saving is cheap; keeps a record of who you contacted
    openWhatsApp(l);
  };
  $('#email-quick').onclick = () => {
    if (!isSaved) store.save(l);
    openEmail(l);
  };
}

// Open the user's mail client pre-filled with the cold email. Marks 'contacted'.
function openEmail(lead) {
  const { email } = buildOutreach(lead);
  const to = leadEmail(lead);
  window.location.href = mailtoLink(lead, email);
  toast(to ? `Opening email to ${to}` : 'Opening email — add the recipient (run the website audit to find it)');
  store.get(lead.placeId || lead.id).then((saved) => {
    if (saved && saved.status === 'new') store.update(saved.id, { status: 'contacted' });
  });
}

// Open WhatsApp with the pre-filled message. Marks the lead 'contacted'.
function openWhatsApp(lead) {
  const { whatsapp } = buildOutreach(lead);
  const num = waNumber(lead);
  window.open(waLink(lead, whatsapp), '_blank');
  if (!num) toast('Opened WhatsApp — pick the contact (no number on this listing)');
  else toast('Opened WhatsApp with your message');
  // best-effort: mark contacted if it's a saved lead
  store.get(lead.placeId || lead.id).then((saved) => {
    if (saved && saved.status === 'new') store.update(saved.id, { status: 'contacted' });
  });
}

function openOutreachModal(lead) {
  const { email, call, whatsapp } = buildOutreach(lead);
  const num = waNumber(lead);
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <button class="modal-close" id="close">✕</button>
        <h2>Outreach — ${esc(lead.name)}</h2>
        <p class="muted mb">Personalized from this business's actual audit findings.</p>

        <div class="flex spread"><label>${ic('chat')} WhatsApp message ${num ? `<span class="muted">→ ${esc(lead.phoneIntl || lead.phone || '')}</span>` : '<span class="muted">(no number — you’ll pick the contact)</span>'}</label><button class="btn-ghost btn-sm" data-copy="wa">Copy</button></div>
        <textarea class="script" id="script-wa" rows="9">${esc(whatsapp)}</textarea>
        <button class="btn-wa mt" id="wa-send" style="width:100%">${ic('chat')} Open in WhatsApp with this message</button>

        ${lead.webAudit?.emails?.length ? `<div class="banner banner-info mt">${ic('mail')} Send email to: <b>${lead.webAudit.emails.map(esc).join(', ')}</b> <span class="muted">(found on their website)</span> <span id="email-verify" style="font-size:12px"></span></div>` : ''}
        <div class="flex spread mt"><label>Cold email</label><div class="flex" style="gap:6px">
          <select id="email-angle" class="flt" style="width:auto;min-width:0;padding:5px 9px;font-size:12.5px" title="Email angle — auto-picked from whether they have a website">
            ${Object.entries(ANGLE_LABEL).map(([k, v]) => `<option value="${k}" ${outreachAngle(lead) === k ? 'selected' : ''}>Angle: ${esc(v)}</option>`).join('')}
          </select>
          <button class="btn-ghost btn-sm" id="email-ai" title="Rewrite this email with AI around the lead's pain points">${ic('sparkles')} Write with AI</button><button class="btn-ghost btn-sm" data-copy="email">Copy</button></div></div>
        <textarea class="script" id="script-email" rows="11">${esc(email)}</textarea>
        <button class="btn mt" id="email-send" style="width:100%">${ic('mail')} Open in email${leadEmail(lead) ? ` — to ${esc(leadEmail(lead))}` : ' (add the recipient)'}</button>
        ${leadEmail(lead) ? ''
          : lead.website
            ? `<p class="muted" style="font-size:12px;margin-top:4px">No email found yet — run the website audit on this lead to pull their contact address, or add it in your mail app.</p>`
            : `<p class="muted" style="font-size:12px;margin-top:4px">${ic('alertTriangle','ic-warning')} This listing has no website, so there's no email to find. Reach them by WhatsApp or phone — or paste an address you found elsewhere.</p>`}
        <div class="flex spread mt"><label>Phone script</label><button class="btn-ghost btn-sm" data-copy="call">Copy</button></div>
        <textarea class="script" id="script-call" rows="11">${esc(call)}</textarea>
        <button class="btn-ghost mt" id="close-bottom" style="width:100%">✕ Close</button>
      </div>
    </div>`;
  $('#close').onclick = () => openLeadModal(lead);
  $('#close-bottom').onclick = () => openLeadModal(lead);
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') $('#modal-root').innerHTML = ''; };
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      navigator.clipboard.writeText($(`#script-${b.dataset.copy}`).value);
      toast('Copied to clipboard');
    };
  });
  const markContacted = () => store.get(lead.placeId || lead.id).then((saved) => {
    if (saved && saved.status === 'new') store.update(saved.id, { status: 'contacted' });
  });
  // send whatever the user edited in the textarea
  $('#wa-send').onclick = () => {
    window.open(waLink(lead, $('#script-wa').value), '_blank');
    toast(num ? 'Opened WhatsApp' : 'Opened WhatsApp — pick the contact');
    markContacted();
  };
  // open the user's mail client pre-filled with the edited email text
  $('#email-send').onclick = () => {
    window.location.href = mailtoLink(lead, $('#script-email').value);
    toast(leadEmail(lead) ? `Opening email to ${leadEmail(lead)}` : 'Opening email — add the recipient');
    markContacted();
  };
  // Check the found address is worth sending to (free DNS/MX lookup — no Google
  // call). We verify the DOMAIN's mail setup, not the mailbox, and say so.
  const vEl = $('#email-verify');
  const vAddr = leadEmail(lead);
  if (vEl && vAddr) {
    vEl.textContent = '· checking…';
    vEl.className = 'muted';
    fetch('/api/verifyemail', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: vAddr, code: accessCode() }),
    })
      .then((r) => r.json())
      .then((d) => {
        const tone = { deliverable: 'ic-ok', risky: 'ic-warning', undeliverable: 'ic-bad', invalid: 'ic-bad' }[d.status] || 'muted';
        const mark = d.status === 'deliverable' ? '✓' : d.status === 'unknown' ? '' : '⚠';
        vEl.className = tone === 'muted' ? 'muted' : '';
        vEl.style.color = { 'ic-ok': 'var(--green, #34d399)', 'ic-warning': '#fbbf24', 'ic-bad': '#f87171' }[tone] || '';
        vEl.textContent = `· ${mark} ${d.label || ''}`.trim();
        vEl.title = 'We check the domain\'s mail server, not the individual mailbox.';
      })
      .catch(() => { vEl.textContent = ''; });
  }

  // AI cold-email: rewrite the email box around this lead's real pain points.
  const aiBtn = $('#email-ai');
  if (aiBtn) aiBtn.onclick = async () => {
    const box = $('#script-email');
    const label = aiBtn.innerHTML;
    aiBtn.disabled = true; aiBtn.innerHTML = '<span class="spinner"></span> Writing…';
    try {
      const s = getSettings();
      const res = await fetch('/api/copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'coldEmail', code: accessCode(), lead: copyLeadPayload(lead),
          service: serviceSuggestion(lead)?.primary,
          angle: $('#email-angle')?.value,
          agency: { name: s.agencyName, phone: s.agencyPhone, email: s.agencyEmail },
        }),
      });
      const data = await res.json();
      if (res.status === 402 || data.outOfCredits) { toast(data.error || 'Out of AI credits.'); return; }
      if (data.text && data.source === 'ai') { box.value = data.text; toast('Rewrote the email with AI — review before sending.'); }
      else toast('AI unavailable right now — kept the template.');
    } catch { toast('Could not reach the AI — kept the template.'); }
    finally { aiBtn.disabled = false; aiBtn.innerHTML = label; }
  };
}

// GBP description — an AI-written Google Business Profile "About" the agency hands
// the client (a fixing-module deliverable). Generates on open; regenerate on demand.
function openGbpModal(lead) {
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <button class="modal-close" id="close">✕</button>
        <h2>${ic('pen')} GBP description — ${esc(lead.name)}</h2>
        <p class="muted mb">A Google Business Profile description in the business's voice. Paste into <b>GBP → Edit profile → About</b>.</p>
        <div class="banner banner-warn mb" style="font-size:13px">${ic('alertTriangle')} AI can drift — read it and make sure every detail is true for this business before publishing.</div>
        <div class="flex spread"><label>Description <span class="muted" id="gbp-count"></span></label><button class="btn-ghost btn-sm" id="gbp-copy">Copy</button></div>
        <textarea class="script" id="gbp-text" rows="8" placeholder="Generating…"></textarea>
        <div class="muted" style="font-size:12px;margin-top:4px" id="gbp-note"></div>
        <div class="flex mt spread">
          <button id="gbp-regen">↻ Regenerate</button>
          <button class="btn-ghost" id="close-bottom">✕ Close</button>
        </div>
      </div>
    </div>`;
  const back = () => openLeadModal(lead);
  $('#close').onclick = back;
  $('#close-bottom').onclick = back;
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') $('#modal-root').innerHTML = ''; };
  $('#gbp-copy').onclick = () => { navigator.clipboard.writeText($('#gbp-text').value); toast('Description copied'); };

  async function generate() {
    const box = $('#gbp-text');
    const note = $('#gbp-note');
    const btn = $('#gbp-regen');
    box.value = ''; box.placeholder = 'Writing…'; btn.disabled = true;
    try {
      const res = await fetch('/api/copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'gbpDescription', code: accessCode(), lead: copyLeadPayload(lead), service: serviceSuggestion(lead)?.primary }),
      });
      const data = await res.json();
      if (res.status === 402 || data.outOfCredits) { box.placeholder = 'Out of AI credits.'; note.textContent = data.error || ''; return; }
      box.value = data.text || '';
      $('#gbp-count').textContent = `${(data.text || '').length} chars`;
      note.textContent = data.source === 'ai' ? 'Written by AI. Edit before publishing.' : 'Template draft (the AI model was unavailable). Edit before publishing.';
    } catch (e) {
      box.placeholder = 'Could not generate a description.';
      note.textContent = e.message;
    } finally { btn.disabled = false; }
  }
  $('#gbp-regen').onclick = generate;
  generate();
}

// -------- review reply drafting (the deliverable you hand over on the call)
// The owner posts these publicly, so they are written in the BUSINESS's voice,
// never the agency's — and always reviewed by a human before posting.
const REPLY_TONES = [
  'warm, professional, sincere',
  'brief and matter-of-fact',
  'apologetic and accountable',
];

function openReplyModal(lead, selected = 0, tone = REPLY_TONES[0]) {
  const quotes = (lead.reviewMining?.quotes || []).filter((q) => (q.rating || 5) <= 3);
  if (!quotes.length) { toast('No negative reviews to reply to'); return; }
  const q = quotes[Math.min(selected, quotes.length - 1)];

  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal">
        <button class="modal-close" id="close">✕</button>
        <h2>Draft a review reply — ${esc(lead.name)}</h2>
        <p class="muted mb">Written in the owner's voice, for them to post publicly. Always read it before it goes live.</p>

        ${quotes.length > 1 ? `
          <label>Which review?</label>
          <select id="reply-pick">
            ${quotes.map((x, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${x.rating}★ — ${esc(x.text.slice(0, 70))}${x.text.length > 70 ? '…' : ''}</option>`).join('')}
          </select>` : ''}

        <blockquote class="review-quote" style="margin:14px 0">“${esc(q.text)}”
          <cite>— ${esc(q.author)}, ${q.rating}★${q.when ? ` · ${esc(q.when)}` : ''}</cite>
        </blockquote>

        <label>Tone</label>
        <select id="reply-tone">
          ${REPLY_TONES.map((t) => `<option value="${esc(t)}" ${t === tone ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>

        <div class="flex spread mt"><label>Suggested reply</label><button class="btn-ghost btn-sm" id="copy-reply">Copy</button></div>
        <textarea class="script" id="reply-text" rows="7" placeholder="Generating…"></textarea>
        <div class="muted" style="font-size:12px;margin-top:4px" id="reply-note"></div>

        <div class="flex mt spread">
          <button id="regen-reply">↻ Regenerate</button>
          <button class="btn-ghost" id="close-bottom">✕ Close</button>
        </div>
      </div>
    </div>`;

  const back = () => openLeadModal(lead);
  $('#close').onclick = back;
  $('#close-bottom').onclick = back;
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') $('#modal-root').innerHTML = ''; };
  $('#copy-reply').onclick = () => { navigator.clipboard.writeText($('#reply-text').value); toast('Reply copied'); };
  if ($('#reply-pick')) $('#reply-pick').onchange = (e) => openReplyModal(lead, Number(e.target.value), $('#reply-tone').value);
  $('#reply-tone').onchange = (e) => generate(e.target.value);
  $('#regen-reply').onclick = () => generate($('#reply-tone').value);

  async function generate(t) {
    const box = $('#reply-text');
    const note = $('#reply-note');
    const btn = $('#regen-reply');
    if (!box) return;
    box.value = '';
    box.placeholder = 'Writing…';
    btn.disabled = true;
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reply', tone: t, businessName: lead.name,
          review: { text: q.text, rating: q.rating, author: q.author },
          code: accessCode(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Draft failed');
      box.value = data.text;
      note.textContent = data.source === 'ai'
        ? 'Written by AI. Edit before posting.'
        : 'Template draft (the AI model was unavailable). Edit before posting.';
    } catch (e) {
      box.placeholder = 'Could not generate a draft.';
      note.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }
  generate(tone);
}

// -------- my leads (pipeline)
let leadsView = 'board'; // 'board' | 'list'
let leadsFilter = { city: '', country: '', niche: '', temp: '', noWebsite: false, unclaimed: false, hasEmail: false }; // My Leads segment filter

// Lead temperature = agency-facing priority, from combinedOpp (same thresholds as
// the map legend, dashboard tiles and the search "Hot leads" chip). Hot = the
// weakest listings = the easiest sell.
const tempOf = (l) => { const o = combinedOpp(l); return o >= 55 ? 'hot' : o >= 30 ? 'warm' : 'cold'; };

// Niche = Google's real business category, NOT the raw search term. A search for a
// business name ("Dear You") would otherwise pollute the niche list with a name;
// its category ("Cafe") is the true niche. Fall back to the search term only if a
// lead has no category.
const nicheOf = (l) => l.category || l.keyword || 'Uncategorised';

// Leads store the raw search string ("Riyadh", "riyadh", "Austin TX"), so the same
// place/niche typed with different casing would otherwise appear as separate filter
// options, each matching only its exact-cased leads. normKey() is the match key;
// groupCI() dedupes case/whitespace-insensitively and returns one tidy label per
// group (best-cased variant, lightly title-cased but preserving codes like TX/UK).
const normKey = (s) => String(s == null ? '' : s).trim().toLowerCase();
// Split a stored "City, Country" location into parts. Old leads may be bare "City"
// (no country) — country comes back '' then.
const parseLoc = (loc) => {
  const parts = String(loc == null ? '' : loc).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { city: '', country: '' };
  if (parts.length === 1) return { city: parts[0], country: '' };
  return { city: parts[0], country: parts[parts.length - 1] };
};
const smartTitle = (s) => String(s).trim().replace(/\S+/g, (w) => {
  if (w.length <= 3 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w; // codes: TX, UK, UAE
  const rest = w.slice(1);
  if (rest !== rest.toLowerCase() && rest !== rest.toUpperCase()) return w; // already mixed: McDonald
  return w.charAt(0).toUpperCase() + rest.toLowerCase();
});
function groupCI(values) {
  const groups = new Map(); // normalized key -> [original variants]
  for (const raw of values) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const upperCount = (s) => (s.match(/[A-Z]/g) || []).length;
  return [...groups.entries()]
    // Pick the most-capitalized variant (keeps the user's "Austin TX" over "austin tx"),
    // then normalize its casing for a consistent label.
    .map(([key, variants]) => ({ key, label: smartTitle(variants.slice().sort((a, b) => upperCount(b) - upperCount(a))[0]) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function viewLeads() {
  const allLeads = await store.list();
  // Segment the pipeline by location + niche — an agency running many cities/niches
  // accumulates hundreds of leads here; the filter makes that pile usable.
  const niches = groupCI(allLeads.map(nicheOf));
  // Linked Country + City filters, both derived from the stored "City, Country".
  // Distinct (city, country) pairs; `spread` tracks how many countries share a city
  // name (to disambiguate e.g. two "Hyderabad"s when no country is picked).
  const pairMap = new Map();
  const spread = {};
  for (const l of allLeads) {
    const p = parseLoc(l.location);
    if (!p.city) continue;
    const ck = normKey(p.city), nk = normKey(p.country);
    (spread[ck] = spread[ck] || new Set()).add(nk);
    const id = ck + '|' + nk;
    if (!pairMap.has(id)) pairMap.set(id, { cityKey: ck, cityLabel: smartTitle(p.city), countryKey: nk, countryLabel: p.country ? smartTitle(p.country) : '' });
  }
  const pairs = [...pairMap.values()];
  const countryMap = new Map();
  for (const p of pairs) if (p.countryKey) countryMap.set(p.countryKey, p.countryLabel);
  const countryOpts = [...countryMap.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  // City options honour the selected country; when none is picked, a duplicated city
  // name gets its country appended so the two are distinguishable.
  const cityMap = new Map();
  for (const p of pairs) {
    if (leadsFilter.country && p.countryKey !== leadsFilter.country) continue;
    const value = p.cityKey + '|' + p.countryKey;
    if (cityMap.has(value)) continue;
    const dup = !leadsFilter.country && spread[p.cityKey] && spread[p.cityKey].size > 1 && p.countryLabel;
    cityMap.set(value, { value, cityKey: p.cityKey, countryKey: p.countryKey, label: dup ? `${p.cityLabel} — ${p.countryLabel}` : p.cityLabel });
  }
  const cityOpts = [...cityMap.values()].sort((a, b) => a.label.localeCompare(b.label));
  // Segment by country + city + niche; temperature counts are computed within that
  // segment (so "Hot 4" means 4 hot leads in the current view).
  const segLeads = allLeads.filter((l) => {
    const { city, country } = parseLoc(l.location);
    return (!leadsFilter.country || normKey(country) === leadsFilter.country)
      && (!leadsFilter.city || normKey(city) === leadsFilter.city)
      && (!leadsFilter.niche || normKey(nicheOf(l)) === leadsFilter.niche);
  });
  const tempCounts = { hot: 0, warm: 0, cold: 0 };
  const flagCounts = { noWebsite: 0, unclaimed: 0, hasEmail: 0 };
  for (const l of segLeads) {
    tempCounts[tempOf(l)]++;
    if (!l.website) flagCounts.noWebsite++;
    if (l.claimed === false) flagCounts.unclaimed++;
    if (leadEmail(l)) flagCounts.hasEmail++;
  }
  const leads = segLeads.filter((l) =>
    (!leadsFilter.temp || tempOf(l) === leadsFilter.temp) &&
    (!leadsFilter.noWebsite || !l.website) &&
    (!leadsFilter.unclaimed || l.claimed === false) &&
    (!leadsFilter.hasEmail || !!leadEmail(l)));
  const showFilters = allLeads.length > 0;
  // Leads saved before the canonical-city change store a bare city (no country).
  // The cleanup button re-geocodes them; only offered to full accounts (needs a key).
  const needsFix = allLeads.filter((l) => l.location && !parseLoc(l.location).country).length;
  const filtered = leadsFilter.city || leadsFilter.country || leadsFilter.niche || leadsFilter.temp || leadsFilter.noWebsite || leadsFilter.unclaimed || leadsFilter.hasEmail;
  const tempChip = (key, label, color) =>
    `<span class="chip ${leadsFilter.temp === key ? 'on' : ''}" data-temp="${key}"><span class="dot" style="background:${color}"></span>${label} ${tempCounts[key]}</span>`;
  // Independent toggles (combine with each other and with a temperature) — target
  // the highest-opportunity leads first. `claimed` is a heuristic (Places has no
  // claim field), so "Unclaimed" is a targeting hint, not a verified fact.
  const flagChip = (key, label) =>
    `<span class="chip ${leadsFilter[key] ? 'on' : ''}" data-flag="${key}">${label} ${flagCounts[key]}</span>`;
  const filterBar = showFilters ? `
    <div class="filter-bar" style="margin:16px 0 6px">
      ${niches.length > 1 ? `<select id="flt-niche" class="flt"><option value="">All niches</option>${niches.map((o) => `<option value="${esc(o.key)}" ${leadsFilter.niche === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}
      ${countryOpts.length >= 1 ? `<select id="flt-country" class="flt"><option value="" ${!leadsFilter.country ? 'selected' : ''}>All countries</option>${countryOpts.map((o) => `<option value="${esc(o.key)}" ${leadsFilter.country === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}
      ${(cityOpts.length > 1 || (leadsFilter.country && cityOpts.length >= 1)) ? `<select id="flt-city" class="flt"><option value="" ${!leadsFilter.city ? 'selected' : ''}>All cities</option>${cityOpts.map((o) => `<option value="${esc(o.value)}" ${(leadsFilter.city === o.cityKey && leadsFilter.country === o.countryKey) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}
      ${tempChip('hot', 'Hot', '#f87171')}${tempChip('warm', 'Warm', '#fbbf24')}${tempChip('cold', 'Cold', '#34d399')}
      ${flagChip('noWebsite', ic('globe') + ' No website')}${flagChip('unclaimed', 'Unclaimed')}${flagChip('hasEmail', ic('mail') + ' Has email')}
      <span class="muted" style="font-size:12.5px">${leads.length} of ${allLeads.length} leads</span>
      ${filtered ? `<button class="btn-ghost btn-sm" id="flt-clear">Clear</button>` : ''}
    </div>` : '';
  $('#main').innerHTML = `
    <div class="flex spread">
      <div><h1>My Leads</h1><p class="subtitle">${leadsView === 'board' ? 'Open a lead to move it through your pipeline.' : 'Select leads to delete in bulk, or open one to manage it.'}</p></div>
      <div class="flex no-print">
        ${allLeads.length ? `<div class="seg">
          <button class="seg-btn ${leadsView === 'board' ? 'on' : ''}" data-view="board">▦ Board</button>
          <button class="seg-btn ${leadsView === 'list' ? 'on' : ''}" data-view="list">☰ List</button>
        </div>` : ''}
        ${(feat().deep && needsFix) ? `<button class="btn-ghost btn-sm" id="loc-cleanup" title="Re-resolve older leads' locations to City, Country">${ic('globe')} Fix ${needsFix} location${needsFix === 1 ? '' : 's'}</button>` : ''}
        ${feat().download ? `<button class="btn-ghost btn-sm" id="csv-all" ${leads.length ? '' : 'disabled'}>${ic('download')} Export CSV</button>` : ''}
      </div>
    </div>
    ${filterBar}
    ${allLeads.length === 0
      ? `<div class="card muted">No saved leads yet. <a href="#/find" style="color:var(--accent)">Find some →</a></div>`
      : leads.length === 0
      ? `<div class="card muted">No leads match this filter. <a id="flt-clear-empty" style="color:var(--accent);cursor:pointer">Clear filter</a></div>`
      : leadsView === 'list'
        ? `${bulkBarHtml()}<div class="table-wrap">${leadsTable(leads, { selectable: true })}</div>`
        : `<div class="pipeline">
          ${STATUSES.map((st) => {
            const col = leads.filter((l) => (l.status || 'new') === st);
            return `<div class="pipe-col" data-status="${st}"><h3>${STATUS_LABEL[st]} · <span class="pipe-count">${col.length}</span></h3>
              <div class="pipe-drop">${col.map((l) => `
                <div class="lead-card" draggable="true" data-id="${esc(l.id)}">
                  <div class="name">${esc(l.name)}${l.demoSiteId ? ` <span title="Demo website published">${ic('globe')}</span>` : ''}</div>
                  <div class="meta"><span>${esc(l.keyword || '')}</span>${scorePill(l.opportunityScore)}</div>
                </div>`).join('')}</div>
            </div>`;
          }).join('')}
        </div>`}
  `;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.onclick = () => { leadsView = b.dataset.view; viewLeads(); };
  });
  if ($('#flt-niche')) $('#flt-niche').onchange = (e) => { leadsFilter.niche = e.target.value; viewLeads(); };
  // Pick a country → narrow cities to it (and reset the city choice).
  if ($('#flt-country')) $('#flt-country').onchange = (e) => { leadsFilter.country = e.target.value; leadsFilter.city = ''; viewLeads(); };
  // Pick a city → auto-set its country (the option value carries "cityKey|countryKey").
  if ($('#flt-city')) $('#flt-city').onchange = (e) => {
    const v = e.target.value;
    if (!v) { leadsFilter.city = ''; } // "All cities" — keep any country filter
    else { const [ck, nk] = v.split('|'); leadsFilter.city = ck; leadsFilter.country = nk; }
    viewLeads();
  };
  document.querySelectorAll('[data-flag]').forEach((c) => {
    c.onclick = () => { leadsFilter[c.dataset.flag] = !leadsFilter[c.dataset.flag]; viewLeads(); };
  });
  document.querySelectorAll('[data-temp]').forEach((c) => {
    c.onclick = () => { leadsFilter.temp = leadsFilter.temp === c.dataset.temp ? '' : c.dataset.temp; viewLeads(); };
  });
  const clearFilter = () => { leadsFilter = { city: '', country: '', niche: '', temp: '', noWebsite: false, unclaimed: false, hasEmail: false }; viewLeads(); };
  if ($('#flt-clear')) $('#flt-clear').onclick = clearFilter;
  if ($('#flt-clear-empty')) $('#flt-clear-empty').onclick = clearFilter;
  document.querySelectorAll('.lead-card').forEach((c) => {
    c.onclick = async () => openLeadModal(await store.get(c.dataset.id));
    // Kanban drag: a drag does NOT fire click, so open-on-click still works.
    c.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', c.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      c.classList.add('dragging');
    };
    c.ondragend = () => c.classList.remove('dragging');
  });
  if (leadsView === 'board') wireBoardDrop();
  if (leadsView === 'list') { bindLeadRows(leads); wireSelection(viewLeads); }
  const csvBtn = $('#csv-all');
  if (csvBtn) csvBtn.onclick = () => exportCsv(leads, 'leadlion-pipeline');
  if ($('#loc-cleanup')) $('#loc-cleanup').onclick = cleanupLocations;
}

// One-time maintenance: re-geocode leads saved before the canonical-city change
// (bare "Riyadh", typo'd "Los Angls") to "City, Country". Geocodes each UNIQUE
// location once — not per lead — then writes every changed lead in a single persist.
async function cleanupLocations() {
  const all = await store.list();
  const candidates = all.filter((l) => l.location && !parseLoc(l.location).country);
  if (!candidates.length) return toast('All saved locations already include a country.');

  // Unique original strings to resolve; keep the first-seen casing for the API call.
  const origByKey = new Map();
  for (const l of candidates) { const k = normKey(l.location); if (!origByKey.has(k)) origByKey.set(k, l.location.trim()); }
  const uniq = [...origByKey.keys()];
  if (!confirm(`Re-resolve ${uniq.length} unique location${uniq.length === 1 ? '' : 's'} (${candidates.length} lead${candidates.length === 1 ? '' : 's'}) to "City, Country"?\n\nUses about ${uniq.length} Google call${uniq.length === 1 ? '' : 's'}.`)) return;

  const btn = $('#loc-cleanup');
  if (btn) btn.disabled = true;
  const resolved = new Map(); // normKey -> "City, Country"
  const queue = uniq.slice();
  let done = 0, failed = 0, stop = false;

  const worker = async () => {
    while (queue.length && !stop) {
      const k = queue.shift();
      try {
        const res = await fetch('/api/geocode', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: spendBody({ location: origByKey.get(k) }),
        });
        const data = await res.json();
        if (res.status === 402 || data.outOfCredits) { stop = true; toast('Ran out of API credits — stopping.'); break; }
        // Only accept a result that actually gained a country.
        if (data.ok && data.label && parseLoc(data.label).country) resolved.set(k, data.label);
        else failed++;
      } catch { failed++; }
      done++;
      if (btn) btn.innerHTML = `<span class="spinner"></span> ${done}/${uniq.length}`;
    }
  };
  await Promise.all([worker(), worker(), worker()]); // small concurrency

  const updates = [];
  for (const l of candidates) {
    const label = resolved.get(normKey(l.location));
    if (label && label !== l.location) updates.push({ id: l.id, patch: { location: label } });
  }
  if (done) recordUsage({ apiCalls: done }); // these ARE real geocode calls (unlike the incidental one during a search)
  const n = updates.length ? await store.bulkUpdate(updates) : 0;
  toast(`Updated ${n} lead${n === 1 ? '' : 's'} across ${resolved.size} location${resolved.size === 1 ? '' : 's'}${failed ? ` · ${failed} couldn't be resolved` : ''}.`);
  viewLeads();
}

// Kanban drop targets: each column accepts a dragged card and re-stages the lead.
function wireBoardDrop() {
  document.querySelectorAll('.pipe-col').forEach((col) => {
    const status = col.dataset.status;
    col.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drag-over'); };
    col.ondragleave = (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); };
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const lead = await store.get(id);
      if (!lead || (lead.status || 'new') === status) return; // no-op if same column
      await store.update(id, { status });
      toast(`Moved to ${STATUS_LABEL[status]}`);
      viewLeads();
    };
  });
}

// -------- map (saved leads plotted; Leaflet lazy-loaded)
let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = resolve;
    js.onerror = reject;
    document.head.appendChild(js);
  });
  return leafletLoading;
}

async function viewMap() {
  const leads = (await store.list()).filter((l) => l.lat && l.lng);
  const total = (await store.list()).length;
  $('#main').innerHTML = `
    <h1>Map</h1>
    <p class="subtitle">Your saved leads by location — color-coded by opportunity (red = hot).</p>
    ${leads.length === 0 ? `<div class="card muted">${total ? 'Your saved leads were found before map support was added. Re-search and save leads to see them here.' : 'No saved leads yet. <a href="#/find" style="color:var(--accent)">Find some →</a>'}</div>`
      : `<div class="flex mb" style="gap:14px;font-size:13px">
           <span><span class="dot" style="background:#f87171"></span> Hot (55+)</span>
           <span><span class="dot" style="background:#fbbf24"></span> Warm (30-54)</span>
           <span><span class="dot" style="background:#34d399"></span> Cold (&lt;30)</span>
           <span class="muted">· ${leads.length} plotted</span>
         </div>
         <div id="map"></div>`}
  `;
  if (!leads.length) return;
  try {
    await loadLeaflet();
  } catch {
    $('#map').outerHTML = '<div class="card muted">Could not load the map library (offline?).</div>';
    return;
  }
  const map = L.map('map').setView([leads[0].lat, leads[0].lng], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(map);
  const bounds = [];
  for (const l of leads) {
    const opp = combinedOpp(l);
    const color = opp >= 55 ? '#f87171' : opp >= 30 ? '#fbbf24' : '#34d399';
    const marker = L.circleMarker([l.lat, l.lng], { radius: 9, fillColor: color, color: '#0e1116', weight: 2, fillOpacity: 0.9 }).addTo(map);
    marker.bindPopup(`<b>${esc(l.name)}</b><br>Opportunity: ${opp}${l.website ? '' : ' · no website'}<br><a href="#" data-mapid="${esc(l.id)}">Open lead →</a>`);
    bounds.push([l.lat, l.lng]);
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40] });
  map.on('popupopen', (e) => {
    const link = e.popup.getElement().querySelector('[data-mapid]');
    if (link) link.onclick = async (ev) => { ev.preventDefault(); openLeadModal(await store.get(link.dataset.mapid)); };
  });
}

// -------- report
// INTERNAL fix plan — agency-only. Deliberately NOT a shareable/publishable route
// (no /r/ link, no publish panel, no send buttons). It's the fulfilment recipe.
async function viewFixPlan(id) {
  const lead = await store.get(decodeURIComponent(id || ''));
  if (!lead) { $('#main').innerHTML = '<div class="card">Lead not found. <a href="#/leads" style="color:var(--accent)">Back to leads</a></div>'; return; }
  const items = fixItems(lead);
  const nCrit = items.filter((i) => i.finding.severity === 'critical').length;
  const eta = items.reduce((s, i) => s + (i.eta || 0), 0);
  const sevIco = (s) => s === 'critical' ? '<span style="color:#dc2626">●</span>' : s === 'warning' ? '<span style="color:#d97706">●</span>' : '<span style="color:#2563eb">●</span>';

  $('#main').innerHTML = `
    <div class="flex spread mb no-print">
      <a class="btn-ghost btn-sm" href="#/leads">← Back</a>
      <div class="flex">
        <button class="btn-ghost" id="fp-copy">${ic('file')} Copy checklist</button>
        <button onclick="window.print()">${ic('printer')} Print / Save as PDF</button>
      </div>
    </div>
    <div class="fixplan-flag">${sevIcon('critical')} <b>Internal — agency use only.</b> This is your fulfilment checklist (the “how”). <b>Do not send it to the client</b> — that’s what the audit report is for. Sending this hands over the work you’re paid to do.</div>
    <div class="report-page">
      <div class="report-head">
        <div class="report-agency">GBP Fix Plan<div class="sub">Internal fulfilment checklist</div></div>
        <div style="text-align:right;font-size:13px;color:#718096">${esc(getSettings().agencyName || '')}</div>
      </div>
      <h1 style="font-size:24px">${esc(lead.name)}</h1>
      <p style="color:#4a5568">${esc(lead.address || '')}</p>
      <p style="color:#718096;font-size:13px">${items.length} item${items.length === 1 ? '' : 's'} · ${nCrit} critical · estimated ~${eta} min of work</p>

      ${items.length === 0
        ? '<div class="report-section"><p>Nothing failing — this listing is already in good shape. Sell them growth, not repair.</p></div>'
        : items.map((it, i) => `
        <div class="fixplan-item">
          <div class="fixplan-hd"><span class="fixplan-chk">☐</span> ${sevIco(it.finding.severity)} <b>${i + 1}. ${esc(it.finding.text)}</b> <span style="color:#94a3b8;font-weight:400;font-size:12px">~${it.eta} min</span></div>
          ${it.finding.pitch ? `<div class="fixplan-why">Why it matters: ${esc(it.finding.pitch)}</div>` : ''}
          <ol class="fixplan-steps">${it.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        </div>`).join('')}
    </div>`;

  $('#fp-copy').onclick = () => { navigator.clipboard.writeText(fixPlanText(lead)); toast('Fix plan copied — paste into your task tool'); };
}

async function viewReport(id) {
  const lead = await store.get(decodeURIComponent(id || ''));
  if (!lead) { $('#main').innerHTML = '<div class="card">Lead not found. <a href="#/leads" style="color:var(--accent)">Back to leads</a></div>'; return; }
  const s = getSettings();
  const ringColor = lead.healthScore >= 70 ? '#34d399' : lead.healthScore >= 45 ? '#fbbf24' : '#f87171';
  const critical = lead.issues.filter((i) => i.severity === 'critical');
  const other = lead.issues.filter((i) => i.severity !== 'critical');

  $('#main').innerHTML = `
    <div class="flex spread mb no-print">
      <a class="btn-ghost btn-sm" href="#/leads">← Back</a>
      ${feat().download ? `<button onclick="window.print()">${ic('printer')} Print / Save as PDF</button>` : ''}
    </div>
    <div class="card mb no-print" id="share-panel"><p class="muted">Loading share options…</p></div>
    <div class="report-page">
      <div class="report-head">
        <div class="report-agency">${esc(s.agencyName || 'Your Agency Name')}<div class="sub">${esc(s.agencyTagline || 'Local Marketing Specialists')}</div></div>
        <div style="text-align:right;font-size:13px;color:#718096">
          ${esc(s.agencyEmail || '')}<br>${esc(s.agencyPhone || '')}<br>${esc(s.agencyWebsite || '')}
        </div>
      </div>
      <h1 style="font-size:26px">Google Business Profile Audit</h1>
      <p style="color:#4a5568">${esc(lead.name)} · ${esc(lead.address)}</p>
      <p style="color:#718096;font-size:13px">Prepared ${new Date(lead.savedAt || lead.createdAt || Date.now()).toLocaleDateString()} · Searched as "${esc(lead.keyword)}" in ${esc(lead.location)}</p>

      <div class="report-grade">
        <div class="report-score-ring" style="background:conic-gradient(${ringColor} ${lead.healthScore * 3.6}deg, #e2e8f0 0deg)">
          <div style="background:#fff;color:#1a202c;width:96px;height:96px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center">
            <div>${lead.healthScore}</div><div style="font-size:11px;font-weight:500;color:#718096">/ 100</div>
          </div>
        </div>
        <div class="label">Listing Health Score — Grade <b>${lead.grade}</b></div>
      </div>

      <div class="report-section">
        <h2>Snapshot</h2>
        <div class="report-meta-grid">
          <span class="k">Star rating</span><span>${lead.rating ? lead.rating + ' ★' : 'No rating'}</span>
          <span class="k">Reviews</span><span>${lead.reviewCount ?? 0}</span>
          <span class="k">Website</span><span>${lead.website ? 'Yes' : ic('x','ic-critical') + ' Missing'}</span>
          <span class="k">Phone</span><span>${lead.phone || (ic('x','ic-critical') + ' Missing')}</span>
          <span class="k">Photos</span><span>${lead.photoCount ?? 0}</span>
          <span class="k">Hours listed</span><span>${lead.hasHours ? 'Yes' : ic('x','ic-critical') + ' Missing'}</span>
        </div>
      </div>

      ${critical.length ? `<div class="report-section"><h2>${sevIcon('critical')} Critical issues (${critical.length})</h2>
        ${critical.map((i) => `<div class="report-finding"><span>${sevIcon('critical')}</span><div><b>${esc(i.text)}</b>${i.pitch ? `<div class="pitch">${esc(i.pitch)}</div>` : ''}</div></div>`).join('')}</div>` : ''}

      ${other.length ? `<div class="report-section"><h2>${sevIcon('warning')} Improvement opportunities (${other.length})</h2>
        ${other.map((i) => `<div class="report-finding"><span>${sevIcon('warning')}</span><div><b>${esc(i.text)}</b>${i.pitch ? `<div class="pitch">${esc(i.pitch)}</div>` : ''}</div></div>`).join('')}</div>` : ''}

      <div class="report-section"><h2>${sevIcon('ok')} What's working</h2>
        ${lead.findings.filter((f) => f.ok).map((f) => `<div class="report-finding"><span>${sevIcon('ok')}</span><div>${esc(f.text)}</div></div>`).join('')}
      </div>

      ${lead.reviewInsight ? `
      <div class="report-section">
        <h2>${ic('star','ic-pitch')} Review Intelligence</h2>
        <p style="color:#4a5568;font-size:14px"><b>${esc(lead.reviewInsight.clientHeadline || lead.reviewInsight.headline)}</b></p>
        <div class="report-finding" style="margin-top:8px"><span>${ic('dollar','ic-pitch')}</span><div>${esc(lead.reviewInsight.clientPitch || lead.reviewInsight.pitch)}</div></div>
        ${lead.reviewInsight.toTarget ? `<div class="report-finding"><span>${ic('trendUp','ic-info')}</span><div><b>${lead.reviewInsight.toTarget.needed}</b> new 5-star reviews would lift the average to ${lead.reviewInsight.toTarget.target}★.</div></div>` : ''}
        <p style="color:#94a3b8;font-size:12px;margin-top:8px">Estimated from the public ${lead.reviewInsight.rating}★ average across ${lead.reviewInsight.count} reviews.</p>
      </div>` : ''}

      ${(() => {
        const cm = clientMining(lead.reviewMining);
        if (!cm || !cm.themes.length) return '';
        const row = (t) => `<div class="report-finding"><span>${t.sentiment === 'praise' ? ic('heart','ic-praise') : sevIcon('critical')}</span><div>
          <b>${esc(t.label)}</b>
          ${t.quote ? `<blockquote class="review-quote">“${esc(t.quote)}”<cite>— ${esc(t.quoteAuthor || 'a customer')}${t.quoteRating ? `, ${t.quoteRating}★` : ''}</cite></blockquote>` : ''}
        </div></div>`;
        return `
        <div class="report-section">
          <h2>${ic('megaphone')} What your customers are saying</h2>
          <p style="color:#4a5568;font-size:14px">${esc(cm.clientSummary)}</p>
          <div style="margin-top:8px">${cm.themes.map(row).join('')}</div>
          <p style="color:#94a3b8;font-size:12px;margin-top:8px">Based on the ${cm.sampled} review${cm.sampled === 1 ? '' : 's'} Google displays publicly${cm.totalReviews ? ` of ${cm.totalReviews} total` : ''}. Quotes are reproduced verbatim.</p>
        </div>`;
      })()}

      ${lead.webAudit ? `
      <div class="report-section">
        <h2>${ic('globe')} Website audit — Grade ${lead.webAudit.grade} (${lead.webAudit.websiteScore}/100)</h2>
        ${lead.webAudit.reachable === false
          ? `<div class="report-finding"><span>${sevIcon('critical')}</span><div><b>${esc(lead.webAudit.findings[0].text)}</b><div class="pitch">${esc(lead.webAudit.findings[0].pitch)}</div></div></div>`
          : `
            ${lead.webAudit.issues.map((i) => `<div class="report-finding"><span>${sevIcon(i.severity)}</span><div><b>${esc(i.text)}</b>${i.pitch ? `<div class="pitch">${esc(i.pitch)}</div>` : ''}</div></div>`).join('')}
            ${lead.webAudit.findings.filter((f) => f.ok).map((f) => `<div class="report-finding"><span>${sevIcon('ok')}</span><div>${esc(f.text)}</div></div>`).join('')}
          `}
      </div>` : ''}

      ${lead.pageSpeed?.ok ? `
      <div class="report-section">
        <h2>${ic('zap')} Mobile Speed — ${lead.pageSpeed.score}/100 (Grade ${lead.pageSpeed.grade})</h2>
        <div class="report-meta-grid">
          ${lead.pageSpeed.metrics.lcp?.value ? `<span class="k">Largest Contentful Paint</span><span>${esc(lead.pageSpeed.metrics.lcp.value)}</span>` : ''}
          ${lead.pageSpeed.metrics.si?.value ? `<span class="k">Speed Index</span><span>${esc(lead.pageSpeed.metrics.si.value)}</span>` : ''}
          ${lead.pageSpeed.metrics.tbt?.value ? `<span class="k">Total Blocking Time</span><span>${esc(lead.pageSpeed.metrics.tbt.value)}</span>` : ''}
          ${lead.pageSpeed.metrics.cls?.value ? `<span class="k">Cumulative Layout Shift</span><span>${esc(lead.pageSpeed.metrics.cls.value)}</span>` : ''}
        </div>
        ${!lead.pageSpeed.finding.ok ? `<div class="report-finding" style="margin-top:10px"><span>${sevIcon(lead.pageSpeed.finding.severity)}</span><div><b>${esc(lead.pageSpeed.finding.text)}</b><div class="pitch">${esc(lead.pageSpeed.finding.pitch)}</div></div></div>` : ''}
      </div>` : ''}

      ${lead.competitors?.marketSize ? `
      <div class="report-section">
        <h2>${ic('barChart')} Competitor Benchmark</h2>
        <p style="color:#4a5568;font-size:14px">Ranked <b>#${lead.competitors.rankByReviews}</b> of ${lead.competitors.marketSize} by review volume for "${esc(lead.keyword)}" in ${esc(lead.location)}. Here's how you compare to the typical competitor:</p>
        <div class="report-meta-grid" style="margin-top:10px">
          <span class="k">Reviews</span><span>${lead.reviewCount ?? 0} <span style="color:#718096">${lead.competitors.reviewTarget ? `· ~${lead.competitors.reviewTarget.needed} more to pass ${lead.competitors.reviewTarget.passN} competitor${lead.competitors.reviewTarget.passN === 1 ? '' : 's'}` : `vs ${lead.competitors.medReviews} typical`}</span></span>
          <span class="k">Rating</span><span>${lead.rating || 0}★ <span style="color:#718096">vs ${lead.competitors.medRating}★ typical</span></span>
          <span class="k">Photos</span><span>${lead.photoCount ?? 0} <span style="color:#718096">vs ${lead.competitors.medPhotos} typical</span></span>
          <span class="k">Website</span><span>${lead.website ? 'Yes' : 'No'} <span style="color:#718096">· ${lead.competitors.pctWebsite}% of competitors have one</span></span>
        </div>
      </div>` : ''}

      ${lead.demoSiteId ? `
      <div class="report-section">
        <h2>${ic('globe')} Your new website — ready to preview</h2>
        <p style="color:#4a5568;font-size:14px">We've already built a preview of a modern website for ${esc(lead.name)}. Take a look:</p>
        <p style="margin-top:8px"><a href="${esc(demoSiteUrl(lead))}" style="color:#146682;font-weight:700;word-break:break-all">${esc(demoSiteUrl(lead))}</a></p>
        <p style="color:#94a3b8;font-size:12px;margin-top:6px">A live preview — click to open it in your browser.</p>
      </div>` : ''}

      <div class="report-cta">
        <h3>Recommended next steps</h3>
        <p style="font-size:14px;color:#4a5568">${esc(ctaCopy(lead, s.agencyName))}</p>
        <p style="font-size:14px;margin-top:8px"><b>Contact:</b> ${esc(s.agencyEmail || 'your@email.com')} ${s.agencyPhone ? '· ' + esc(s.agencyPhone) : ''}</p>
      </div>
    </div>
  `;
  renderSharePanel(lead);
}

// The closing paragraph must match what the report actually found. Telling a
// 95/100 Grade-A business we'll "resolve the critical issues above" when there
// are none reads as a form letter — and it is the last thing they read.
function ctaCopy(lead, agencyName) {
  const We = agencyName || 'We';   // sentence-initial
  const we = agencyName || 'we';   // mid-sentence
  const criticals = (lead.issues || []).filter((i) => i.severity === 'critical').length
    + (lead.webAudit?.issues || []).filter((i) => i.severity === 'critical').length;
  const totalIssues = (lead.issues || []).length + (lead.webAudit?.issues || []).length;
  const services = [...new Set([
    ...(lead.services || []),
    ...(lead.webAudit?.issues || []).map((i) => i.service),
  ])].filter(Boolean).join(' → ') || 'GMB optimization';

  if (criticals > 0) {
    return `${lead.name} is currently leaving customers on the table. Our recommended priority: ${services}. ${We} can typically resolve the ${criticals} critical issue${criticals === 1 ? '' : 's'} above within 2–4 weeks.`;
  }
  if (totalIssues > 0) {
    const one = totalIssues === 1;
    return `${lead.name}'s online presence is in good shape — the ${totalIssues} opportunit${one ? 'y' : 'ies'} above ${one ? 'is' : 'are'} the difference between good and dominant. Our recommended priority: ${services}. ${We} can typically deliver ${one ? 'it' : 'these'} within 2–4 weeks.`;
  }
  return `${lead.name}'s listing is already performing strongly, and there is nothing urgent to fix. The opportunity now is growth rather than repair — ${we} would focus on ${services} to widen the gap on nearby competitors.`;
}

// Two voices: everything the prospect sees is stripped of the agency's rationale.
function clientMining(m) {
  if (!m || m.ok === false) return null;
  return {
    source: m.source, sampled: m.sampled, totalReviews: m.totalReviews,
    clientSummary: m.clientSummary || '',
    themes: (m.themes || []).map((t) => ({
      label: t.label, sentiment: t.sentiment, count: t.count,
      quote: t.quoteVerified ? t.quote : null,
      quoteAuthor: t.quoteAuthor || null, quoteRating: t.quoteRating || null,
      // `pitch` deliberately omitted — it is written for the agency.
    })),
  };
}

// Snapshot the lead into a compact, self-contained report payload (+ agency branding).
function buildReportPayload(lead) {
  const s = getSettings();
  return {
    name: lead.name, address: lead.address, keyword: lead.keyword, location: lead.location,
    healthScore: lead.healthScore, opportunityScore: lead.opportunityScore, grade: lead.grade,
    rating: lead.rating, reviewCount: lead.reviewCount, website: lead.website, phone: lead.phone,
    photoCount: lead.photoCount, hasHours: lead.hasHours,
    findings: lead.findings, services: lead.services,
    webAudit: lead.webAudit || null, pageSpeed: lead.pageSpeed || null,
    competitors: lead.competitors || null,
    reviewInsight: lead.reviewInsight || null,
    // Client-facing snapshot only: strip the agency's pitch/summary and the raw
    // quote dump. The prospect must never read our sales notes.
    reviewMining: lead.reviewMining ? clientMining(lead.reviewMining) : null,
    demoSiteUrl: lead.demoSiteId ? demoSiteUrl(lead) : null,
    createdAt: new Date().toISOString(),
    agency: { name: s.agencyName || '', tagline: s.agencyTagline || '', email: s.agencyEmail || '', phone: s.agencyPhone || '', website: s.agencyWebsite || '' },
  };
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function renderSharePanel(lead) {
  const panel = $('#share-panel');
  if (!panel) return;
  const url = lead.reportUrl;

  if (!feat().share) {
    panel.innerHTML = `
      <div class="flex spread">
        <div><b>${ic('globe')} Share this report</b><div class="muted" style="font-size:13px">Publishing a live, trackable report link is available on the full plan.</div></div>
        <span class="badge badge-muted">${ic('lock')} Locked</span>
      </div>`;
    return;
  }

  if (!url) {
    panel.innerHTML = `
      <div class="flex spread">
        <div><b>${ic('globe')} Share this report</b><div class="muted" style="font-size:13px">Publish a live link you can send on WhatsApp — you'll see when they open it.</div></div>
        <button id="publish-report">Publish shareable link</button>
      </div>`;
    $('#publish-report').onclick = () => publishReport(lead);
    return;
  }

  // published — show link, share buttons, live stats
  panel.innerHTML = `
    <div class="flex spread mb"><b>${ic('globe')} Shared report</b> <span class="muted" id="views-stat" style="font-size:13px">checking opens…</span></div>
    <div class="flex" style="gap:8px">
      <input id="report-url" value="${esc(url)}" readonly style="flex:1">
      <button class="btn-sm" id="copy-url">Copy</button>
      <button class="btn-wa btn-sm" id="wa-report">${ic('chat')} Send</button>
      <a class="btn-ghost btn-sm" href="${esc(url)}?p=1" target="_blank">Preview</a>
      <button class="btn-ghost btn-sm" id="republish">Re-publish</button>
    </div>`;
  $('#copy-url').onclick = () => { navigator.clipboard.writeText(url); toast('Link copied'); };
  $('#republish').onclick = () => publishReport(lead);
  $('#wa-report').onclick = () => {
    const s = getSettings();
    const msg = `${s.waGreeting || 'Hello'}! I put together a quick audit of ${lead.name}'s Google listing — here's your free report:\n${url}`;
    window.open(waLink(lead, msg), '_blank');
    store.get(lead.id).then((sv) => { if (sv && sv.status === 'new') store.update(sv.id, { status: 'contacted' }); });
  };
  loadViewStats(lead.reportId);
}

async function loadViewStats(id) {
  if (!id) return;
  try {
    const res = await fetch(`/api/report?id=${encodeURIComponent(id)}`);
    const v = await res.json();
    const el = $('#views-stat');
    if (!el) return;
    el.innerHTML = v.views > 0
      ? `<span class="badge badge-green">${ic('eye')} Opened ${v.views}×</span> last ${relTime(v.last)}`
      : `<span class="badge badge-muted">not opened yet</span>`;
  } catch { /* ignore */ }
}

async function publishReport(lead) {
  const btn = $('#publish-report') || $('#republish');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: buildReportPayload(lead), id: lead.reportId, code: accessCode() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Publish failed');
    lead.reportId = data.id;
    lead.reportUrl = data.url;
    await store.update(lead.id, { reportId: data.id, reportUrl: data.url });
    toast('Report published — link ready to share');
    renderSharePanel(lead);
  } catch (e) {
    toast(e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Publish shareable link'; }
  }
}

// -------- BYOK onboarding wizard
// Google Cloud setup is the single biggest friction in BYOK — it is the thing
// LeadsGorilla buyers complain about, and an abandoned setup is a lost customer.
// So it's a guided wizard with direct console links, not a buried accordion.
// The two traps flagged in step 4 are ones we hit ourselves (see LEARNINGS §1):
// "OK" silently discards the API restriction, and an Application restriction
// blocks every request because our searches run server-side.

// Shared by the Settings card and the wizard's last step.
async function runKeyTest(key, box, btn) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Testing…`;
  box.innerHTML = '';
  try {
    const res = await fetch('/api/testkey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleKey: key }) });
    const d = await res.json();
    const cls = d.status === 'ok' ? 'banner-info' : 'banner-warn';
    const icon = d.status === 'ok' ? ic('checkCircle', 'ic-ok')
      : d.status === 'invalid-format' || d.status === 'empty' ? ic('alertTriangle', 'ic-warning')
      : sevIcon('critical');
    box.innerHTML = `<div class="banner ${cls}" style="font-size:12.5px;line-height:1.6">${icon} ${esc(d.message || 'Unknown result.')}</div>`;
    return d.status === 'ok';
  } catch (e) {
    box.innerHTML = `<div class="banner banner-warn" style="font-size:12.5px">Test failed: ${esc(e.message)}</div>`;
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

const WIZ_STEPS = [
  {
    t: 'Create a Google Cloud project',
    h: () => `
      <p class="muted">Your key lives inside a Google Cloud <b>project</b> — a free container for it. Already have one? Skip ahead.</p>
      <ol class="wiz-ol">
        <li>Open the Google Cloud console.</li>
        <li>Give the project any name (e.g. <code class="inline">leadlion</code>) and press <b>Create</b>.</li>
      </ol>
      <a class="btn" href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Open Google Cloud ↗</a>`,
  },
  {
    t: 'Turn on the three APIs',
    h: () => `
      <p class="muted">LeadLion uses exactly three Google APIs — no more. Open each link and press <b>Enable</b>. Check your new project is selected in the console's top bar.</p>
      <ol class="wiz-ol">
        <li><b>Places API (New)</b> — finds the businesses<br>
          <a href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noopener">Enable Places API (New) ↗</a></li>
        <li><b>Geocoding API</b> — turns a city name into a real map area<br>
          <a href="https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com" target="_blank" rel="noopener">Enable Geocoding API ↗</a></li>
        <li><b>PageSpeed Insights API</b> — the mobile speed audit<br>
          <a href="https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com" target="_blank" rel="noopener">Enable PageSpeed Insights ↗</a></li>
      </ol>`,
  },
  {
    t: 'Create the API key',
    h: () => `
      <ol class="wiz-ol">
        <li>Go to <b>APIs &amp; Services → Credentials</b>.</li>
        <li>Click <b>+ Create credentials → API key</b>.</li>
        <li>Copy the key it shows you — it starts with <code class="inline">AIza…</code>. Keep the tab open for the next step.</li>
      </ol>
      <a class="btn" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Open Credentials ↗</a>`,
  },
  {
    t: 'Lock the key down — and dodge two traps',
    h: () => `
      <p class="muted">Click your new key to edit it. Two settings matter, and both catch people out:</p>
      <div class="banner banner-warn" style="font-size:12.5px;line-height:1.6;margin-bottom:10px">
        ${ic('alertTriangle')} <b>Trap 1 — “OK” does not save.</b> Under <i>API restrictions</i> pick <b>Restrict key</b>, tick the three APIs, press <b>OK</b> — then press <b>Save</b> at the bottom of the page. OK on its own silently throws it away.
      </div>
      <div class="banner banner-warn" style="font-size:12.5px;line-height:1.6">
        ${ic('alertTriangle')} <b>Trap 2 — leave <i>Application restrictions</i> on <code class="inline">None</code>.</b> Searches run from LeadLion's server, not your browser, so a “Websites” restriction blocks every single request. Restricting by <b>API</b> (above) is what actually secures the key.
      </div>`,
  },
  {
    t: 'Enable billing — you still pay nothing',
    h: () => `
      <p class="muted">Google wants a card on file before it serves live data, even on the free tier. <b>It isn't charged while you're inside the free allowance.</b></p>
      <ul class="wiz-ol">
        <li>New accounts get a one-time <b>$300 credit over 90 days</b>. During the trial Google <b>never</b> charges the card — services simply pause if you exhaust it.</li>
        <li>After that a <b>free monthly allowance renews</b> each month. Most months genuinely cost nothing.</li>
        <li>Settings keeps a usage counter so you always know where you stand.</li>
      </ul>
      <a class="btn" href="https://console.cloud.google.com/billing" target="_blank" rel="noopener">Open Billing ↗</a>`,
  },
  {
    t: 'Paste your key and test it',
    h: () => `
      <p class="muted">Last step. Paste the key you copied, then hit <b>Test key</b> — it runs one real search so you know it works before you rely on it.</p>
      <label>Google API key</label>
      <div class="flex" style="gap:8px;align-items:stretch">
        <input id="w-gkey" type="password" value="${esc(getSettings().googleApiKey || '')}" placeholder="AIza…" autocomplete="off" style="flex:1">
        <button class="btn-ghost" id="w-test" type="button" style="white-space:nowrap">Test key</button>
      </div>
      <div id="w-result" style="margin-top:8px"></div>`,
  },
];

function openByokWizard(i = 0) {
  const step = WIZ_STEPS[i];
  const last = i === WIZ_STEPS.length - 1;
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="w-overlay">
      <div class="modal" style="max-width:600px">
        <button class="modal-close" id="w-close">✕</button>
        <h2 style="margin-top:0">${ic('key')} Set up your Google key</h2>
        <div class="wiz-bar"><div class="wiz-fill" style="width:${((i + 1) / WIZ_STEPS.length) * 100}%"></div></div>
        <p class="muted" style="font-size:12.5px;margin:8px 0 18px">Step ${i + 1} of ${WIZ_STEPS.length} · about 5 minutes in total</p>
        <h3 style="font-size:17px;margin-bottom:10px">${esc(step.t)}</h3>
        ${step.h()}
        <div class="flex spread mt" style="margin-top:22px">
          <button class="btn-ghost" id="w-back" ${i === 0 ? 'disabled' : ''}>← Back</button>
          ${last ? '<button id="w-finish">Save &amp; finish</button>' : '<button id="w-next">Next →</button>'}
        </div>
      </div>
    </div>`;

  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#w-close').onclick = close;
  $('#w-overlay').onclick = (e) => { if (e.target.id === 'w-overlay') close(); };
  $('#w-back').onclick = () => openByokWizard(i - 1);
  if ($('#w-next')) $('#w-next').onclick = () => openByokWizard(i + 1);
  if ($('#w-test')) $('#w-test').onclick = () => runKeyTest($('#w-gkey').value.trim(), $('#w-result'), $('#w-test'));
  if ($('#w-finish')) $('#w-finish').onclick = () => {
    saveSettings({ googleApiKey: $('#w-gkey').value.trim() });
    markByokPrompted();
    close();
    toast(hasByok() ? 'Key saved — your searches now run on your own key' : 'Saved');
    if (location.hash.includes('/settings')) viewSettings();
  };
}

// -------- Supabase onboarding wizard
// Supabase is expected on full accounts: leads in localStorage die with a cache
// clear and never leave the machine. Same shape as the BYOK wizard — the schema
// is fetched from /schema.sql rather than pasted in here, so it can't drift.
const SUPA_STEPS = [
  {
    t: 'Create a free Supabase project',
    h: () => `
      <p class="muted">Supabase is a hosted Postgres database. The free tier is plenty for a lead pipeline, and the project is <b>yours</b> — we never see it.</p>
      <ol class="wiz-ol">
        <li>Sign in and create a new project (any name).</li>
        <li>Pick a region near you and set a database password.</li>
        <li>Give it a minute to finish provisioning.</li>
      </ol>
      <a class="btn" href="https://supabase.com/dashboard/new" target="_blank" rel="noopener">Create a Supabase project ↗</a>`,
  },
  {
    t: 'Run the database schema',
    h: () => `
      <p class="muted">This creates the one <code class="inline">leads</code> table LeadLion needs, plus a security policy so only your key can read it.</p>
      <ol class="wiz-ol">
        <li>In Supabase open <b>SQL Editor → New query</b>.</li>
        <li>Paste the script below and press <b>Run</b>. You should see <i>Success</i>.</li>
      </ol>
      <div class="flex spread" style="margin-bottom:6px">
        <label style="margin:0">schema.sql</label>
        <button class="btn-ghost btn-sm" id="sw-copy" type="button">Copy</button>
      </div>
      <textarea class="script" id="sw-sql" rows="6" readonly>Loading…</textarea>
      <a class="btn mt" href="https://supabase.com/dashboard/project/_/sql/new" target="_blank" rel="noopener">Open SQL Editor ↗</a>`,
  },
  {
    t: 'Copy your Project URL and anon key',
    h: () => `
      <p class="muted">In Supabase go to <b>Project Settings → API</b>. You need two values.</p>
      <ol class="wiz-ol">
        <li><b>Project URL</b> — looks like <code class="inline">https://xxxx.supabase.co</code></li>
        <li><b>anon / public</b> key — the long <code class="inline">eyJ…</code> string</li>
      </ol>
      <div class="banner banner-error" style="font-size:12.5px;line-height:1.6">
        ${sevIcon('critical')} <b>Use the <i>anon</i> key — never the <code class="inline">service_role</code> key.</b> service_role bypasses every security rule and would sit in your browser where anyone could take it. anon is the one meant for this.
      </div>
      <a class="btn mt" href="https://supabase.com/dashboard/project/_/settings/api" target="_blank" rel="noopener">Open API settings ↗</a>`,
  },
  {
    t: 'Connect and test',
    h: () => {
      const s = getSettings();
      return `
      <p class="muted">Paste both values, then test — it runs a real read against your table so you know it works before you rely on it.</p>
      <label>Project URL</label>
      <input id="sw-url" value="${esc(s.supabaseUrl || '')}" placeholder="https://xxxx.supabase.co" autocomplete="off">
      <label>Anon key</label>
      <input id="sw-key" type="password" value="${esc(s.supabaseKey || '')}" placeholder="eyJ…" autocomplete="off">
      <div class="flex mt"><button class="btn-ghost" id="sw-test" type="button">Test connection</button></div>
      <div id="sw-result" style="margin-top:8px"></div>`;
    },
  },
];

function openSupaWizard(i = 0) {
  const step = SUPA_STEPS[i];
  const last = i === SUPA_STEPS.length - 1;
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="sw-overlay">
      <div class="modal" style="max-width:600px">
        <button class="modal-close" id="sw-close">✕</button>
        <h2 style="margin-top:0">${ic('database')} Connect your database</h2>
        <div class="wiz-bar"><div class="wiz-fill" style="width:${((i + 1) / SUPA_STEPS.length) * 100}%"></div></div>
        <p class="muted" style="font-size:12.5px;margin:8px 0 18px">Step ${i + 1} of ${SUPA_STEPS.length} · about 10 minutes in total</p>
        <h3 style="font-size:17px;margin-bottom:10px">${esc(step.t)}</h3>
        ${step.h()}
        <div class="flex spread mt" style="margin-top:22px">
          <button class="btn-ghost" id="sw-back" ${i === 0 ? 'disabled' : ''}>← Back</button>
          ${last ? '<button id="sw-finish">Save &amp; finish</button>' : '<button id="sw-next">Next →</button>'}
        </div>
      </div>
    </div>`;

  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#sw-close').onclick = close;
  $('#sw-overlay').onclick = (e) => { if (e.target.id === 'sw-overlay') close(); };
  $('#sw-back').onclick = () => openSupaWizard(i - 1);
  if ($('#sw-next')) $('#sw-next').onclick = () => openSupaWizard(i + 1);

  // Step 2 — pull the real schema so this can never drift from the file we ship.
  const sql = $('#sw-sql');
  if (sql) {
    fetch('/schema.sql').then((r) => r.text()).then((t) => { sql.value = t; })
      .catch(() => { sql.value = '-- Could not load schema.sql — open /schema.sql directly.'; });
    $('#sw-copy').onclick = () => { navigator.clipboard.writeText(sql.value); toast('schema.sql copied'); };
  }

  const connect = async (btn) => {
    saveSettings({ supabaseUrl: $('#sw-url').value.trim(), supabaseKey: $('#sw-key').value.trim() });
    const prev = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Testing…`;
    const ok = await initSupabase();
    updateStorageBadge(ok);
    btn.disabled = false;
    btn.textContent = prev;
    $('#sw-result').innerHTML = ok
      ? `<div class="banner banner-info" style="font-size:12.5px;line-height:1.6">${ic('checkCircle', 'ic-ok')} Connected — your leads will sync from now on.</div>`
      : `<div class="banner banner-warn" style="font-size:12.5px;line-height:1.6">${sevIcon('critical')} ${esc(supaError || 'Could not connect.')} Check the URL and anon key, and that schema.sql ran successfully.</div>`;
    return ok;
  };

  if ($('#sw-test')) $('#sw-test').onclick = () => connect($('#sw-test'));
  if ($('#sw-finish')) $('#sw-finish').onclick = async () => {
    const ok = await connect($('#sw-finish'));
    if (!ok) return; // stay put so they can fix it
    markSupaPrompted();
    close();
    toast('Supabase connected');
    await maybeOfferLeadMigration();
    if (location.hash.includes('/settings')) viewSettings();
  };
}

// -------- settings
async function viewSettings() {
  const s = getSettings();
  $('#main').innerHTML = `
    <h1>Settings</h1>
    <p class="subtitle">Branding appears on your audit reports. Keys are stored only in this browser.</p>

    <div class="card mb">
      <h2 style="margin-top:0">${ic('building')} Agency branding</h2>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><label>Agency name</label><input id="s-name" value="${esc(s.agencyName || '')}" placeholder="Acme Digital"></div>
        <div><label>Tagline</label><input id="s-tag" value="${esc(s.agencyTagline || '')}" placeholder="Local Marketing Specialists"></div>
        <div><label>Email</label><input id="s-email" value="${esc(s.agencyEmail || '')}" placeholder="you@agency.com"></div>
        <div><label>Phone</label><input id="s-phone" value="${esc(s.agencyPhone || '')}" placeholder="(555) 123-4567"></div>
        <div><label>Website</label><input id="s-web" value="${esc(s.agencyWebsite || '')}" placeholder="agency.com"></div>
      </div>
    </div>

    <div class="card mb">
      <h2 style="margin-top:0">${ic('chat')} WhatsApp outreach</h2>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><label>Greeting</label><input id="s-wagreet" value="${esc(s.waGreeting || '')}" placeholder="Hello / Assalam o Alaikum / Hi"></div>
        <div><label>Default country code <span class="muted">(fallback only)</span></label><input id="s-wacc" value="${esc(s.waCountryCode || '')}" placeholder="92 for Pakistan, 1 for US"></div>
      </div>
      <p class="muted mt" style="font-size:12.5px">Keep this to a short greeting like <b>Hello</b> or <b>Assalam o Alaikum</b> — it's added to the <b>start</b> of every message, before the personalised text. Don't paste a whole message here (it can't reference the specific lead, so claims like "strong reviews" would be wrong for a lead that has none). The country code is only a fallback when Google doesn't provide an international number.</p>
    </div>

    <div class="card mb">
      <h2 style="margin-top:0">${ic('key')} Your Google API key ${hasByok() ? '<span class="badge" style="background:var(--green);color:#04210f">connected</span>' : '<span class="badge badge-muted">not set</span>'}</h2>
      <p class="muted" style="font-size:13.5px">
        Add your own key and your searches become <b>unlimited</b> — they bill your Google account directly, not ours,
        and we stop counting your API credits.
        <a href="/byok" target="_blank" rel="noopener" style="color:var(--accent)">What is BYOK, and why? ↗</a>
      </p>
      <label>Google API key</label>
      <div class="flex" style="gap:8px;align-items:stretch">
        <input id="s-gkey" type="password" value="${esc(s.googleApiKey || '')}" placeholder="AIza…" autocomplete="off" style="flex:1">
        <button class="btn-ghost" id="s-test-key" type="button" style="white-space:nowrap">Test key</button>
      </div>
      <div id="s-key-result" style="margin-top:8px"></div>
      <p class="muted" style="font-size:12.5px;margin-top:6px">
        ${ic('lock')} Stored in <b>this browser only</b> — it is sent with each search but never saved on our servers.
        Clearing your browser data removes it. <b>Test key</b> runs one live search on your key to confirm it works.
      </p>
      <div class="banner banner-info" style="margin-top:10px;font-size:12.5px;line-height:1.6">
        ${ic('bulb')} <b>What it costs you:</b> Google bills you directly — never us.
        <b>New to Google Cloud?</b> You start with a one-time free trial (currently <b>$300 in credit over 90 days</b>), so your first months cost nothing.
        After that, Google still includes a <b>free monthly usage allowance</b> that renews each month — the usage counter below resets on the 1st and shows where you stand. Beyond the free tier you pay Google directly, typically only in heavy months.
      </div>
      <div class="flex mt">
        <button id="s-wizard">${ic('key')} ${hasByok() ? 'Re-run the setup guide' : 'Set up my key — guided (5 min)'}</button>
        <a class="btn-ghost btn" href="/byok" target="_blank" rel="noopener">Why BYOK? ↗</a>
      </div>
    </div>

    ${usageCard()}

    <div class="card mb">
      <h2 style="margin-top:0">${ic('database')} Lead storage ${
        supabase ? '<span class="badge badge-green">Supabase synced</span>'
        : supaError ? '<span class="badge badge-red">sync error</span>'
        : SESSION?.profile?.type === 'full' ? '<span class="badge badge-yellow">this browser only</span>'
        : '<span class="badge badge-muted">optional on trial</span>'}</h2>
      <p class="muted" style="font-size:13.5px">
        Leads live in <b>this browser</b> until you connect your own Supabase project — then they survive a cache clear and follow you across devices.
        It stays <b>your</b> database; nothing lands on our servers.
      </p>
      ${supaError ? `<div class="banner banner-error" style="font-size:12.5px;line-height:1.6;margin-bottom:10px">${sevIcon('critical')} <b>Sync is failing</b> — leads are saving to this browser only. <span class="muted">${esc(supaError)}</span></div>` : ''}
      <div class="flex mb">
        <button id="s-supa-wizard">${ic('database')} ${supabase ? 'Re-run the setup guide' : 'Connect a database — guided (10 min)'}</button>
        <a class="btn-ghost btn" href="/schema.sql" target="_blank" rel="noopener">View schema.sql ↗</a>
      </div>
      <details>
        <summary class="muted" style="cursor:pointer;font-size:13px">Enter credentials manually</summary>
        <div class="grid mt" style="grid-template-columns:1fr 1fr">
          <div><label>Project URL</label><input id="s-surl" value="${esc(s.supabaseUrl || '')}" placeholder="https://xxxx.supabase.co"></div>
          <div><label>Anon key</label><input id="s-skey" type="password" value="${esc(s.supabaseKey || '')}" placeholder="eyJ…"></div>
        </div>
        <p class="muted" style="font-size:12px;margin-top:8px">Use the <b>anon</b> key — never <code class="inline">service_role</code>.</p>
      </details>
    </div>

    <div class="flex">
      <button id="save-settings">Save settings</button>
      <button class="btn-ghost" id="test-supa">Test Supabase connection</button>
    </div>
  `;
  $('#save-settings').onclick = async () => {
    saveSettings({
      agencyName: $('#s-name').value.trim(),
      agencyTagline: $('#s-tag').value.trim(),
      agencyEmail: $('#s-email').value.trim(),
      agencyPhone: $('#s-phone').value.trim(),
      agencyWebsite: $('#s-web').value.trim(),
      waGreeting: $('#s-wagreet').value.trim(),
      waCountryCode: $('#s-wacc').value.trim(),
      googleApiKey: $('#s-gkey').value.trim(),
      supabaseUrl: $('#s-surl').value.trim(),
      supabaseKey: $('#s-skey').value.trim(),
    });
    const btn = $('#save-settings');
    btn.textContent = '✓ Saved!';
    btn.style.background = 'var(--green)';
    toast('Settings saved');
    setTimeout(() => { btn.textContent = 'Save settings'; btn.style.background = ''; }, 2000);
    updateStorageBadge(await initSupabase());
  };
  $('#test-supa').onclick = async () => {
    saveSettings({ supabaseUrl: $('#s-surl').value.trim(), supabaseKey: $('#s-skey').value.trim() });
    const ok = await initSupabase();
    updateStorageBadge(ok);
    toast(ok ? 'Supabase connected' : 'Could not connect — check URL/key and that schema.sql was run');
    if (ok) await maybeOfferLeadMigration();
  };
  $('#s-test-key').onclick = () => runKeyTest($('#s-gkey').value.trim(), $('#s-key-result'), $('#s-test-key'));
  $('#s-wizard').onclick = () => openByokWizard(0);
  $('#s-supa-wizard').onclick = () => openSupaWizard(0);
  const usageReset = $('#s-usage-reset');
  if (usageReset) usageReset.onclick = () => {
    localStorage.removeItem(USAGE_KEY);
    toast('Usage counter reset');
    viewSettings();
  };
}

// -------- csv
function exportCsv(rows, name) {
  // `email` is derived (it lives at webAudit.emails[0], not on the lead itself) —
  // it's the column that makes the export usable for a mail merge.
  const cols = ['name', 'email', 'address', 'phone', 'website', 'rating', 'reviewCount', 'opportunityScore', 'grade', 'status', 'keyword', 'location'];
  const val = (r, c) => (c === 'email' ? leadEmail(r) : r[c]);
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(val(r, c))).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${rows.length} rows`);
}

// ---------------------------------------------------------------- boot
function updateStorageBadge(supaOk) {
  const b = $('#storage-badge');
  if (!b) return;
  if (supaOk) { b.textContent = 'Supabase synced'; b.className = 'badge badge-green'; b.title = ''; return; }
  if (supaError) { b.textContent = 'Sync error'; b.className = 'badge badge-red'; b.title = supaError; return; }
  b.textContent = 'Local storage';
  b.className = 'badge badge-muted';
  b.title = '';
}

// Storage state has to be visible, not inferred. Full accounts are expected to
// run on Supabase, so they get a standing banner until they do:
//   broken   -> red    (they think they're synced and aren't — the worst case)
//   missing  -> amber  (works, but one cache clear from losing the pipeline)
// Trial/demo are localStorage by design and are never nagged.
function injectStorageWarning() {
  if (SESSION?.profile?.type !== 'full') return;
  const main = $('#main');
  if (!main || $('#supa-warn')) return;
  let cls, html;
  if (supaError) {
    cls = 'banner banner-error mb';
    html = `${sevIcon('critical')} <b>Supabase sync is failing</b> — new leads are saving to <b>this browser only</b>.
      <span class="muted" style="font-size:12px">${esc(supaError)}</span>
      <a href="#/settings" style="color:var(--accent)">Fix in Settings →</a>`;
  } else if (!supabase) {
    cls = 'banner banner-warn mb';
    html = `${ic('alertTriangle')} <b>Your leads live in this browser only.</b> Clearing browser data would erase them, and they won't follow you to another device.
      <a href="#/settings" style="color:var(--accent)">Connect a database →</a>`;
  } else return;
  const div = document.createElement('div');
  div.id = 'supa-warn';
  div.className = cls;
  div.innerHTML = html;
  main.prepend(div);
}

// One-time modal for full accounts still on browser-only storage.
function maybeSupaPrompt() {
  if (SESSION?.profile?.type !== 'full' || supabase || supaError || supaPrompted()) return false;
  markSupaPrompted();
  const count = store.local().length;
  $('#modal-root').innerHTML = `
    <div class="modal-overlay" id="sp-overlay">
      <div class="modal" style="max-width:530px">
        <h2 style="margin-top:0">${ic('database')} Keep your leads somewhere safe</h2>
        <p class="muted" style="font-size:14px;line-height:1.65">
          ${count ? `Your <b>${count} saved lead${count === 1 ? '' : 's'}</b> currently live` : 'Your saved leads currently live'}
          in <b>this browser only</b>. Clearing your browser data would erase them, and they never reach your other devices.
        </p>
        <div class="banner banner-info" style="font-size:12.5px;line-height:1.6;margin-top:12px">
          ${ic('lock')} Connect your own free <b>Supabase</b> project and they're stored in <b>your</b> database — still nothing on our servers. Takes about 10 minutes, guided.
        </div>
        <div class="flex mt" style="margin-top:20px">
          <button id="sp-go">${ic('database')} Connect a database</button>
          <button class="btn-ghost" id="sp-later">Later</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:14px">You can start this any time from <b>Settings</b>. Until then, <b>Export CSV</b> is your backup.</p>
      </div>
    </div>`;
  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#sp-later').onclick = close;
  $('#sp-overlay').onclick = (e) => { if (e.target.id === 'sp-overlay') close(); };
  $('#sp-go').onclick = () => openSupaWizard(0);
  return true;
}

// ---------------------------------------------------------------- login gate
function renderGate(message) {
  document.getElementById('app').style.display = 'none';
  let gate = document.getElementById('gate');
  if (!gate) { gate = document.createElement('div'); gate.id = 'gate'; document.body.appendChild(gate); }
  gate.innerHTML = `
    <div class="gate-card">
      <img src="/logo.png" width="72" height="72" alt="" style="border-radius:16px">
      <h1>Lead<b>Lion</b></h1>
      <p class="muted">Enter your access code to continue.</p>
      ${message ? `<div class="banner banner-warn" style="text-align:left">${esc(message)}</div>` : ''}
      <input id="gate-code" placeholder="Access code" autocomplete="off">
      <button id="gate-go" style="width:100%">Enter →</button>
      <div class="muted" style="font-size:13px;margin-top:14px">No code? <a id="gate-demo" href="#" style="color:var(--accent)">Explore the demo</a> with sample data.</div>
    </div>`;
  const submit = async () => {
    const code = document.getElementById('gate-code').value.trim();
    if (!code) return;
    const btn = document.getElementById('gate-go');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      setSession({ code, profile: data.profile });
      enterApp();
    } catch (e) {
      renderGate(e.message);
    }
  };
  document.getElementById('gate-go').onclick = submit;
  document.getElementById('gate-code').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  document.getElementById('gate-demo').onclick = (e) => {
    e.preventDefault();
    setSession({ code: null, profile: { type: 'demo', live: false, features: { deep: false, download: false, share: false }, resultCap: 20 } });
    enterApp();
  };
}

function enterApp() {
  const gate = document.getElementById('gate');
  if (gate) gate.remove();
  document.getElementById('app').style.display = '';
  renderSessionFoot();
  initSupabase().then(async (ok) => {
    updateStorageBadge(ok);
    await render();
    await maybeOfferLeadMigration();
  });
}

function renderSessionFoot() {
  const foot = document.querySelector('.sidebar-foot');
  if (!foot) return;
  const p = SESSION?.profile || {};
  const label = p.type === 'full' ? 'Full access' : p.type === 'trial' ? `Trial · ${p.remaining ?? '?'} left` : 'Demo mode';
  const cls = p.type === 'full' ? 'badge-green' : p.type === 'trial' ? 'badge-yellow' : 'badge-muted';
  foot.innerHTML = `
    <div id="storage-badge" class="badge badge-muted">Local storage</div>
    <div class="flex spread" style="margin-top:8px">
      <span class="badge ${cls}">${esc(label)}</span>
      <button class="btn-ghost btn-sm" id="logout-btn">Log out</button>
    </div>`;
  document.getElementById('logout-btn').onclick = () => { clearSession(); location.reload(); };
}

function boot() {
  loadSession();
  if (SESSION) enterApp();
  else renderGate();
}

window.addEventListener('hashchange', () => { if (SESSION) render(); });
boot();

// PWA: register service worker for installability + offline shell
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
