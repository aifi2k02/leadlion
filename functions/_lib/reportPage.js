// Server-side renderer for the public, shareable audit report.
// Produces a self-contained HTML document (inline CSS) from stored report data.
// This is the client-facing artifact — polished, light theme, print-friendly.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function findingRow(f) {
  const icon = f.ok ? '✅' : f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : 'ℹ️';
  return `<div class="finding"><span class="ic">${icon}</span><div><div class="ft">${esc(f.text)}</div>${f.pitch ? `<div class="fp">${esc(f.pitch)}</div>` : ''}</div></div>`;
}

export function renderReportPage(d) {
  const a = d.agency || {};
  const ringColor = d.healthScore >= 70 ? '#16a34a' : d.healthScore >= 45 ? '#d97706' : '#dc2626';
  const gmbIssues = (d.findings || []).filter((f) => !f.ok);
  const gmbOk = (d.findings || []).filter((f) => f.ok);
  const w = d.webAudit;
  const ps = d.pageSpeed;

  const services = [...new Set([...(d.services || []), ...((w?.issues) || []).map((i) => i.service)])].filter(Boolean).join(' → ') || 'GMB optimization';

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
  .fp{color:#4a5568;font-size:13px;margin-top:2px}
  .speed{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
  .spill{min-width:64px;height:64px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff}
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
        <span class="k">Website</span><span>${d.website ? 'Yes' : '❌ Missing'}</span>
        <span class="k">Phone</span><span>${esc(d.phone || '❌ Missing')}</span>
        <span class="k">Photos</span><span>${d.photoCount ?? 0}</span>
        <span class="k">Hours listed</span><span>${d.hasHours ? 'Yes' : '❌ Missing'}</span>
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

    ${d.competitors && d.competitors.marketSize ? `<div class="section"><h2>📊 Competitor Benchmark</h2>
      <p style="color:#4a5568;font-size:14px">Ranked <b>#${d.competitors.rankByReviews}</b> of ${d.competitors.marketSize} by review volume for "${esc(d.keyword || '')}" in ${esc(d.location || '')}. Compared to the top ${d.competitors.topN} competitors:</p>
      <div class="meta" style="margin-top:10px">
        <span class="k">Reviews</span><span>${d.reviewCount ?? 0} <span style="color:#718096">vs ${d.competitors.avgReviews} avg${(d.reviewCount || 0) < d.competitors.avgReviews ? ` (${d.competitors.avgReviews - (d.reviewCount || 0)} behind)` : ''}</span></span>
        <span class="k">Rating</span><span>${d.rating || 0}★ <span style="color:#718096">vs ${d.competitors.avgRating}★ avg</span></span>
        <span class="k">Photos</span><span>${d.photoCount ?? 0} <span style="color:#718096">vs ${d.competitors.avgPhotos} avg</span></span>
        <span class="k">Website</span><span>${d.website ? 'Yes' : 'No'} <span style="color:#718096">· ${d.competitors.pctWebsite}% of top ${d.competitors.topN} have one</span></span>
      </div>
    </div>` : ''}

    <div class="cta">
      <h3>Recommended next steps</h3>
      <p style="font-size:14px;color:#4a5568">${esc(d.name)} is leaving customers on the table. Priority: <b>${esc(services)}</b>. ${esc(a.name || 'We')} can typically resolve the critical issues above within 2–4 weeks.</p>
      ${a.email || a.phone ? `<p style="font-size:14px;margin-top:8px"><b>Get in touch:</b> ${esc(a.email || '')} ${a.phone ? '· ' + esc(a.phone) : ''}</p>` : ''}
      ${a.website ? `<a class="btn" href="${/^https?:/.test(a.website) ? esc(a.website) : 'https://' + esc(a.website)}" target="_blank">Visit ${esc(a.name || 'our site')}</a>` : ''}
    </div>

    <div class="foot">Audit generated by ${esc(a.name || 'LeadLion')}. This report is confidential.</div>
  </div>
</body></html>`;
}
