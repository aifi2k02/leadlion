// LeadLion scoring engine.
// healthScore (0-100) = how strong the business's GMB presence is.
// opportunityScore = 100 - healthScore = how much an agency can sell them.
// Every point is explainable: each factor produces a finding used in the
// audit report and outreach scripts.

const FACTORS = [
  {
    key: 'website',
    label: 'Website',
    max: 20,
    score: (b) => (b.website ? 20 : 0),
    finding: (b) =>
      b.website
        ? { ok: true, text: 'Has a website linked on the listing.' }
        : {
            ok: false,
            severity: 'critical',
            text: 'No website linked on the Google listing.',
            pitch: 'Businesses without a website lose the ~60% of searchers who want to browse before calling. We can launch a site for you in days.',
            service: 'Website design',
          },
  },
  {
    key: 'rating',
    label: 'Star rating',
    max: 15,
    score: (b) => {
      if (!b.rating) return 0;
      if (b.rating >= 4.5) return 15;
      if (b.rating >= 4.0) return 11;
      if (b.rating >= 3.5) return 7;
      if (b.rating >= 3.0) return 4;
      return 1;
    },
    finding: (b) => {
      if (!b.rating)
        return {
          ok: false,
          severity: 'critical',
          text: 'No star rating yet — the listing looks inactive.',
          pitch: 'A listing with no rating gets skipped. A simple review campaign fixes this in weeks.',
          service: 'Review generation',
        };
      if (b.rating >= 4.5) return { ok: true, text: `Excellent ${b.rating}★ rating.` };
      if (b.rating >= 4.0) return { ok: true, text: `Good ${b.rating}★ rating, room to reach 4.5★.` };
      return {
        ok: false,
        severity: b.rating >= 3.5 ? 'warning' : 'critical',
        text: `Rating is ${b.rating}★ — below the 4.0★ trust threshold.`,
        pitch: `88% of consumers filter out businesses under 4 stars. A review recovery program can raise this fast.`,
        service: 'Reputation management',
      };
    },
  },
  {
    key: 'reviews',
    label: 'Review volume',
    max: 15,
    score: (b) => {
      const n = b.reviewCount || 0;
      if (n >= 100) return 15;
      if (n >= 50) return 12;
      if (n >= 25) return 9;
      if (n >= 10) return 6;
      if (n >= 1) return 3;
      return 0;
    },
    finding: (b) => {
      const n = b.reviewCount || 0;
      if (n >= 50) return { ok: true, text: `Strong review volume (${n} reviews).` };
      if (n >= 10)
        return {
          ok: false,
          severity: 'warning',
          text: `Only ${n} reviews — competitors in this niche typically have 50+.`,
          pitch: 'Review count is a top-3 local ranking factor. An automated review-request flow doubles volume in 90 days.',
          service: 'Review generation',
        };
      return {
        ok: false,
        severity: 'critical',
        text: `Almost no reviews (${n}).`,
        pitch: 'Google buries listings with no social proof. This is the single fastest win available.',
        service: 'Review generation',
      };
    },
  },
  {
    key: 'claimed',
    label: 'Listing claimed',
    max: 10,
    score: (b) => (b.claimed === false ? 0 : 10),
    finding: (b) =>
      b.claimed === false
        ? {
            ok: false,
            severity: 'critical',
            text: 'Listing appears UNCLAIMED — anyone could request ownership.',
            pitch: 'An unclaimed listing means no control over photos, hours, or reviews. We claim and optimize it as step one.',
            service: 'GMB optimization',
          }
        : { ok: true, text: 'Listing appears claimed and managed.' },
  },
  {
    key: 'photos',
    label: 'Photos',
    max: 10,
    score: (b) => {
      const n = b.photoCount || 0;
      if (n >= 10) return 10;
      if (n >= 5) return 7;
      if (n >= 1) return 4;
      return 0;
    },
    finding: (b) => {
      const n = b.photoCount || 0;
      if (n >= 10) return { ok: true, text: `Good photo coverage (${n}+ photos).` };
      return {
        ok: false,
        severity: n === 0 ? 'critical' : 'warning',
        text: n === 0 ? 'No photos on the listing.' : `Only ${n} photo${n === 1 ? '' : 's'} on the listing.`,
        pitch: 'Listings with 10+ photos get 42% more direction requests and 35% more clicks (Google data).',
        service: 'GMB optimization',
      };
    },
  },
  {
    key: 'hours',
    label: 'Business hours',
    max: 10,
    score: (b) => (b.hasHours ? 10 : 0),
    finding: (b) =>
      b.hasHours
        ? { ok: true, text: 'Opening hours are listed.' }
        : {
            ok: false,
            severity: 'warning',
            text: 'No opening hours listed.',
            pitch: '"Is it open now?" is the #1 mobile query. Missing hours sends customers to competitors.',
            service: 'GMB optimization',
          },
  },
  {
    key: 'phone',
    label: 'Phone number',
    max: 5,
    score: (b) => (b.phone ? 5 : 0),
    finding: (b) =>
      b.phone
        ? { ok: true, text: 'Phone number listed (tap-to-call works).' }
        : {
            ok: false,
            severity: 'critical',
            text: 'No phone number on the listing.',
            pitch: 'Mobile searchers can’t tap-to-call — that’s lost revenue every single day.',
            service: 'GMB optimization',
          },
  },
  {
    key: 'description',
    label: 'Business description',
    max: 5,
    score: (b) => (b.description ? 5 : 0),
    finding: (b) =>
      b.description
        ? { ok: true, text: 'Business description present.' }
        : {
            ok: false,
            severity: 'info',
            text: 'No business description / editorial summary.',
            pitch: 'A keyword-rich description helps the listing rank for more searches.',
            service: 'GMB optimization',
          },
  },
  {
    key: 'category',
    label: 'Category set',
    max: 5,
    score: (b) => (b.category ? 5 : 0),
    finding: (b) =>
      b.category
        ? { ok: true, text: `Primary category: ${b.category}.` }
        : {
            ok: false,
            severity: 'warning',
            text: 'No primary category detected.',
            pitch: 'The primary category is the strongest ranking signal a listing controls.',
            service: 'GMB optimization',
          },
  },
  {
    key: 'status',
    label: 'Operational status',
    max: 5,
    score: (b) => (b.businessStatus === 'OPERATIONAL' || !b.businessStatus ? 5 : 0),
    finding: (b) =>
      b.businessStatus && b.businessStatus !== 'OPERATIONAL'
        ? { ok: false, severity: 'critical', text: `Listing marked ${b.businessStatus.replace(/_/g, ' ').toLowerCase()}.`, pitch: 'A wrongly-flagged status kills all traffic. We can fix it with Google.', service: 'GMB optimization' }
        : { ok: true, text: 'Listing marked operational.' },
  },
];

export function scoreBusiness(b) {
  let health = 0;
  const findings = [];
  for (const f of FACTORS) {
    const pts = f.score(b);
    health += pts;
    const finding = f.finding(b);
    findings.push({ factor: f.key, label: f.label, points: pts, max: f.max, ...finding });
  }
  const issues = findings.filter((f) => !f.ok);
  const grade =
    health >= 85 ? 'A' : health >= 70 ? 'B' : health >= 55 ? 'C' : health >= 40 ? 'D' : 'F';
  return {
    healthScore: health,
    opportunityScore: 100 - health,
    grade,
    findings,
    issues,
    services: [...new Set(issues.map((i) => i.service).filter(Boolean))],
  };
}
