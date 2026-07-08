// AI review mining — reads the review TEXT Google exposes and turns it into
// pitch ammo (complaint themes + verbatim quotes) and a sellable deliverable
// (drafted owner replies).
//
// This is a DIFFERENT feature from `reviewInsight()` in scoring.js:
//   reviewInsight  = arithmetic on the public rating + count. Provable, free.
//   mineReviews    = a model reading the actual review text. Inference, costs money.
//
// ⚠️ COST: requesting the `reviews` field puts a Places call into Google's
// "Enterprise + Atmosphere" SKU — the most expensive tier. NEVER add `reviews`
// to the search FIELD_MASK in places.js; that would bill the top SKU for every
// row of a 1,600-lead deep search. It is fetched here ON DEMAND, one lead at a
// time, and the result is cached in KV (see api/reviews.js).
//
// ⚠️ SAMPLE: Google returns at most 5 reviews per business, chosen by "most
// relevant" — which skews positive. There is no sort-by-worst. For a business
// with 400 reviews we are reading 5. Everything derived here is therefore
// indicative, not exhaustive, and is labelled as such in the UI.

const AI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fast',
];

// Places API (New) Review object exposes no owner-response field, so we cannot
// know which reviews the business has already replied to. Do not claim to.
const REVIEW_FIELD_MASK = 'id,rating,userRatingCount,displayName,reviews';

export async function fetchReviews(placeId, apiKey) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': REVIEW_FIELD_MASK },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const d = await res.json();
  const reviews = (d.reviews || [])
    .map((r) => ({
      rating: r.rating || null,
      text: (r.originalText?.text || r.text?.text || '').trim(),
      author: r.authorAttribution?.displayName || 'A customer',
      when: r.relativePublishTimeDescription || '',
      publishTime: r.publishTime || null,
    }))
    .filter((r) => r.text);
  return {
    reviews,
    rating: d.rating || null,
    totalReviews: d.userRatingCount || 0,
    name: d.displayName?.text || '',
  };
}

// ---------------------------------------------------------------------------
// Heuristic miner — the fallback when Workers AI is unbound or errors.
// Deliberately keyword-driven and conservative: it only claims a theme when a
// review actually contains the words. No inference, no invented quotes.

const THEMES = [
  { label: 'Long wait times',        service: 'Reputation management', words: ['wait', 'waiting', 'queue', 'slow service', 'took forever', 'late', 'delay'] },
  { label: 'Pricing complaints',     service: 'Reputation management', words: ['expensive', 'overpriced', 'pricey', 'rip off', 'ripoff', 'too much money', 'costly'] },
  { label: 'Rude or unhelpful staff',service: 'Reputation management', words: ['rude', 'unfriendly', 'unprofessional', 'ignored', 'attitude', 'disrespect'] },
  { label: 'Cleanliness concerns',   service: 'Reputation management', words: ['dirty', 'unclean', 'filthy', 'hygiene', 'smell', 'messy'] },
  { label: 'Quality of work',        service: 'Reputation management', words: ['poor quality', 'bad job', 'shoddy', 'had to redo', 'not worth', 'disappointed'] },
  { label: 'Booking & appointments', service: 'GMB optimization',      words: ['appointment', 'booking', 'cancelled', 'canceled', 'reschedul', 'no show'] },
  { label: 'Hard to reach by phone', service: 'GMB optimization',      words: ['no answer', "didn't answer", 'never picks', 'unreachable', 'no one answered', 'phone'] },
  { label: 'Parking or access',      service: 'GMB optimization',      words: ['parking', 'hard to find', 'no signage', 'location was'] },
];

const PRAISE = [
  { label: 'Friendly, caring staff', words: ['friendly', 'kind', 'caring', 'welcoming', 'polite', 'patient'] },
  { label: 'Great results',          words: ['excellent', 'amazing', 'fantastic', 'best', 'highly recommend', 'professional'] },
  { label: 'Good value',             words: ['reasonable', 'affordable', 'fair price', 'good value', 'worth it'] },
];

function firstSentenceContaining(text, word) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => s.toLowerCase().includes(word));
  const q = (hit || text).trim();
  return q.length > 220 ? q.slice(0, 217).trimEnd() + '…' : q;
}

