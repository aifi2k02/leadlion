// Google PageSpeed Insights (Lighthouse) integration.
// Returns real mobile performance data — hard numbers that turn a "decent"
// site into a sellable lead ("Your site scores 34/100 on mobile").
// Uses PAGESPEED_API_KEY if provided (higher quota), else keyless (low volume).

const PSI = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export async function runPageSpeed(rawUrl, apiKey) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl).href;
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  const params = new URLSearchParams({ url, strategy: 'mobile' });
  params.append('category', 'performance');
  if (apiKey) params.set('key', apiKey);

  let data;
  try {
    const res = await fetch(`${PSI}?${params}`, { signal: AbortSignal.timeout(55000) });
    data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data?.error?.message || `PageSpeed HTTP ${res.status}` };
    }
  } catch (err) {
    return { ok: false, error: `PageSpeed timed out or failed (${String(err?.message || err).slice(0, 80)})` };
  }

  const lh = data.lighthouseResult;
  if (!lh?.categories?.performance) {
    return { ok: false, error: 'PageSpeed returned no performance data for this URL' };
  }

  const score = Math.round((lh.categories.performance.score || 0) * 100);
  const a = lh.audits || {};
  const metric = (id) => (a[id] ? { value: a[id].displayValue || null, score: a[id].score } : null);

  const metrics = {
    lcp: metric('largest-contentful-paint'),   // Largest Contentful Paint
    fcp: metric('first-contentful-paint'),      // First Contentful Paint
    tbt: metric('total-blocking-time'),         // Total Blocking Time
    cls: metric('cumulative-layout-shift'),     // Cumulative Layout Shift
    si: metric('speed-index'),                  // Speed Index
    tti: metric('interactive'),                 // Time to Interactive
  };

  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';

  // Build a sales finding from the score
  let finding;
  if (score >= 90) {
    finding = { ok: true, severity: 'info', text: `Excellent mobile speed (${score}/100).` };
  } else {
    const sev = score < 50 ? 'critical' : 'warning';
    const lcpTxt = metrics.lcp?.value ? ` Largest content paints in ${metrics.lcp.value}` : '';
    finding = {
      ok: false,
      severity: sev,
      text: `Mobile speed is only ${score}/100 (Google Lighthouse).${lcpTxt ? lcpTxt + '.' : ''}`,
      pitch: `${score < 50 ? '53% of mobile visitors abandon a site slower than 3s.' : 'Faster pages rank higher and convert better.'} A speed optimization pass is concrete, measurable work you can charge for — and Google itself provides the before/after proof.`,
      service: 'Website performance',
    };
  }

  return {
    ok: true,
    url,
    score,
    grade,
    metrics,
    finding,
    ranAt: new Date().toISOString(),
  };
}
