// AI copy generation for the sales workflow — cold outreach emails and Google
// Business Profile descriptions. Runs on Cloudflare Workers AI (same free
// allocation as review mining). Like every AI feature here it is NEVER load-
// bearing: if the binding is missing or every model errors, a deterministic
// template is returned instead. No Google call is involved — these work purely
// from the audit findings the client already computed.

const AI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fast',
];

async function runModel(ai, prompt, { maxTokens = 400, temperature = 0.5 } = {}, diag = []) {
  for (const model of AI_MODELS) {
    try {
      const out = await ai.run(model, {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      });
      const text = String(out?.response ?? out?.result?.response ?? '').trim();
      if (text.length > 30) return { text, model };
    } catch (err) {
      diag.push(`${model}: ${err.message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------- cold email

// Outreach angle = the overall narrative, chosen from OBSERVABLE signals (website
// presence), never from the unreliable claimed-status guess. 'get-online' = no
// website (invisibility hook + preview CTA); 'grow' = established, actively-run
// listing (acknowledge what they built, then the gaps costing them customers).
const ANGLE_BRIEF = {
  'get-online': `ANGLE — "Get online": this business has NO website. Open on what that costs them: someone who finds them on Google has nowhere to go to check them out, read more, or book — so they drift to a competitor who does have a site. Mention you've put together a free preview of what a site could look like for them. Encouraging, never scolding.`,
  'grow': `ANGLE — "Grow & optimise": this is an established, actively-run listing (they already have a website). Do NOT say they're invisible or imply they've done nothing. Open by genuinely acknowledging the presence they've built, then pivot to the specific gaps quietly costing them customers (from the issues below) and the growth on the table. You're a growth partner, not a rescue.`,
};
function resolveAngle(angle, hasWebsite) {
  return ANGLE_BRIEF[angle] ? angle : (hasWebsite ? 'grow' : 'get-online');
}

function coldEmailPrompt({ name, category, location, hasWebsite, topIssues, service, agency, angle }) {
  const issues = (topIssues || []).map((i) => `- ${i.text}`).join('\n') || '- their online presence has clear gaps';
  const a = resolveAngle(angle, hasWebsite);
  return `You are helping a local-marketing agency write a SHORT cold outreach email to a business owner.

Business: ${name || 'a local business'} — a ${category || 'local business'} in ${location || 'their area'}.${hasWebsite ? '' : '\nThey have NO website at all.'}
${ANGLE_BRIEF[a]}
Observable issues found in a quick audit (use ONLY these — do not invent others):
${issues}
The one service to pitch first: ${service || 'local marketing help'}.
Agency name: ${agency?.name || 'our agency'}.

Write the email. Rules:
- First line must be "Subject: <subject>", then a blank line, then the body.
- 110-160 words total. Warm, direct, human. No hype, no emojis, no markdown.
- Ground every claim in the issues above. Do NOT invent statistics, awards, or claim a review is "unanswered" — that is unknowable.
- Lead with the single most valuable fix (${service || 'the top issue'}). Exactly one low-pressure call to action: a free audit report plus a 10-minute call.
- Sign off as ${agency?.name || 'our agency'}${agency?.phone ? ', ' + agency.phone : ''}.
- Output ONLY the email (subject line + body). No preamble, no quotation marks around it.`;
}

function coldEmailTemplate({ name, category, location, hasWebsite, topIssues, service, agency, angle }) {
  const bullets = (topIssues || []).slice(0, 3).map((i) => `  • ${i.text}`).join('\n') || '  • a few quick wins on your online presence';
  const ag = agency?.name || 'Your Agency';
  const a = resolveAngle(angle, hasWebsite);
  const opener = a === 'get-online'
    ? `I came across ${name || 'your business'}${location ? ` while looking up ${category || 'local businesses'} in ${location}` : ''} on Google, but couldn't find a website for you. Anyone who finds you and wants to check you out or book has nowhere to go — so they end up at a competitor who has a site.`
    : `I came across ${name || 'your business'}${location ? ` while looking up ${category || 'local businesses'} in ${location}` : ''}. You've clearly built a real presence — and I ran a quick audit that turned up a few gaps that are quietly costing you customers:`;
  const closer = a === 'get-online'
    ? `The good news: I've put together a free preview of what a proper site could look like for you. ${service ? `The fastest win is ${service}.` : ''} No cost, no obligation.`
    : `The highest-impact fix is ${service || 'tightening up your local presence'} — most of this is fixable within a couple of weeks. I put together a free audit report showing exactly where you stand against nearby competitors.`;
  return `Subject: Quick question about ${name || 'your'} Google listing

Hi there,

${opener}

${bullets}

${closer}

Open to a 10-minute call this week? I'll send the full report either way.

Best,
${ag}${agency?.phone ? '\n' + agency.phone : ''}`;
}

export async function writeColdEmail({ ai, lead = {}, service, agency, angle }, diag = []) {
  const input = {
    name: lead.name, category: lead.category, location: lead.location,
    hasWebsite: !!lead.hasWebsite, topIssues: lead.topIssues, service, agency, angle,
  };
  if (ai) {
    const r = await runModel(ai, coldEmailPrompt(input), { maxTokens: 380, temperature: 0.55 }, diag);
    if (r) return { ok: true, source: 'ai', model: r.model, text: r.text };
  }
  return { ok: true, source: 'heuristic', model: null, text: coldEmailTemplate(input) };
}

// ------------------------------------------------------------ GBP description

function gbpPrompt({ name, category, location, service }) {
  return `Write a Google Business Profile "About" / business description for this business, in the business's OWN voice (first person plural, "we").

Business: ${name || 'a local business'} — a ${category || 'local business'} in ${location || 'the local area'}.${service ? `\nEmphasise their strength in: ${service}.` : ''}

Rules:
- 550-720 characters. Natural, welcoming, first person plural.
- Say what they do and the city/area they serve, using natural keywords a customer would actually search.
- End with one inviting call to action (visit, book, get in touch) but NO phone number and NO website URL.
- Do NOT invent awards, years in business, staff names, or any specific claim you cannot verify.
- Output ONLY the description text — no preamble, no quotation marks, no markdown.`;
}

function gbpTemplate({ name, category, location, service }) {
  const n = name || 'our business';
  const cat = (category || 'local services').toLowerCase();
  const loc = location || 'the local area';
  return `At ${n}, we provide ${cat} to customers across ${loc}. Our team is focused on doing the job right and making every visit easy and worthwhile${service ? `, with particular care put into ${String(service).toLowerCase()}` : ''}. We know how much trust it takes to choose a local provider, so we work hard to earn it — with honest advice, dependable service, and a friendly welcome every time. Whether it's your first visit or your tenth, you'll find the same standard of care. Get in touch today to see how we can help.`;
}

export async function writeGbpDescription({ ai, lead = {}, service }, diag = []) {
  const input = { name: lead.name, category: lead.category, location: lead.location, service };
  if (ai) {
    const r = await runModel(ai, gbpPrompt(input), { maxTokens: 320, temperature: 0.6 }, diag);
    if (r) return { ok: true, source: 'ai', model: r.model, text: r.text.replace(/^["']|["']$/g, '') };
  }
  return { ok: true, source: 'heuristic', model: null, text: gbpTemplate(input) };
}