function heuristicMine(reviews, business) {
  const negative = reviews.filter((r) => (r.rating || 5) <= 3);
  const positive = reviews.filter((r) => (r.rating || 0) >= 4);

  const match = (pool, defs, sentiment) => {
    const out = [];
    for (const def of defs) {
      const hits = [];
      for (const r of pool) {
        const lower = r.text.toLowerCase();
        const word = def.words.find((w) => lower.includes(w));
        if (word) hits.push({ review: r, word });
      }
      if (!hits.length) continue;
      out.push({
        label: def.label,
        sentiment,
        count: hits.length,
        quote: firstSentenceContaining(hits[0].review.text, hits[0].word),
        quoteAuthor: hits[0].review.author,
        quoteRating: hits[0].review.rating,
        quoteVerified: true,
        service: def.service || 'Reputation management',
        // NB: we cannot say "unanswered" — the Places API exposes no owner-reply
        // field, so we do not know whether they replied. Never claim it.
        pitch: sentiment === 'complaint'
          ? `${hits.length} of the ${pool.length} negative review${pool.length === 1 ? '' : 's'} Google shows mention this — it is among the first things a prospective customer reads.`
          : '',
      });
    }
    return out.sort((a, b) => b.count - a.count);
  };

  const complaints = match(negative, THEMES, 'complaint');
  const praise = match(positive, PRAISE, 'praise');
  const name = business.name || 'This business';

  const summary = complaints.length
    ? `${complaints.length === 1 ? 'One theme' : `${complaints.length} themes`} surface in the negative reviews Google shows — led by "${complaints[0].label.toLowerCase()}". Public criticism a prospect reads before they ever call is the cheapest thing an agency can fix.`
    : negative.length
      ? 'The visible negative reviews do not cluster around any one theme.'
      : 'Every review Google shows is positive — the reputation is an asset that is currently invisible outside Google.';

  const clientSummary = complaints.length
    ? `Customers most often raise "${complaints[0].label.toLowerCase()}" in ${name}'s public reviews.`
    : negative.length
      ? `${name}'s public reviews are mixed, with no single recurring complaint.`
      : `Every review Google displays for ${name} is positive.`;

  return { themes: [...complaints, ...praise], complaints, praise, summary, clientSummary };
}

// ---------------------------------------------------------------------------
// AI miner (Cloudflare Workers AI — free daily allocation, no new account).

function parseJson(raw) {
  if (!raw) return null;
  // Some Workers AI models (llama-3.3-70b) hand back an already-parsed object.
  if (typeof raw === 'object') return raw;

  let s = String(raw).trim();
  // Models like to wrap JSON in ``` fences or prose. Take the outermost object.
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  s = s.slice(start);

  const end = s.lastIndexOf('}');
  if (end > 0) {
    try { return JSON.parse(s.slice(0, end + 1)); } catch { /* fall through to repair */ }
  }

  // Truncated at max_tokens: close the open brackets and keep whole themes.
  // Better a partial set of real themes than discarding the whole answer.
  const lastComplete = s.lastIndexOf('}');
  if (lastComplete === -1) return null;
  let candidate = s.slice(0, lastComplete + 1);
  const depth = (str, open, close) =>
    (str.match(new RegExp('\\' + open, 'g')) || []).length - (str.match(new RegExp('\\' + close, 'g')) || []).length;
  candidate += ']'.repeat(Math.max(0, depth(candidate, '[', ']')));
  candidate += '}'.repeat(Math.max(0, depth(candidate, '{', '}')));
  try { return JSON.parse(candidate); } catch { return null; }
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A quote you read aloud to a prospect MUST be real. Models paraphrase. We keep
// the theme but drop any quote that is not a verbatim substring of some review.
function verifyQuotes(themes, reviews) {
  const haystacks = reviews.map((r) => ({ norm: normalize(r.text), review: r }));
  return themes.map((t) => {
    if (!t.quote) return { ...t, quoteVerified: false };
    const q = normalize(t.quote);
    if (q.length < 12) return { ...t, quote: null, quoteVerified: false };
    const src = haystacks.find((h) => h.norm.includes(q));
    if (!src) return { ...t, quote: null, quoteVerified: false };
    return { ...t, quoteVerified: true, quoteAuthor: src.review.author, quoteRating: src.review.rating };
  });
}

const MINE_PROMPT = (business, reviews) => `You are a local-marketing analyst helping an agency prepare a sales conversation with ${business.name || 'a local business'}.

Below are the ONLY reviews Google exposes publicly (at most 5, skewed positive).

${reviews.map((r, i) => `[${i + 1}] ${r.rating}★ — "${r.text.replace(/"/g, "'")}"`).join('\n\n')}

