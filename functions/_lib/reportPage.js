// Server-side renderer for the public, shareable audit report.
// Produces a self-contained HTML document (inline CSS) from stored report data.
// This is the client-facing artifact — polished, light theme, print-friendly.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inline icons for the client-facing report (no emoji — they render differently
// on every device and read as unprofessional on a document a prospect keeps).
const RICONS = {
  check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14 9 11"/>',
  alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><path d="M12 16h.01"/>',
  triangle: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><path d="M12 8h.01"/>',
  dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  trendUp: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/>',
  barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};
function rico(name, cls) {
  return `<svg class="rico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RICONS[name] || ''}</svg>`;
}
function sevRico(sev) {
  if (sev === 'ok' || sev === true) return rico('check', 'sv-ok');
  if (sev === 'critical') return rico('alert', 'sv-critical');
  if (sev === 'warning') return rico('triangle', 'sv-warning');
  return rico('info', 'sv-info');
}

function findingRow(f) {
  return `<div class="finding"><span class="ic">${sevRico(f.ok ? 'ok' : f.severity)}</span><div><div class="ft">${esc(f.text)}</div>${f.pitch ? `<div class="fp">${esc(f.pitch)}</div>` : ''}</div></div>`;
}

export function renderReportPage(d) {
  const a = d.agency || {};
  const ringColor = d.healthScore >= 70 ? '#16a34a' : d.healthScore >= 45 ? '#d97706' : '#dc2626';
  const gmbIssues = (d.findings || []).filter((f) => !f.ok);
  const gmbOk = (d.findings || []).filter((f) => f.ok);
  const w = d.webAudit;
  const ps = d.pageSpeed;

  const services = [...new Set([...(d.services || []), ...((w?.issues) || []).map((i) => i.service)])].filter(Boolean).join(' → ') || 'GMB optimization';

  // Match the closing paragraph to what was actually found. A Grade-A listing
  // told we'll "resolve the critical issues above" reads as a form letter.
  const criticals = gmbIssues.filter((f) => f.severity === 'critical').length
    + ((w?.issues) || []).filter((i) => i.severity === 'critical').length;
  const totalIssues = gmbIssues.length + ((w?.issues) || []).length;
  const We = a.name || 'We';   // sentence-initial
  const we = a.name || 'we';   // mid-sentence
  const one = totalIssues === 1;
  const cta =
    criticals > 0
      ? `${esc(d.name)} is leaving customers on the table. Priority: <b>${esc(services)}</b>. ${esc(We)} can typically resolve the ${criticals} critical issue${criticals === 1 ? '' : 's'} above within 2–4 weeks.`
      : totalIssues > 0
        ? `${esc(d.name)}'s online presence is in good shape — the ${totalIssues} opportunit${one ? 'y' : 'ies'} above ${one ? 'is' : 'are'} the difference between good and dominant. Priority: <b>${esc(services)}</b>. ${esc(We)} can typically deliver ${one ? 'it' : 'these'} within 2–4 weeks.`
        : `${esc(d.name)}'s listing is already performing strongly, and there is nothing urgent to fix. The opportunity now is growth rather than repair — ${esc(we)} would focus on <b>${esc(services)}</b> to widen the gap on nearby competitors.`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.name)} — Google Business Audit${a.name ? ' · ' + esc(a.name) : ''}</title>
