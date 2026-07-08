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

async function initSupabase() {
  const s = getSettings();
  if (!s.supabaseUrl || !s.supabaseKey) return false;
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    supabase = createClient(s.supabaseUrl, s.supabaseKey);
    // probe the table so we fail fast and fall back to local
    const { error } = await supabase.from('leads').select('id').limit(1);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    supabase = null;
    console.warn('Supabase unavailable, using local storage:', e.message);
    return false;
  }
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
const STATUS_LABEL = { new: '🆕 New', contacted: '📞 Contacted', meeting: '🤝 Meeting', won: '✅ Won', lost: '❌ Lost' };

// ---------------------------------------------------------------- outreach
function allIssues(lead) {
  // GMB issues first, then website-audit issues, then speed — criticals first
  const rank = { critical: 0, warning: 1, info: 2 };
  const gmb = [...(lead.issues || [])].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const web = [...(lead.webAudit?.issues || [])].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const speed = lead.pageSpeed?.ok && !lead.pageSpeed.finding.ok ? [lead.pageSpeed.finding] : [];
  return [...gmb, ...web, ...speed];
}

function buildOutreach(lead) {
  const s = getSettings();
  const agency = s.agencyName || 'Your Agency';
  const topIssues = allIssues(lead).slice(0, 4);
  const bullets = topIssues.map((i) => `  • ${i.text}`).join('\n');
  const services = [...new Set([...(lead.services || []), ...(lead.webAudit?.issues || []).map((i) => i.service)])].filter(Boolean).join(', ') || 'local SEO';

  const c = lead.competitors;
  const compLine = c && c.marketSize && (lead.reviewCount || 0) < c.avgReviews
    ? `\n\nFor context: you're currently ranked #${c.rankByReviews} of ${c.marketSize} for "${lead.keyword}" in your area — the top ${c.topN} businesses average ${c.avgReviews} reviews, while you have ${lead.reviewCount || 0}. That gap is closable.`
    : '';

  // Review intelligence line — only when it actually strengthens the pitch.
  const ri = lead.reviewInsight;
  const reviewLine = ri && ri.tier === 'weak' && ri.toTarget
    ? `\n\nOn reviews: an estimated ${ri.minBelow5}${ri.maxBelow5 > ri.minBelow5 && ri.maxBelow5 < ri.count ? `–${ri.maxBelow5}` : '+'} of your ${ri.count} reviews sit below 5 stars. Reaching the 4.5★ threshold most customers filter by would take around ${ri.toTarget.needed} new 5-star reviews — that's a campaign we run.`
    : ri && (ri.tier === 'perfect' || ri.tier === 'strong') && !lead.website
      ? `\n\nOne more thing: you've earned a ${ri.rating}★ rating from ${ri.count} customers — and none of that is visible to anyone who doesn't already find you on Google. That's a lot of trust going to waste.`
      : '';

  const email = `Subject: Quick question about ${lead.name}'s Google listing

Hi there,

I was searching for "${lead.keyword}" in ${lead.location} and came across ${lead.name}. I ran a quick audit of your Google Business Profile and noticed a few things that are likely costing you customers:

${bullets}${compLine}${reviewLine}

These are all fixable — most within a couple of weeks. I put together a free, no-obligation audit report that shows exactly where you stand against competitors nearby.

Would you be open to a 10-minute call this week? I'll send the full report either way.

Best,
${agency}${s.agencyPhone ? '\n' + s.agencyPhone : ''}${s.agencyEmail ? '\n' + s.agencyEmail : ''}`;

  const call = `CALL SCRIPT — ${lead.name}

Opener:
"Hi, could I speak to the owner or manager? ... Great — I'll be quick. My name is [name] from ${agency}. I was looking up ${lead.keyword} businesses in ${lead.location} and ran a free audit on your Google listing."

Hook (their top problem):
"${topIssues[0] ? topIssues[0].text + ' ' + (topIssues[0].pitch || '') : 'Your online presence has some quick wins available.'}"

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

// ---------------------------------------------------------------- views
const routes = {
  dashboard: viewDashboard,
  find: viewFind,
  leads: viewLeads,
  map: viewMap,
  settings: viewSettings,
  report: viewReport,
};

let lastSearch = null; // cache results between navigations

async function render() {
  $('#modal-root').innerHTML = ''; // close any open modal on navigation
  const hash = location.hash.replace(/^#\//, '') || 'dashboard';
  const [route, param] = hash.split('/');
  const view = routes[route] || viewDashboard;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === route));
  $('#main').innerHTML = '<p class="muted">Loading…</p>';
  await view(param);
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
    ${bar('🔥 Hot', hot, '#f87171')}${bar('☀️ Warm', warm, '#fbbf24')}${bar('❄️ Cold', cold, '#34d399')}
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
        <a class="btn" href="#/find">🔍 Find leads now</a>
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
  $('#main').innerHTML = `
    <h1>Find Leads</h1>
    <p class="subtitle">Search any niche in any city — every result is scored by sales opportunity.</p>
    ${trialBanner()}
    <div class="card">
      <div class="search-row">
        <div class="field"><label>Niche / keyword</label><input id="kw" placeholder="e.g. plumber, dentist, roofing" value="${esc(lastSearch?.keyword || '')}"></div>
        <div class="field"><label>Location</label><input id="loc" placeholder="e.g. Austin TX, Manchester UK" value="${esc(lastSearch?.location || '')}"></div>
        <button id="go">Search</button>
      </div>
      ${feat().deep ? `
      <div style="margin-top:14px;max-width:420px">
        <label>Search depth</label>
        <select id="depth">
          <option value="fast" ${lastSearch?.depth === 'fast' ? 'selected' : ''}>⚡ Fast — top 60 results (~4s)</option>
          <option value="deep" ${!lastSearch || lastSearch.depth === 'deep' || lastSearch.deep ? 'selected' : ''}>🌆 Deep — full city grid, hundreds of leads (~10s)</option>
          <option value="exhaustive" ${lastSearch?.depth === 'exhaustive' ? 'selected' : ''}>🛰️ Exhaustive — maximum coverage (~15s, more API calls)</option>
        </select>
        <div class="muted" style="font-size:12px;margin-top:5px">The grid adapts to the city's size — big cities get more zones automatically.</div>
      </div>` : ''}
      ${isDemo() ? `<p class="muted mt" style="font-size:13px">🧪 Demo mode — sample data only. Enter an access code (Log out → code) for live results.</p>` : ''}
    </div>
    <div id="results"></div>
  `;
  $('#go').onclick = runSearch;
  $('#kw').onkeydown = $('#loc').onkeydown = (e) => { if (e.key === 'Enter') runSearch(); };
  if (lastSearch?.results) renderResults(lastSearch);
}

// Trial/demo banner shown above search + results.
function trialBanner() {
  const p = SESSION?.profile;
  if (!p) return '';
  if (p.type === 'trial') {
    const left = p.remaining ?? p.searchLimit ?? 0;
    return `<div class="banner banner-warn mb">🎟️ <b>Trial account</b> — ${left} of ${p.searchLimit} searches left · up to ${p.resultCap} results each · exports &amp; sharing are disabled. Ask for full access to unlock everything.</div>`;
  }
  if (p.type === 'demo') {
    return `<div class="banner banner-warn mb">🧪 <b>Demo mode</b> — sample data only. Log out and enter an access code for live results.</div>`;
  }
  return '';
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

async function runQuadtree(keyword, location, plan, onProgress) {
  const { config } = plan;
  const found = new Map();
  let calls = 0, zonesSearched = 0, depthReached = 0, truncatedZones = 0;
  let frontier = plan.zones.map((rect) => ({ rect, depth: 0 }));

  while (frontier.length && calls < config.budget) {
    // Chunk this level into server-sized batches, a few in parallel.
    const batches = [];
    for (let i = 0; i < frontier.length; i += ZONES_PER_REQUEST) batches.push(frontier.slice(i, i + ZONES_PER_REQUEST));

    const next = [];
    for (let b = 0; b < batches.length; b += BATCHES_IN_PARALLEL) {
      if (calls >= config.budget) { truncatedZones += batches.slice(b).flat().length; break; }
      const group = batches.slice(b, b + BATCHES_IN_PARALLEL);

      const responses = await Promise.all(group.map(async (batch) => {
        const res = await fetch('/api/zones', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword, location, zones: batch.map((z) => z.rect), code: accessCode() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Zone search failed');
        return { batch, data };
      }));

      for (const { batch, data } of responses) {
        calls += data.calls;
        zonesSearched += data.zonesSearched;
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
    }
    frontier = next;
  }
  if (frontier.length) truncatedZones += frontier.length;

  return {
    results: [...found.values()],
    cells: zonesSearched, apiCalls: calls, depthReached,
    truncatedZones, incomplete: truncatedZones > 0,
  };
}

async function runSearch() {
  const keyword = $('#kw').value.trim();
  const location = $('#loc').value.trim();
  if (!keyword || !location) return toast('Enter both a keyword and a location');
  const depth = feat().deep ? ($('#depth')?.value || 'deep') : 'fast';
  const btn = $('#go');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    if (depth === 'fast') {
      const res = await fetch('/api/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, location, code: accessCode() }),
      });
      const data = await res.json();
      if (res.status === 403 && data.limitReached) return toast('Trial search limit reached — ask for full access to keep searching.');
      if (!res.ok) throw new Error(data.error || 'Search failed');
      if (data.trial && SESSION?.profile) {
        SESSION.profile.remaining = data.trial.remaining;
        SESSION.profile.searchesUsed = data.trial.used;
        setSession(SESSION); renderSessionFoot();
      }
      attachCompetitorStats(data.results);
      lastSearch = { keyword, location, mode: data.mode, deep: false, depth, results: data.results, filters: {} };
      return renderResults(lastSearch);
    }

    // --- deep / exhaustive: plan, then drive the quadtree from here ---
    btn.innerHTML = '<span class="spinner"></span> Locating city…';
    const planRes = await fetch('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, location, depth, code: accessCode() }),
    });
    const plan = await planRes.json();
    if (!planRes.ok) throw new Error(plan.error || 'Could not plan the search');

    if (!plan.cityResolved) {
      // Couldn't pin the city — do a fast search and tell the user why.
      const res = await fetch('/api/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, location, code: accessCode() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      attachCompetitorStats(data.results);
      lastSearch = { keyword, location, mode: data.mode, deep: false, depth, cityResolved: false, results: data.results, filters: {} };
      return renderResults(lastSearch);
    }

    const q = await runQuadtree(keyword, location, plan, ({ found, zonesSearched }) => {
      btn.innerHTML = `<span class="spinner"></span> ${found} found · ${zonesSearched} zones`;
    });

    attachCompetitorStats(q.results);
    q.results.sort((a, b) => b.opportunityScore - a.opportunityScore);
    lastSearch = {
      keyword, location, mode: 'live', deep: true, depth,
      cells: q.cells, apiCalls: q.apiCalls, depthReached: q.depthReached,
      incomplete: q.incomplete, truncatedZones: q.truncatedZones,
      cityResolved: true, resolvedCity: plan.resolvedCity, resolvedLevel: plan.resolvedLevel,
      results: q.results, filters: {},
    };
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
  const topN = Math.min(5, n);
  const top = byReviews.slice(0, topN);
  const avg = (f) => Math.round(top.reduce((s, x) => s + (f(x) || 0), 0) / topN);
  const bench = {
    marketSize: n,
    topN,
    avgReviews: avg((x) => x.reviewCount),
    avgRating: Math.round((top.reduce((s, x) => s + (x.rating || 0), 0) / topN) * 10) / 10,
    avgPhotos: avg((x) => x.photoCount),
    pctWebsite: Math.round((top.filter((x) => x.website).length / topN) * 100),
  };
  for (const r of results) r.competitors = { ...bench, rankByReviews: rank.get(r.placeId) };
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
async function auditAllWebsites(search, btn) {
  const targets = search.results.filter((r) => r.website && !r.webAudit);
  if (!targets.length) return toast('No un-audited websites to check');
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
  toast(`Audited ${done} websites — re-ranked by combined opportunity`);
  renderResults(search);
}

function renderResults(search) {
  const shown = applyFilters(search).sort((a, b) => combinedOpp(b) - combinedOpp(a));
  const saved = new Set(store.local().map((l) => l.id));
  const auditable = search.results.filter((r) => r.website && !r.webAudit).length;
  const audited = search.results.filter((r) => r.webAudit).length;
  $('#results').innerHTML = `
    ${search.mode === 'demo' ? `<div class="banner banner-warn mt">🧪 Demo data (deterministic sample). Add your Google Places API key in Settings for live business data.</div>` : search.deep ? `<div class="banner ${search.resolvedLevel === 'area' || search.incomplete ? 'banner-warn' : 'banner-info'} mt">${search.depth === 'exhaustive' ? '🛰️ Exhaustive scan' : '🌆 Deep search'} — covered <b>${esc(search.resolvedCity || search.location)}</b>, subdividing into ${search.cells} zones (depth ${search.depthReached}) and found ${search.results.length} unique businesses.${search.incomplete ? ` <br>⚠️ ${search.truncatedZones} zone${search.truncatedZones === 1 ? ' is' : 's are'} still denser than we can see — try <b>Exhaustive</b>, or search a narrower area.` : ''}${search.resolvedLevel === 'area' ? ' <br>⚠️ That matched a <b>district</b>, not a whole city — add a country for full coverage (e.g. “São Paulo, Brazil”).' : ''}</div>`
      : search.cityResolved === false ? `<div class="banner banner-warn mt">⚠️ Couldn't pin down “${esc(search.location)}” as a city, so we searched the top 60 instead. Add a country or state for full-city coverage — e.g. <b>Springfield, Illinois</b> or <b>Cambridge, UK</b>.</div>`
      : `<div class="banner banner-info mt">📡 Live Google data (top 60). Switch <b>Search depth</b> to Deep for full-city coverage.</div>`}
    <div class="filter-bar">
      <span class="muted" style="font-size:13px">${shown.length} of ${search.results.length} businesses${audited ? ` · ${audited} audited` : ''}</span>
      ${chip('hot', '🔥 Hot leads (55+)', search)}
      ${chip('noWebsite', 'No website', search)}
      ${chip('unclaimed', 'Unclaimed', search)}
      ${chip('lowRating', 'Rating < 4★', search)}
      ${chip('fewReviews', '< 25 reviews', search)}
      ${audited ? chip('weakWeb', '🌐 Weak website', search) : ''}
      <span style="flex:1"></span>
      ${auditable ? `<button class="btn-sm" id="audit-all">🌐 Audit all websites (${auditable})</button>` : ''}
      <button class="btn-ghost btn-sm" id="save-all">💾 Save all shown</button>
      ${feat().download ? `<button class="btn-ghost btn-sm" id="csv">⬇️ CSV</button>` : ''}
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
  if (!r.webAudit) return '✅';
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

function leadsTable(rows, opts = {}) {
  if (!rows.length) return '<div class="card muted">Nothing here yet.</div>';
  return `<table>
    <thead><tr>
      ${opts.selectable ? '<th style="width:30px"><input type="checkbox" class="sel-all" title="Select all"></th>' : ''}
      <th>Opportunity</th><th>Business</th><th>Rating</th><th>Reviews</th><th>Website</th><th>Grade</th>${opts.saveBtn ? '<th></th>' : '<th>Status</th>'}
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
    <button class="btn-danger btn-sm" id="bulk-del">🗑 Delete selected</button>
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
            <b>🌐 Website audit</b>
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
        <div class="finding"><span class="icon">🔴</span>
          <div><div><b>${esc(w.findings[0].text)}</b></div>
          <div class="pitch">💰 ${esc(w.findings[0].pitch)}</div></div>
        </div>
      </div>`;
  }
  const passed = w.findings.filter((f) => f.ok);
  return `
    <h2 style="font-size:15px">Website audit ${gradeBadge(w.grade)} <span class="muted" style="font-size:12px;font-weight:400">score ${w.websiteScore}/100 · ${(w.ms / 1000).toFixed(1)}s response</span></h2>
    <div class="mb">
      ${w.issues.map((f) => `
        <div class="finding">
          <span class="icon">${f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : 'ℹ️'}</span>
          <div><div>${esc(f.text)}</div>
          ${f.pitch ? `<div class="pitch">💰 ${esc(f.pitch)}</div>` : ''}</div>
        </div>`).join('')}
      ${passed.length ? `<div class="finding"><span class="icon">✅</span><div class="muted">${passed.length} checks passed: ${passed.map((f) => f.label).join(', ')}</div></div>` : ''}
      ${w.emails?.length ? `<div class="finding"><span class="icon">📧</span><div><b>Email found on site:</b> ${w.emails.map(esc).join(', ')}</div></div>` : ''}
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
            <b>⚡ Mobile speed test</b>
            <div class="muted" style="font-size:13px">Real Google Lighthouse score — hard numbers for your pitch. Takes ~15s.</div>
          </div>
          <button class="btn-sm" id="run-pagespeed">Run speed test</button>
        </div>
      </div>`;
  }
  if (!p.ok) {
    return `<div class="banner banner-warn mb">⚡ Speed test unavailable: ${esc(p.error || 'failed')}</div>`;
  }
  const ring = p.score >= 90 ? 'var(--green)' : p.score >= 50 ? 'var(--yellow)' : 'var(--red)';
  const m = p.metrics || {};
  const metricRow = (label, x) => x?.value ? `<div class="flex spread" style="font-size:13px"><span class="muted">${label}</span><span>${esc(x.value)}</span></div>` : '';
  return `
    <h2 style="font-size:15px">⚡ Mobile speed ${gradeBadge(p.grade)}</h2>
    <div class="flex mb" style="align-items:center;gap:16px">
      <div class="score-pill" style="min-width:56px;font-size:20px;background:${ring}22;color:${ring}">${p.score}</div>
      <div style="flex:1;min-width:180px">
        ${metricRow('Largest Contentful Paint', m.lcp)}
        ${metricRow('Speed Index', m.si)}
        ${metricRow('Total Blocking Time', m.tbt)}
        ${metricRow('Cumulative Layout Shift', m.cls)}
      </div>
    </div>
    ${!p.finding.ok ? `<div class="finding"><span class="icon">${p.finding.severity === 'critical' ? '🔴' : '🟡'}</span><div><div>${esc(p.finding.text)}</div><div class="pitch">💰 ${esc(p.finding.pitch)}</div></div></div>` : `<div class="finding"><span class="icon">✅</span><div>${esc(p.finding.text)}</div></div>`}`;
}