Identify the recurring THEMES. Rules:
- A quote MUST be copied word-for-word from a review above. Never paraphrase, never invent. Copy one to three consecutive sentences exactly as written.
- Only report a theme you can actually see in the text. Fewer, real themes beat many speculative ones.
- Return 2-5 themes. Include EVERY distinct complaint you can see, and at least one "praise" theme if any review is 4★ or 5★.
- You do NOT know whether the owner replied to any review. Never say a review is "unanswered" or "ignored".
- "complaint" = something the business should fix. "praise" = a strength worth showcasing.
- "pitch" is written FOR THE AGENCY: one specific sentence, 12-25 words, naming the service to sell and why this theme makes it an easy sale. Not a label — a sentence.
- "summary" is for the agency (2 sentences, includes the commercial angle). "clientSummary" is written for the business owner to read and must contain NO sales rationale — just what customers are saying.

Reply with ONLY this JSON, no prose:
{"summary":"...","clientSummary":"...","themes":[{"label":"Short theme name","sentiment":"complaint","count":2,"quote":"exact words from a review","pitch":"..."}]}`;

async function aiMine(ai, reviews, business, diag = []) {
  const prompt = MINE_PROMPT(business, reviews);
  for (const model of AI_MODELS) {
    let raw;
    try {
      const out = await ai.run(model, {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 900,
        temperature: 0.2,
      });
      raw = out?.response ?? out?.result?.response;
    } catch (err) {
      // Never fail the request over AI — but never silently, either.
      diag.push(`${model}: ${err.message}`);
      continue;
    }
    const parsed = parseJson(raw);
    if (!parsed || !Array.isArray(parsed.themes)) {
      diag.push(`${model}: unparseable response (${String(raw).slice(0, 120)})`);
      continue;
    }

    const themes = verifyQuotes(
      parsed.themes
        .filter((t) => t && t.label)
        .slice(0, 8)
        .map((t) => ({
          label: String(t.label).slice(0, 60),
          sentiment: t.sentiment === 'praise' ? 'praise' : 'complaint',
          count: Number(t.count) || 1,
          quote: t.quote ? String(t.quote) : null,
          pitch: t.sentiment === 'praise' ? '' : String(t.pitch || '').slice(0, 200),
          service: 'Reputation management',
        })),
      reviews,
    );

    const complaints = themes.filter((t) => t.sentiment === 'complaint');
    const praise = themes.filter((t) => t.sentiment === 'praise');
    if (!themes.length) { diag.push(`${model}: returned no usable themes`); continue; }

    return {
      themes, complaints, praise, model,
      summary: String(parsed.summary || '').slice(0, 400),
      clientSummary: String(parsed.clientSummary || '').slice(0, 400),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------

export async function mineReviews({ ai, reviews, rating, totalReviews, name }) {
  const business = { name, rating, totalReviews };
  if (!reviews.length) {
    return {
      ok: true, source: 'none', sampled: 0, totalReviews, rating,
      themes: [], complaints: [], praise: [], quotes: [],
      summary: 'Google exposes no review text for this business.',
      clientSummary: 'No public review text is available.',
    };
  }

  const diag = [];
  let mined = null;
  if (ai) mined = await aiMine(ai, reviews, business, diag);
  const source = mined ? 'ai' : 'heuristic';
  if (!mined) mined = heuristicMine(reviews, business);

  return {
    ok: true,
    source,
    aiDiag: diag.length ? diag : undefined, // why the model was skipped, if it was
    model: mined.model || null,
    sampled: reviews.length,
    totalReviews,
    rating,
    themes: mined.themes,
    complaints: mined.complaints,
    praise: mined.praise,
    summary: mined.summary,
    clientSummary: mined.clientSummary,
    quotes: reviews.map((r) => ({ rating: r.rating, text: r.text, author: r.author, when: r.when })),
    minedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Review reply drafting — the deliverable an agency can sell on the spot.

const REPLY_PROMPT = (businessName, review, tone) => `Write the business owner's public reply to this Google review.

