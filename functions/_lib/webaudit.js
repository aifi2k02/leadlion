// LeadLion Website Audit Engine.
// Fetches a lead's website and scores it 0-100 across 13 factors, each with
// a finding + sales pitch — same explainable pattern as the GMB scoring
// engine. Runs server-side in a Pages Function (regex heuristics, no DOM).

const MAX_HTML_BYTES = 1_500_000; // cap parsing work on huge pages

export async function auditWebsite(rawUrl) {
  let url;
  try {
    url = normalizeUrl(rawUrl);
  } catch {
    return unreachable(rawUrl, 'Invalid website URL on the listing.');
  }

  const started = Date.now();
  let res, html;
  try {
    res = await fetchSite(url);
    const buf = await res.arrayBuffer();
    html = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_HTML_BYTES));
  } catch (err) {
    // https failed — try http downgrade so we can still audit (and flag SSL)
    if (url.startsWith('https://')) {
      try {
        const httpUrl = url.replace('https://', 'http://');
        res = await fetchSite(httpUrl);
        const buf = await res.arrayBuffer();
        html = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_HTML_BYTES));
        url = httpUrl;
      } catch {
        return unreachable(rawUrl, `Website did not respond (${trimErr(err)}).`);
      }
    } else {
      return unreachable(rawUrl, `Website did not respond (${trimErr(err)}).`);
    }
  }
  const ms = Date.now() - started;

  if (res.status >= 400) {
    return unreachable(rawUrl, `Website returns an error (HTTP ${res.status}).`);
  }

  const finalUrl = res.url || url;
  const page = analyzeHtml(html);
  const sizeKB = Math.round(html.length / 1024);

  const checks = buildChecks({ finalUrl, ms, sizeKB, page, status: res.status });
  let score = 0;
  const findings = [];
  for (const c of checks) {
    score += c.points;
    findings.push(c);
  }
  const issues = findings.filter((f) => !f.ok);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';

  return {
    ok: true,
    url: rawUrl,
    finalUrl,
    status: res.status,
    ms,
    sizeKB,
    websiteScore: score,
    grade,
    findings,
    issues,
    emails: page.emails.slice(0, 3),
    auditedAt: new Date().toISOString(),
  };
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('empty');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u).href; // throws if invalid
}

async function fetchSite(url) {
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 LeadLionAudit/1.0',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en',
    },
  });
}

function trimErr(err) {
  const m = String(err?.message || err || 'network error');
  return m.length > 80 ? m.slice(0, 80) + '…' : m;
}

function unreachable(url, reason) {
  const finding = {
    factor: 'reachable', label: 'Site availability', points: 0, max: 100, ok: false,
    severity: 'critical',
    text: reason,
    pitch: 'Their Google listing sends customers to a dead or broken website — every click is a lost customer. This is the most urgent (and easiest to demonstrate) fix you can sell.',
    service: 'Website design',
  };
  return {
    ok: true, // audit completed — the *site* failed, which is itself the finding
    url,
    reachable: false,
    websiteScore: 0,
    grade: 'F',
    ms: null,
    findings: [finding],
    issues: [finding],
    emails: [],
    auditedAt: new Date().toISOString(),
  };
}