// -------- competitor benchmark block (inside lead modal + report)
// -------- review intelligence block (derived from rating + count, no API call)
function reviewBlock(l) {
  const r = l.reviewInsight;
  if (!r) return '';
  const icon = r.tier === 'perfect' ? '🏆' : r.tier === 'strong' ? '⭐' : r.tier === 'weak' ? '🔴' : '🟡';
  return `
    <h2 style="font-size:15px">Review intelligence <span class="badge badge-muted" style="font-weight:400">estimated</span></h2>
    <div class="mb">
      <div class="finding">
        <span class="icon">${icon}</span>
        <div>
          <div>${esc(r.headline)}</div>
          <div class="pitch">💰 ${esc(r.pitch)}</div>
        </div>
      </div>
      ${r.toTarget ? `<div class="finding"><span class="icon">📈</span><div><b>${r.toTarget.needed}</b> new 5★ reviews needed to reach ${r.toTarget.target}★</div></div>` : ''}
      ${!r.perfect && r.starDeficit ? `<div class="finding"><span class="icon">📉</span><div class="muted">${r.starDeficit} stars short of a perfect record · derived from the public ${r.rating}★ average across ${r.count} reviews.</div></div>` : ''}
    </div>`;
}

function competitorBlock(l) {
  const c = l.competitors;
  if (!c || !c.marketSize) return '';
  const cmp = (label, you, avg, higherIsBetter = true) => {
    const behind = higherIsBetter ? (you || 0) < avg : (you || 0) > avg;
    return `<div class="finding"><span class="icon">${behind ? '🔴' : '✅'}</span>
      <div class="flex spread" style="flex:1"><span>${label}</span>
      <span><b>${you ?? 0}</b> <span class="muted">vs ${avg} avg${behind ? ` · ${Math.abs(avg - (you || 0))} behind` : ''}</span></span></div></div>`;
  };
  return `
    <h2 style="font-size:15px">Competitor benchmark</h2>
    <p class="muted" style="font-size:13px">Ranked <b style="color:var(--accent)">#${c.rankByReviews}</b> of ${c.marketSize} by review volume for "${esc(l.keyword)}" in ${esc(l.location)} — vs the top ${c.topN} competitors:</p>
    <div class="mb">
      ${cmp('Reviews', l.reviewCount, c.avgReviews)}
      ${cmp('Rating', l.rating, c.avgRating)}
      ${cmp('Photos', l.photoCount, c.avgPhotos)}
      <div class="finding"><span class="icon">${l.website ? '✅' : '🔴'}</span><div class="flex spread" style="flex:1"><span>Website</span><span><b>${l.website ? 'Yes' : 'No'}</b> <span class="muted">· ${c.pctWebsite}% of top ${c.topN} have one</span></span></div></div>
    </div>`;
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
          ${l.phone ? `<span class="badge badge-muted">📞 ${esc(l.phone)}</span>` : ''}
          ${l.website ? `<a class="badge badge-muted" href="${esc(l.website)}" target="_blank" style="text-decoration:none">🌐 website ↗</a>` : ''}
        </div>
        <h2 style="font-size:15px">GMB audit findings</h2>
        <div class="mb">
          ${l.findings.map((f) => `
            <div class="finding">
              <span class="icon">${f.ok ? '✅' : f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : 'ℹ️'}</span>
              <div><div>${esc(f.text)} <span class="muted" style="font-size:12px">(${f.points}/${f.max} pts)</span></div>
              ${f.pitch ? `<div class="pitch">💰 ${esc(f.pitch)}</div>` : ''}</div>
            </div>`).join('')}
        </div>
        ${l.website ? webAuditBlock(l) : ''}
        ${reviewBlock(l)}
        ${competitorBlock(l)}
        ${isSaved ? `
          <label>Pipeline status <span id="status-fb" class="save-fb"></span></label>
          <select id="lead-status">${STATUSES.map((st) => `<option value="${st}" ${l.status === st ? 'selected' : ''}>${STATUS_LABEL[st]}</option>`).join('')}</select>
          <div class="muted" style="font-size:12px;margin-top:4px">Changes save automatically.</div>
          <label>Notes <span id="notes-fb" class="save-fb"></span></label>
          <textarea id="lead-notes" rows="3" placeholder="Call outcomes, contact name, next steps…">${esc(l.notes || '')}</textarea>` : ''}
        <div class="flex mt spread">
          <div class="flex">
            ${isSaved
              ? `<a class="btn" href="#/report/${encodeURIComponent(l.id)}">📄 Audit report</a>`
              : `<button id="save-lead">💾 Save lead</button>`}
            <button class="btn-wa" id="wa-quick">💬 WhatsApp</button>
            <button class="btn-ghost" id="outreach">✉️ Scripts</button>
          </div>
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

  if (isSaved) {
    $('#lead-status').onchange = async (e) => {
      l.status = e.target.value;
      await store.update(l.id, { status: e.target.value });
      const fb = $('#status-fb');
      fb.textContent = `✓ Moved to ${STATUS_LABEL[e.target.value]}`;
      fb.classList.add('show');
      toast(`Moved to ${STATUS_LABEL[e.target.value]}`);
      setTimeout(() => fb.classList.remove('show'), 2500);
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
  $('#wa-quick').onclick = () => {
    if (!isSaved) store.save(l); // saving is cheap; keeps a record of who you contacted
    openWhatsApp(l);
  };
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

        <div class="flex spread"><label>💬 WhatsApp message ${num ? `<span class="muted">→ ${esc(lead.phoneIntl || lead.phone || '')}</span>` : '<span class="muted">(no number — you’ll pick the contact)</span>'}</label><button class="btn-ghost btn-sm" data-copy="wa">Copy</button></div>
        <textarea class="script" id="script-wa" rows="9">${esc(whatsapp)}</textarea>
        <button class="btn-wa mt" id="wa-send" style="width:100%">💬 Open in WhatsApp with this message</button>

        ${lead.webAudit?.emails?.length ? `<div class="banner banner-info mt">📧 Send email to: <b>${lead.webAudit.emails.map(esc).join(', ')}</b> <span class="muted">(found on their website)</span></div>` : ''}
        <div class="flex spread mt"><label>Cold email</label><button class="btn-ghost btn-sm" data-copy="email">Copy</button></div>
        <textarea class="script" id="script-email" rows="11">${esc(email)}</textarea>
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
  // send whatever the user edited in the textarea
  $('#wa-send').onclick = () => {
    window.open(waLink(lead, $('#script-wa').value), '_blank');
    toast(num ? 'Opened WhatsApp' : 'Opened WhatsApp — pick the contact');
    store.get(lead.placeId || lead.id).then((saved) => {
      if (saved && saved.status === 'new') store.update(saved.id, { status: 'contacted' });
    });
  };
}

// -------- my leads (pipeline)
let leadsView = 'board'; // 'board' | 'list'

async function viewLeads() {
  const leads = await store.list();
  $('#main').innerHTML = `
    <div class="flex spread">
      <div><h1>My Leads</h1><p class="subtitle">${leadsView === 'board' ? 'Open a lead to move it through your pipeline.' : 'Select leads to delete in bulk, or open one to manage it.'}</p></div>
      <div class="flex no-print">
        ${leads.length ? `<div class="seg">
          <button class="seg-btn ${leadsView === 'board' ? 'on' : ''}" data-view="board">▦ Board</button>
          <button class="seg-btn ${leadsView === 'list' ? 'on' : ''}" data-view="list">☰ List</button>
        </div>` : ''}
        ${feat().download ? `<button class="btn-ghost btn-sm" id="csv-all" ${leads.length ? '' : 'disabled'}>⬇️ Export CSV</button>` : ''}
      </div>
    </div>
    ${leads.length === 0
      ? `<div class="card muted">No saved leads yet. <a href="#/find" style="color:var(--accent)">Find some →</a></div>`
      : leadsView === 'list'
        ? `${bulkBarHtml()}<div class="table-wrap">${leadsTable(leads, { selectable: true })}</div>`
        : `<div class="pipeline">
          ${STATUSES.map((st) => {
            const col = leads.filter((l) => (l.status || 'new') === st);
            return `<div class="pipe-col"><h3>${STATUS_LABEL[st]} · ${col.length}</h3>
              ${col.map((l) => `
                <div class="lead-card" data-id="${esc(l.id)}">
                  <div class="name">${esc(l.name)}</div>
                  <div class="meta"><span>${esc(l.keyword || '')}</span>${scorePill(l.opportunityScore)}</div>
                </div>`).join('')}
            </div>`;
          }).join('')}
        </div>`}
  `;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.onclick = () => { leadsView = b.dataset.view; viewLeads(); };
  });
  document.querySelectorAll('.lead-card').forEach((c) => {
    c.onclick = async () => openLeadModal(await store.get(c.dataset.id));
  });
  if (leadsView === 'list') { bindLeadRows(leads); wireSelection(viewLeads); }
  const csvBtn = $('#csv-all');
  if (csvBtn) csvBtn.onclick = () => exportCsv(leads, 'leadlion-pipeline');
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
      ${feat().download ? `<button onclick="window.print()">🖨️ Print / Save as PDF</button>` : ''}
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
      <p style="color:#718096;font-size:13px">Prepared ${new Date().toLocaleDateString()} · Searched as "${esc(lead.keyword)}" in ${esc(lead.location)}</p>

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
          <span class="k">Website</span><span>${lead.website ? 'Yes' : '❌ Missing'}</span>
          <span class="k">Phone</span><span>${lead.phone || '❌ Missing'}</span>
          <span class="k">Photos</span><span>${lead.photoCount ?? 0}</span>
          <span class="k">Hours listed</span><span>${lead.hasHours ? 'Yes' : '❌ Missing'}</span>
        </div>
      </div>

      ${critical.length ? `<div class="report-section"><h2>🔴 Critical issues (${critical.length})</h2>
        ${critical.map((i) => `<div class="report-finding"><span>🔴</span><div><b>${esc(i.text)}</b>${i.pitch ? `<div class="pitch">${esc(i.pitch)}</div>` : ''}</div></div>`).join('')}</div>` : ''}

      ${other.length ? `<div class="report-section"><h2>🟡 Improvement opportunities (${other.length})</h2>
        ${other.map((i) => `<div class="report-finding"><span>🟡</span><div><b>${esc(i.text)}</b>${i.pitch ? `<div class="pitch">${esc(i.pitch)}</div>` : ''}</div></div>`).join('')}</div>` : ''}

      <div class="report-section"><h2>✅ What's working</h2>
        ${lead.findings.filter((f) => f.ok).map((f) => `<div class="report-finding"><span>✅</span><div>${esc(f.text)}</div></div>`).join('')}
      </div>

      ${lead.reviewInsight ? `
      <div class="report-section">
        <h2>⭐ Review Intelligence</h2>
        <p style="color:#4a5568;font-size:14px"><b>${esc(lead.reviewInsight.clientHeadline || lead.reviewInsight.headline)}</b></p>
        <div class="report-finding" style="margin-top:8px"><span>💰</span><div>${esc(lead.reviewInsight.clientPitch || lead.reviewInsight.pitch)}</div></div>
        ${lead.reviewInsight.toTarget ? `<div class="report-finding"><span>📈</span><div><b>${lead.reviewInsight.toTarget.needed}</b> new 5-star reviews would lift the average to ${lead.reviewInsight.toTarget.target}★.</div></div>` : ''}
        <p style="color:#94a3b8;font-size:12px;margin-top:8px">Estimated from the public ${lead.reviewInsight.rating}★ average across ${lead.reviewInsight.count} reviews.</p>
      </div>` : ''}

      ${lead.webAudit ? `
      <div class="report-section">
        <h2>🌐 Website audit — Grade ${lead.webAudit.grade} (${lead.webAudit.websiteScore}/100)</h2>
        ${lead.webAudit.reachable === false
          ? `<div class="report-finding"><span>🔴</span><div><b>${esc(lead.webAudit.findings[0].text)}</b><div class="pitch">${esc(lead.webAudit.findings[0].pitch)}</div></div></div>`
          : `
            ${lead.webAudit.issues.map((i) => `<div class="report-finding"><span>${i.severity === 'critical' ? '🔴' : i.severity === 'warning' ? '🟡' : 'ℹ️'}</span><div><b>${esc(i.text)}</b>${i.pitch ? `<div class="pitch">${esc(i.pitch)}</div>` : ''}</div></div>`).join('')}
            ${lead.webAudit.findings.filter((f) => f.ok).map((f) => `<div class="report-finding"><span>✅</span><div>${esc(f.text)}</div></div>`).join('')}
          `}
      </div>` : ''}

      ${lead.pageSpeed?.ok ? `
      <div class="report-section">
        <h2>⚡ Mobile Speed — ${lead.pageSpeed.score}/100 (Grade ${lead.pageSpeed.grade})</h2>
        <div class="report-meta-grid">
          ${lead.pageSpeed.metrics.lcp?.value ? `<span class="k">Largest Contentful Paint</span><span>${esc(lead.pageSpeed.metrics.lcp.value)}</span>` : ''}
          ${lead.pageSpeed.metrics.si?.value ? `<span class="k">Speed Index</span><span>${esc(lead.pageSpeed.metrics.si.value)}</span>` : ''}
          ${lead.pageSpeed.metrics.tbt?.value ? `<span class="k">Total Blocking Time</span><span>${esc(lead.pageSpeed.metrics.tbt.value)}</span>` : ''}
          ${lead.pageSpeed.metrics.cls?.value ? `<span class="k">Cumulative Layout Shift</span><span>${esc(lead.pageSpeed.metrics.cls.value)}</span>` : ''}
        </div>
        ${!lead.pageSpeed.finding.ok ? `<div class="report-finding" style="margin-top:10px"><span>${lead.pageSpeed.finding.severity === 'critical' ? '🔴' : '🟡'}</span><div><b>${esc(lead.pageSpeed.finding.text)}</b><div class="pitch">${esc(lead.pageSpeed.finding.pitch)}</div></div></div>` : ''}
      </div>` : ''}

      ${lead.competitors?.marketSize ? `
      <div class="report-section">
        <h2>📊 Competitor Benchmark</h2>
        <p style="color:#4a5568;font-size:14px">Ranked <b>#${lead.competitors.rankByReviews}</b> of ${lead.competitors.marketSize} by review volume for "${esc(lead.keyword)}" in ${esc(lead.location)}. Here's how you compare to the top ${lead.competitors.topN} competitors:</p>
        <div class="report-meta-grid" style="margin-top:10px">
          <span class="k">Reviews</span><span>${lead.reviewCount ?? 0} <span style="color:#718096">vs ${lead.competitors.avgReviews} avg${(lead.reviewCount || 0) < lead.competitors.avgReviews ? ` (${lead.competitors.avgReviews - (lead.reviewCount || 0)} behind)` : ''}</span></span>
          <span class="k">Rating</span><span>${lead.rating || 0}★ <span style="color:#718096">vs ${lead.competitors.avgRating}★ avg</span></span>
          <span class="k">Photos</span><span>${lead.photoCount ?? 0} <span style="color:#718096">vs ${lead.competitors.avgPhotos} avg</span></span>
          <span class="k">Website</span><span>${lead.website ? 'Yes' : 'No'} <span style="color:#718096">· ${lead.competitors.pctWebsite}% of top ${lead.competitors.topN} have one</span></span>
        </div>
      </div>` : ''}

      <div class="report-cta">
        <h3>Recommended next steps</h3>
        <p style="font-size:14px;color:#4a5568">${esc(lead.name)} is currently leaving customers on the table. Our recommended priority: <b>${esc([...new Set([...(lead.services || []), ...(lead.webAudit?.issues || []).map((i) => i.service)])].filter(Boolean).join(' → ') || 'GMB optimization')}</b>. ${esc(s.agencyName || 'We')} can typically resolve the critical issues above within 2–4 weeks.</p>
        <p style="font-size:14px;margin-top:8px"><b>Contact:</b> ${esc(s.agencyEmail || 'your@email.com')} ${s.agencyPhone ? '· ' + esc(s.agencyPhone) : ''}</p>
      </div>
    </div>
  `;
  renderSharePanel(lead);
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
        <div><b>🌐 Share this report</b><div class="muted" style="font-size:13px">Publishing a live, trackable report link is available on the full plan.</div></div>
        <span class="badge badge-muted">🔒 Locked</span>
      </div>`;
    return;
  }

  if (!url) {
    panel.innerHTML = `
      <div class="flex spread">
        <div><b>🌐 Share this report</b><div class="muted" style="font-size:13px">Publish a live link you can send on WhatsApp — you'll see when they open it.</div></div>
        <button id="publish-report">Publish shareable link</button>
      </div>`;
    $('#publish-report').onclick = () => publishReport(lead);
    return;
  }

  // published — show link, share buttons, live stats
  panel.innerHTML = `
    <div class="flex spread mb"><b>🌐 Shared report</b> <span class="muted" id="views-stat" style="font-size:13px">checking opens…</span></div>
    <div class="flex" style="gap:8px">
      <input id="report-url" value="${esc(url)}" readonly style="flex:1">
      <button class="btn-sm" id="copy-url">Copy</button>
      <button class="btn-wa btn-sm" id="wa-report">💬 Send</button>
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
      ? `<span class="badge badge-green">👁 Opened ${v.views}×</span> last ${relTime(v.last)}`
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

// -------- settings
async function viewSettings() {
  const s = getSettings();
  $('#main').innerHTML = `
    <h1>Settings</h1>
    <p class="subtitle">Branding appears on your audit reports. Keys are stored only in this browser.</p>

    <div class="card mb">
      <h2 style="margin-top:0">🏢 Agency branding</h2>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><label>Agency name</label><input id="s-name" value="${esc(s.agencyName || '')}" placeholder="Acme Digital"></div>
        <div><label>Tagline</label><input id="s-tag" value="${esc(s.agencyTagline || '')}" placeholder="Local Marketing Specialists"></div>
        <div><label>Email</label><input id="s-email" value="${esc(s.agencyEmail || '')}" placeholder="you@agency.com"></div>
        <div><label>Phone</label><input id="s-phone" value="${esc(s.agencyPhone || '')}" placeholder="(555) 123-4567"></div>
        <div><label>Website</label><input id="s-web" value="${esc(s.agencyWebsite || '')}" placeholder="agency.com"></div>
      </div>
    </div>

    <div class="card mb">
      <h2 style="margin-top:0">💬 WhatsApp outreach</h2>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><label>Greeting</label><input id="s-wagreet" value="${esc(s.waGreeting || '')}" placeholder="Hello / Assalam o Alaikum / Hi"></div>
        <div><label>Default country code <span class="muted">(fallback only)</span></label><input id="s-wacc" value="${esc(s.waCountryCode || '')}" placeholder="92 for Pakistan, 1 for US"></div>
      </div>
      <p class="muted mt" style="font-size:12.5px">The greeting starts every WhatsApp message. The country code is only used as a fallback when Google doesn't provide an international number.</p>
    </div>

    <div class="card mb">
      <h2 style="margin-top:0">🔑 Google Places API key <span class="badge badge-muted">optional</span></h2>
      <p class="muted" style="font-size:13.5px">Without a key you get demo data. Get a free key at <code class="inline">console.cloud.google.com</code> → enable <b>Places API (New)</b> → thousands of free searches/month. For production, set it as a Cloudflare Pages secret <code class="inline">GOOGLE_PLACES_API_KEY</code> instead so it never touches the browser.</p>
      <label>API key</label><input id="s-gkey" type="password" value="${esc(s.googleApiKey || '')}" placeholder="AIza…">
    </div>

    <div class="card mb">
      <h2 style="margin-top:0">🗄️ Supabase sync <span class="badge badge-muted">optional</span></h2>
      <p class="muted" style="font-size:13.5px">Leads live in this browser until you connect Supabase (then they sync across devices). Run <code class="inline">schema.sql</code> in your Supabase SQL editor first.</p>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><label>Project URL</label><input id="s-surl" value="${esc(s.supabaseUrl || '')}" placeholder="https://xxxx.supabase.co"></div>
        <div><label>Anon key</label><input id="s-skey" type="password" value="${esc(s.supabaseKey || '')}" placeholder="eyJ…"></div>
      </div>
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
    toast(ok ? '✅ Supabase connected' : '❌ Could not connect — check URL/key and that schema.sql was run');
  };
}

// -------- csv
function exportCsv(rows, name) {
  const cols = ['name', 'address', 'phone', 'website', 'rating', 'reviewCount', 'opportunityScore', 'grade', 'status', 'keyword', 'location'];
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
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
  b.textContent = supaOk ? 'Supabase synced' : 'Local storage';
  b.className = supaOk ? 'badge badge-green' : 'badge badge-muted';
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
  initSupabase().then(updateStorageBadge).then(render);
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