Business: ${businessName}
Review (${review.rating}★, by ${review.author}): "${review.text.replace(/"/g, "'")}"

Rules:
- Tone: ${tone}. Write as the owner ("we"), never as an agency.
- Under 70 words. No emojis. No hashtags.
- ${review.rating <= 3
    ? 'Acknowledge the specific problem they raised, apologise once without grovelling, state what changes, and invite them to make contact directly. Never argue, never blame the customer, never offer compensation.'
    : 'Thank them, reference something specific they mentioned, and warmly invite them back.'}
- Do not invent facts, names, discounts, or policies.

Reply with the message text only — no preamble, no quotation marks.`;

function heuristicReply(businessName, review) {
  // Authors are often "Sarah M." — don't emit "Sarah M.." or "Sarah M.!".
  const who = String(review.author || 'there').replace(/\.$/, '');
  if (review.rating <= 3) {
    return `Thank you for taking the time to share this, ${who}. We're sorry your experience with ${businessName} fell short — that isn't the standard we hold ourselves to. We've shared your feedback with the team and we'd genuinely like to put it right. Please get in touch with us directly so we can look into what happened.`;
  }
  return `Thank you so much, ${who}! Reviews like this mean a great deal to everyone at ${businessName}. We're delighted you had a good experience, and we look forward to welcoming you back soon.`;
}

export async function draftReply({ ai, businessName, review, tone = 'warm, professional, sincere' }) {
  if (ai) {
    for (const model of AI_MODELS) {
      try {
        const out = await ai.run(model, {
          messages: [{ role: 'user', content: REPLY_PROMPT(businessName, review, tone) }],
          max_tokens: 220,
          temperature: 0.4,
        });
        const text = String(out?.response ?? out?.result?.response ?? '').trim().replace(/^["']|["']$/g, '');
        if (text.length > 40) return { ok: true, source: 'ai', model, text };
      } catch {
        continue;
      }
    }
  }
  return { ok: true, source: 'heuristic', model: null, text: heuristicReply(businessName, review) };
}

// Canned mining result for the demo tier — never touches Google or the AI.
export function demoMining(name = 'Demo Dental Studio') {
  // NB: plain arrays, not getters — this object is JSON.stringify'd to the client.
  const themes = [
    { label: 'Long wait times', sentiment: 'complaint', count: 3, quote: 'Waited over 45 minutes past my appointment time and nobody said a word.', quoteAuthor: 'Sarah M.', quoteRating: 2, quoteVerified: true, service: 'Reputation management', pitch: 'Three of the five visible reviews name this — a prospect reads it before they ever call.' },
    { label: 'Hard to reach by phone', sentiment: 'complaint', count: 2, quote: 'Called four times to book and nobody ever picked up.', quoteAuthor: 'James O.', quoteRating: 3, quoteVerified: true, service: 'GMB optimization', pitch: 'Lost bookings, measurable. A booking link on the listing fixes it in an afternoon.' },
    { label: 'Friendly, caring staff', sentiment: 'praise', count: 2, quote: 'Dr. Patel was so patient with my son, who is terrified of dentists.', quoteAuthor: 'Amina K.', quoteRating: 5, quoteVerified: true, service: 'Reputation management', pitch: '' },
  ];
  return {
    ok: true, source: 'demo', model: null, sampled: 5, totalReviews: 118, rating: 4.1,
    themes,
    complaints: themes.filter((t) => t.sentiment === 'complaint'),
    praise: themes.filter((t) => t.sentiment === 'praise'),
    summary: 'Two clear complaint themes — wait times and an unanswered phone. The staff praise is strong enough to build a testimonial campaign on.',
    clientSummary: `Customers most often raise long wait times and difficulty reaching ${name} by phone. The team itself is praised warmly.`,
    quotes: [
      { rating: 2, text: 'Waited over 45 minutes past my appointment time and nobody said a word.', author: 'Sarah M.', when: '2 months ago' },
      { rating: 3, text: 'Called four times to book and nobody ever picked up.', author: 'James O.', when: '3 months ago' },
      { rating: 5, text: 'Dr. Patel was so patient with my son, who is terrified of dentists.', author: 'Amina K.', when: 'a month ago' },
    ],
    minedAt: new Date().toISOString(),
    demo: true,
  };
}