function analyzeHtml(html) {
  const lower = html.toLowerCase();
  const get = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };

  const title = get(/<title[^>]*>([^<]*)<\/title>/i);
  const metaDesc =
    get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    get(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);

  // strip tags for a rough visible word count
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const wordCount = (text.match(/[a-zA-Z؀-ۿ]{2,}/g) || []).length;

  const emails = [...new Set((html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
    .filter((e) => !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(e) && !e.includes('example.') && !e.includes('sentry') && !e.includes('wixpress'))
  )];

  return {
    title,
    metaDesc,
    wordCount,
    emails,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    hasH1: /<h1[\s>]/i.test(html),
    hasTel: /href=["']tel:/i.test(html),
    hasMailto: /href=["']mailto:/i.test(html),
    hasForm: /<form[\s>]/i.test(html),
    hasWhatsApp: /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i.test(html),
    hasBooking: /book\s*(an\s*)?(appointment|online|now)|schedule\s*(a\s*)?(visit|call|appointment)|reservation/i.test(lower),
    hasAnalytics: /googletagmanager|google-analytics|gtag\(|fbq\(|clarity\.ms|plausible|posthog/i.test(lower),
    hasSchema: /application\/ld\+json/i.test(lower),
    hasFavicon: /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(html),
    socialCount: ['facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'linkedin.com', 'x.com', 'twitter.com']
      .filter((s) => lower.includes(s)).length,
  };
}

function buildChecks({ finalUrl, ms, sizeKB, page }) {
  const F = [];
  const add = (factor, label, max, points, ok, extras = {}) =>
    F.push({ factor, label, max, points, ok, ...extras });

  const https = finalUrl.startsWith('https://');
  add('https', 'Secure (HTTPS)', 10, https ? 10 : 0, https, https ? { text: 'Site uses HTTPS.' } : {
    severity: 'critical',
    text: 'Site is NOT secure — browsers show a "Not Secure" warning.',
    pitch: 'Chrome flags this site as Not Secure next to the address bar. Patients/customers bounce instantly. An SSL setup is a same-day fix.',
    service: 'Website fixes',
  });

  const fast = ms < 1500, okSpeed = ms < 3500;
  add('speed', 'Load speed', 10, fast ? 10 : okSpeed ? 6 : 2, okSpeed, okSpeed
    ? { text: `Server responded in ${(ms / 1000).toFixed(1)}s.` }
    : {
        severity: 'warning',
        text: `Slow response — ${(ms / 1000).toFixed(1)}s before the page even starts loading.`,
        pitch: '53% of mobile visitors abandon a site that takes over 3s to load (Google). Speed work directly recovers lost customers.',
        service: 'Website fixes',
      });

  add('viewport', 'Mobile-friendly', 10, page.hasViewport ? 10 : 0, page.hasViewport, page.hasViewport
    ? { text: 'Mobile viewport configured.' }
    : {
        severity: 'critical',
        text: 'Not mobile-friendly — no responsive viewport set.',
        pitch: 'Over 70% of local searches happen on phones. A site that needs pinch-zooming loses those visitors and ranks worse on Google.',
        service: 'Website design',
      });

  const titleOk = !!page.title && page.title.length >= 10 && page.title.length <= 65;
  add('title', 'SEO title tag', 10, page.title ? (titleOk ? 10 : 6) : 0, !!page.title, page.title
    ? (titleOk ? { text: `Good title tag ("${page.title.slice(0, 50)}${page.title.length > 50 ? '…' : ''}").` } : {
        severity: 'info',
        text: `Title tag is ${page.title.length < 10 ? 'too short' : 'too long'} (${page.title.length} chars).`,
        pitch: 'The title tag is the headline Google shows. Tuning it lifts click-through for free.',
        service: 'SEO',
      })
    : {
        severity: 'critical',
        text: 'Missing SEO title tag.',
        pitch: 'Google has to guess what this business does. Basic on-page SEO is quick, visible work.',
        service: 'SEO',
      });

  const descOk = !!page.metaDesc && page.metaDesc.length >= 50 && page.metaDesc.length <= 165;
  add('metaDesc', 'Meta description', 10, page.metaDesc ? (descOk ? 10 : 6) : 0, !!page.metaDesc, page.metaDesc
    ? (descOk ? { text: 'Meta description present and well-sized.' } : { severity: 'info', text: `Meta description is ${page.metaDesc.length < 50 ? 'too short' : 'too long'}.`, pitch: 'A tuned description raises Google click-through at zero ad cost.', service: 'SEO' })
    : {
        severity: 'warning',
        text: 'No meta description — Google shows random page text instead.',
        pitch: 'The search snippet is the business’s free ad. Right now it’s auto-generated noise.',
        service: 'SEO',
      });

  add('h1', 'Page headline (H1)', 5, page.hasH1 ? 5 : 0, page.hasH1, page.hasH1
    ? { text: 'Main headline (H1) present.' }
    : { severity: 'info', text: 'No H1 headline on the page.', pitch: 'Search engines weigh the H1 heavily when ranking local pages.', service: 'SEO' });

  const contact = page.hasTel || page.hasForm || page.hasMailto;
  add('contact', 'Contact options', 10, page.hasTel ? 10 : contact ? 6 : 0, contact, contact
    ? { text: page.hasTel ? 'Tap-to-call phone link present.' : 'Contact form/email present (no tap-to-call link).' }
    : {
        severity: 'critical',
        text: 'No phone link, contact form, or email found on the homepage.',
        pitch: 'Visitors literally cannot contact them from the site. Adding tap-to-call + a form converts existing traffic into calls immediately.',
        service: 'Website fixes',
      });

  add('whatsapp', 'WhatsApp button', 5, page.hasWhatsApp ? 5 : 0, page.hasWhatsApp, page.hasWhatsApp
    ? { text: 'WhatsApp chat link present.' }
    : {
        severity: 'warning',
        text: 'No WhatsApp button — customers here expect to chat before visiting.',
        pitch: 'A WhatsApp click-to-chat button is a 10-minute add that typically becomes the #1 enquiry channel for local businesses.',
        service: 'Website fixes',
      });

  add('booking', 'Online booking', 5, page.hasBooking ? 5 : 0, page.hasBooking, page.hasBooking
    ? { text: 'Booking/appointment option detected.' }
    : { severity: 'info', text: 'No online booking/appointment option detected.', pitch: 'After-hours visitors can’t commit. Online booking captures customers while competitors sleep.', service: 'Website fixes' });

  add('content', 'Page content', 5, page.wordCount >= 300 ? 5 : page.wordCount >= 100 ? 3 : 0, page.wordCount >= 100,
    page.wordCount >= 100
      ? { text: `Reasonable content depth (~${page.wordCount} words).` }
      : { severity: 'warning', text: `Very thin content (~${page.wordCount} words).`, pitch: 'Google can’t rank a page that says nothing. Service pages with real content lift rankings across the board.', service: 'SEO' });

  add('schema', 'Structured data', 5, page.hasSchema ? 5 : 0, page.hasSchema, page.hasSchema
    ? { text: 'Structured data (schema.org) present.' }
    : { severity: 'info', text: 'No LocalBusiness structured data.', pitch: 'Schema markup helps Google show rich results (stars, hours) — competitors with it look better in search.', service: 'SEO' });

  add('analytics', 'Analytics installed', 5, page.hasAnalytics ? 5 : 0, page.hasAnalytics, page.hasAnalytics
    ? { text: 'Analytics/tracking installed.' }
    : { severity: 'info', text: 'No analytics — the business is flying blind.', pitch: 'They have no idea how many customers the site brings. Installing analytics is step one of any retainer.', service: 'Marketing' });

  add('social', 'Social links', 5, page.socialCount >= 2 ? 5 : page.socialCount === 1 ? 3 : 0, page.socialCount >= 1,
    page.socialCount >= 1
      ? { text: `${page.socialCount} social profile link${page.socialCount > 1 ? 's' : ''} found.` }
      : { severity: 'info', text: 'No social media links on the site.', pitch: 'Social proof is invisible here even if their pages exist — a quick connect job.', service: 'Marketing' });

  const light = sizeKB < 2500;
  add('weight', 'Page weight', 5, light ? 5 : 2, light, light
    ? { text: `Page weight OK (${sizeKB} KB HTML).` }
    : { severity: 'info', text: `Heavy page (${sizeKB} KB of HTML).`, pitch: 'Bloated pages crawl on mobile data — trimming them is quick performance work.', service: 'Website fixes' });

  return F;
}