<meta name="robots" content="noindex">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;color:#1a202c;line-height:1.55;padding:24px 14px}
  .page{background:#fff;max-width:820px;margin:0 auto;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.08);padding:44px 50px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #f5a623;padding-bottom:18px;margin-bottom:26px;gap:20px;flex-wrap:wrap}
  .agency{font-weight:700;font-size:19px}
  .agency .sub{font-weight:400;color:#718096;font-size:13px}
  .contact{text-align:right;font-size:13px;color:#718096}
  h1{font-size:26px;letter-spacing:-.5px}
  h2{font-size:17px;margin:0 0 12px}
  .muted{color:#718096;font-size:13px}
  .ring{width:130px;height:130px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto}
  .ring .inner{background:#fff;width:104px;height:104px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .ring .num{font-size:36px;font-weight:800}
  .ring .den{font-size:11px;font-weight:500;color:#718096}
  .grade{text-align:center;margin:22px 0 30px}
  .grade .label{color:#718096;font-size:13px;margin-top:8px}
  .section{margin-bottom:28px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;font-size:14px}
  .meta .k{color:#718096}
  .finding{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #e2e8f0;font-size:14px}
  .finding:last-child{border:none}
  .ic{flex-shrink:0}
  .rico{width:17px;height:17px;flex-shrink:0;vertical-align:-3px;margin-top:1px}
  h2 .rico{width:18px;height:18px;vertical-align:-3px;margin-right:3px}
  .sv-critical{color:#dc2626}.sv-warning{color:#d97706}.sv-ok{color:#16a34a}.sv-info{color:#2563eb}.sv-pitch{color:#b45309}.sv-praise{color:#16a34a}
  .fp{color:#4a5568;font-size:13px;margin-top:2px}
  .speed{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
  .spill{min-width:64px;height:64px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff}
  .quote{border-left:3px solid #f5a623;background:#fffaf0;padding:8px 12px;margin:6px 0 4px;border-radius:0 6px 6px 0;font-style:italic;font-size:13.5px;line-height:1.5}
  .quote cite{display:block;font-style:normal;font-size:12px;color:#718096;margin-top:5px}
  .cta{background:#fff7e8;border:1px solid #f5a623;border-radius:12px;padding:20px 24px;margin-top:28px}
  .cta h3{margin-bottom:6px}
  .btn{display:inline-block;background:#f5a623;color:#1a1205;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:9px;margin-top:12px}
  .foot{text-align:center;color:#94a3b8;font-size:12px;margin-top:26px}
  @media print{body{background:#fff;padding:0}.page{box-shadow:none;border-radius:0;max-width:none}}
  @media(max-width:620px){.page{padding:26px 20px}.meta{grid-template-columns:1fr}}
</style></head>
<body>
  <div class="page">
    <div class="head">
      <div class="agency">${esc(a.name || 'Business Audit')}<div class="sub">${esc(a.tagline || '')}</div></div>
      <div class="contact">${esc(a.email || '')}${a.phone ? '<br>' + esc(a.phone) : ''}${a.website ? '<br>' + esc(a.website) : ''}</div>
    </div>

    <h1>Google Business Profile Audit</h1>
    <p style="color:#4a5568">${esc(d.name)} · ${esc(d.address || '')}</p>
    <p class="muted">Prepared ${esc(new Date(d.createdAt || Date.now()).toLocaleDateString())}${d.keyword ? ` · Found searching "${esc(d.keyword)}" in ${esc(d.location || '')}` : ''}</p>

    <div class="grade">
      <div class="ring" style="background:conic-gradient(${ringColor} ${(d.healthScore || 0) * 3.6}deg,#e2e8f0 0)">
        <div class="inner"><div class="num">${d.healthScore ?? 0}</div><div class="den">/ 100</div></div>
      </div>
      <div class="label">Listing Health Score — Grade <b>${esc(d.grade || '-')}</b></div>
    </div>

    <div class="section">
      <h2>Snapshot</h2>
      <div class="meta">
        <span class="k">Star rating</span><span>${d.rating ? d.rating + ' ★' : 'No rating'}</span>
        <span class="k">Reviews</span><span>${d.reviewCount ?? 0}</span>
        <span class="k">Website</span><span>${d.website ? 'Yes' : rico('x', 'sv-critical') + ' Missing'}</span>
        <span class="k">Phone</span><span>${d.phone ? esc(d.phone) : rico('x', 'sv-critical') + ' Missing'}</span>
        <span class="k">Photos</span><span>${d.photoCount ?? 0}</span>
        <span class="k">Hours listed</span><span>${d.hasHours ? 'Yes' : rico('x', 'sv-critical') + ' Missing'}</span>
      </div>
    </div>

    ${gmbIssues.length ? `<div class="section"><h2>Issues found (${gmbIssues.length})</h2>${gmbIssues.map(findingRow).join('')}</div>` : ''}
    ${gmbOk.length ? `<div class="section"><h2>What's working</h2>${gmbOk.map(findingRow).join('')}</div>` : ''}

    ${w && w.reachable !== false ? `<div class="section"><h2>Website Audit — Grade ${esc(w.grade)} (${w.websiteScore}/100)</h2>
      ${(w.issues || []).map(findingRow).join('')}
      ${(w.findings || []).filter((f) => f.ok).map(findingRow).join('')}
    </div>` : ''}
    ${w && w.reachable === false ? `<div class="section"><h2>Website Audit</h2>${findingRow(w.findings[0])}</div>` : ''}

    ${ps && ps.ok ? `<div class="section"><h2>Mobile Speed — ${ps.score}/100 (Grade ${esc(ps.grade)})</h2>
      <div class="speed">
        <div class="spill" style="background:${ps.score >= 90 ? '#16a34a' : ps.score >= 50 ? '#d97706' : '#dc2626'}">${ps.score}</div>
        <div class="meta" style="flex:1;min-width:200px">
          ${ps.metrics?.lcp?.value ? `<span class="k">Largest Contentful Paint</span><span>${esc(ps.metrics.lcp.value)}</span>` : ''}
          ${ps.metrics?.si?.value ? `<span class="k">Speed Index</span><span>${esc(ps.metrics.si.value)}</span>` : ''}
          ${ps.metrics?.tbt?.value ? `<span class="k">Total Blocking Time</span><span>${esc(ps.metrics.tbt.value)}</span>` : ''}
        </div>
      </div>
      ${!ps.finding.ok ? `<div style="margin-top:10px">${findingRow(ps.finding)}</div>` : ''}
    </div>` : ''}

    ${d.reviewInsight ? `<div class="section"><h2>${rico('star', 'sv-pitch')} Review Intelligence</h2>
      <p style="color:#1a202c;font-size:15px;font-weight:600">${esc(d.reviewInsight.clientHeadline || d.reviewInsight.headline)}</p>
      <div class="finding" style="margin-top:8px"><span class="ic">${rico('dollar', 'sv-pitch')}</span><div><div class="ft">${esc(d.reviewInsight.clientPitch || d.reviewInsight.pitch)}</div></div></div>
      ${d.reviewInsight.toTarget ? `<div class="finding"><span class="ic">${rico('trendUp', 'sv-info')}</span><div><div class="ft"><b>${d.reviewInsight.toTarget.needed}</b> new 5-star reviews would lift the average to ${d.reviewInsight.toTarget.target}★.</div></div></div>` : ''}
      <p class="muted" style="font-size:12px;margin-top:8px">Estimated from the public ${esc(String(d.reviewInsight.rating))}★ average across ${d.reviewInsight.count} reviews.</p>
    </div>` : ''}

    ${d.reviewMining && (d.reviewMining.themes || []).length ? `<div class="section"><h2>${rico('megaphone')} What your customers are saying</h2>
      <p style="color:#4a5568;font-size:14px">${esc(d.reviewMining.clientSummary)}</p>
      <div style="margin-top:8px">${d.reviewMining.themes.map((t) => `<div class="finding"><span class="ic">${t.sentiment === 'praise' ? rico('heart', 'sv-praise') : rico('alert', 'sv-critical')}</span><div>
        <div class="ft"><b>${esc(t.label)}</b></div>
        ${t.quote ? `<blockquote class="quote">“${esc(t.quote)}”<cite>— ${esc(t.quoteAuthor || 'a customer')}${t.quoteRating ? `, ${t.quoteRating}★` : ''}</cite></blockquote>` : ''}
      </div></div>`).join('')}</div>
      <p class="muted" style="font-size:12px;margin-top:8px">Based on the ${d.reviewMining.sampled} review${d.reviewMining.sampled === 1 ? '' : 's'} Google displays publicly${d.reviewMining.totalReviews ? ` of ${d.reviewMining.totalReviews} total` : ''}. Quotes are reproduced verbatim.</p>
    </div>` : ''}

    ${d.competitors && d.competitors.marketSize ? `<div class="section"><h2>${rico('barChart')} Competitor Benchmark</h2>
      <p style="color:#4a5568;font-size:14px">Ranked <b>#${d.competitors.rankByReviews}</b> of ${d.competitors.marketSize} by review volume for "${esc(d.keyword || '')}" in ${esc(d.location || '')}. Compared to the typical competitor:</p>
      <div class="meta" style="margin-top:10px">
        <span class="k">Reviews</span><span>${d.reviewCount ?? 0} <span style="color:#718096">vs ${d.competitors.medReviews} typical${(d.reviewCount || 0) < d.competitors.medReviews ? ` (${d.competitors.medReviews - (d.reviewCount || 0)} behind)` : ''}</span></span>
        <span class="k">Rating</span><span>${d.rating || 0}★ <span style="color:#718096">vs ${d.competitors.medRating}★ typical</span></span>
        <span class="k">Photos</span><span>${d.photoCount ?? 0} <span style="color:#718096">vs ${d.competitors.medPhotos} typical</span></span>
        <span class="k">Website</span><span>${d.website ? 'Yes' : 'No'} <span style="color:#718096">· ${d.competitors.pctWebsite}% of competitors have one</span></span>
      </div>
    </div>` : ''}

    ${d.demoSiteUrl ? `<div class="section"><h2>${rico('globe')} Your new website — ready to preview</h2>
      <p style="color:#4a5568;font-size:14px">We've already built a preview of a modern website for ${esc(d.name)}. Take a look:</p>
      <p style="margin-top:8px"><a href="${esc(d.demoSiteUrl)}" style="color:#146682;font-weight:700;word-break:break-all">${esc(d.demoSiteUrl)}</a></p>
    </div>` : ''}

    <div class="cta">
      <h3>Recommended next steps</h3>
      <p style="font-size:14px;color:#4a5568">${cta}</p>
      ${a.email || a.phone ? `<p style="font-size:14px;margin-top:8px"><b>Get in touch:</b> ${esc(a.email || '')} ${a.phone ? '· ' + esc(a.phone) : ''}</p>` : ''}
      ${a.website ? `<a class="btn" href="${/^https?:/.test(a.website) ? esc(a.website) : 'https://' + esc(a.website)}" target="_blank">Visit ${esc(a.name || 'our site')}</a>` : ''}
    </div>

    <div class="foot">Audit generated by ${esc(a.name || 'LeadLion')}. This report is confidential.</div>
  </div>
</body></html>`;
}
