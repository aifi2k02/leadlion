# LeadLion — Learnings

Everything that cost time, money, or credibility to find out. `CLAUDE.md` is the
engineering reference; this is the record of *how we know* what's in it.

Last updated: 2026-07-09.

---

## 1. The business model

### The arithmetic that decides everything

Every search costs money at Google. A one-time payment doesn't recur.
**You cannot fund an unbounded, recurring cost with bounded, one-off revenue.**

Worked example. 1,000 users × $47 = **$47,000, once**. If each runs one deep
search a week at ~$4 of Google calls:

```
1,000 × 1 × $4 = $4,000/week = $208,000/year
```

The $47,000 is gone by **week 12**. Then you pay, forever, for customers who paid
you two years ago. One-time pricing on a metered product is a liability you sell.

> The ~$4/deep-search figure is derived from our own spend (~$107 across a few
> dozen mostly-deep searches), not from Google's price sheet. **Get the real number
> from Billing → Reports, grouped by SKU.** Everything downstream rests on it.

### What competitors actually do (researched 2026-07-09)

| | Job to be done | Usage | Pricing |
|---|---|---|---|
| **LeadsGorilla** | *find* prospects | bursty | "$47 one-time" — **renews annually** ($197/yr), OTO upsells, **BYOK** |
| **LeadLion** | *find* prospects | bursty | one-time + BYOK |
| **BrightLocal** | *manage* existing clients | continuous | $31–49 **per location** / mo |
| **Local Falcon** | *monitor* existing clients | continuous | $24.99–199.99/mo, credit-metered |

Three conclusions:

1. **Nobody eats uncapped Places API cost for a flat fee.** LeadsGorilla pushes it
   onto the user via BYOK; their users report **$50–200/mo of their own Google
   spend**. The competitor you thought you had — "$47 once and it just works" —
   does not exist.
2. **Usage pattern determines pricing model.** Prospecting is bursty (nobody
   searches for new leads every day forever), so one-time works. Monitoring is
   continuous, so it can't. BrightLocal and Local Falcon are *not* our
   competitors — they serve clients you've already won.
3. **Local Falcon defines a credit as a unit of cost**: *"a credit is one data
   point, a 'map pin'… a 5x5 grid scan uses 25 credits."* Unused credits expire
   monthly. That's the model we copied.

### The decision

> **Sell the software once. Never sell the API calls once.**
> Charge monthly only for things that cost you monthly.

1. **One-time licence + BYOK** — the headline offer. $0 cost of goods.
2. **AI credits** — consumable top-ups. Recurring revenue *without* subscription
   psychology, and they meter the one thing BYOK doesn't cover (Workers AI).
3. **Subscription = the monitoring layer** (scheduled scans, rank/review change
   alerts, trend data). Local Falcon proves demand exists at a $24.99 floor.
   **Do not build or price this until a customer asks for it.**

### Positioning

Be honest about what they obscure:

> "$47, once, genuinely. You bring your own Google key — here's exactly what it'll
> cost, and here's a 6-minute setup video. No upsells at checkout."

**Substantiated differentiator:** the adaptive quadtree makes *the customer's own
Google bill smaller*. Sukkur: 20 → 5 API calls for the same 24 leads. Competitors
brute-force a fixed grid. Nobody else can make that claim.

**Unrecognised pricing power:** we give away, in a ~$47 tool, what these charge
top-tier for — white-label reports (Local Falcon: **$199.99/mo tier**) and AI
review responses (locked out of their $24.99 tier). **The report + review layer is
worth more than the search layer.** We had it backwards.

### The BYOK onboarding wizard is the product, not a chore

LeadsGorilla buyers complain specifically about the Google Cloud setup. We walked
it twice and found exactly where it's confusing:

- Google no longer labels it "API restrictions" — it's under *"APIs that can be
  accessed using this key"*.
- The dropdown's **OK button is not Save.** Save is at the very bottom of a long
  page, below the Application-restrictions radios.
- Enabling an API on the project ≠ adding it to the key's allowlist. **Two steps.**
- **Application restrictions must stay `None`** for a server-side key. "Websites"
  breaks every request (no browser referrer); Cloudflare has no fixed egress IP.

Turn the competitor's worst review into our landing page.

---

## 2. Money and quota

| Fact | Detail |
|---|---|
| Google Cloud status (2026-07-09) | Free trial, **$193.20 of $300 left, 89 days**. ~$107 already spent, mostly deep searches. |
| Are we being charged? | **No.** Free trial doesn't auto-bill — services *stop* when credit or 90 days run out. Clicking **Upgrade** starts real charges. |
| The expensive SKU | Places Details **with the `reviews` field** = *Enterprise + Atmosphere*, Google's priciest tier. |
| Cheap | Geocoding. Called **once per search** in `/api/plan`, not per zone. |
| Free-ish | Workers AI — a daily neuron allocation, **per our Cloudflare account**, shared across all users. Degrades to the keyword miner rather than erroring. |

**The single most expensive button in the app** is Exhaustive on a mega-city.
Tokyo exhaustive is ~1,200 Google calls.

**Cost weights in `_lib/accounts.js` (`COST`) are approximations.** `reviewMine: 10`
is a guess at the Enterprise-SKU ratio. Verify before pricing on it.

---

## 3. Hard-won technical facts

Full detail in `CLAUDE.md`. The ones that were genuinely surprising:

### Cloudflare caps a Worker at 50 outbound subrequests
Fails at request #51. **`wrangler pages dev` has no such cap** — server-side fan-out
passes every local test and breaks in production. This shipped once. KV reads don't
count. Anything needing >45 calls must be split across HTTP requests and driven by
the browser (`/api/plan` + `/api/zones`).

### KV has no atomic increment
Two concurrent requests can read the same counter and both write. So every endpoint
**reserves the worst case before calling Google, then refunds the difference.**
Never charge after the fact: the failure mode you want is over-counting the
customer, not under-counting your bill. Exact accounting needs a Durable Object.

### All-or-nothing reservations strand credits
`/api/zones` reserves `zones × 3` up front. A 15-zone batch needs 45 credits — so a
user holding 20 credits was refused and **stranded all 20**. Sizing the batch and
the parallelism to the balance took the same 30-credit budget from **120 leads to
278**. Any reservation scheme needs this.

### Places text search is not a geocoder
It's business-first. `"Cambridge"` resolved to a *clothing store in a Karachi mall*.
`"São Paulo"` to the Bela Vista district — the bare `political` type also matches
neighbourhoods. Use the Geocoding API first, with a type-priority Places fallback.

### Places API (New) needs no delay between pagination pages
`nextPageToken` validates immediately. A 1.5s sleep (a legacy-API habit) was costing
~2/3 of total search time.

### Google exposes no owner-reply field on reviews
There is no "business responded" property. **Never write copy claiming a review is
"unanswered."** We cannot know, and the pitch dies the moment a prospect says "we
replied to that one." This had already been written into the outreach email *and*
the call script before it was caught.

### Google exposes only 5 reviews per business
And they're the "most relevant" — positivity-skewed, no sort-by-worst. Mining a
400-review business reads 5 of them. It finds *some* complaints, never all. Say so
on every surface.

### Workers AI returns `response` as an object on some models
`llama-3.3-70b` hands back an already-parsed object; `String(raw)` yields
`"[object Object]"`. `llama-3.1-8b` returns a JSON string that can be truncated at
`max_tokens`. Handle object passthrough, fence stripping, and bracket repair.

### A quote read aloud to a prospect must be verbatim
Models paraphrase. `verifyQuotes()` drops any quote that isn't a real substring of a
source review — theme survives, quote doesn't. **Never relax this.** An invented
customer quote is unrecoverable.

### The report page is a light document inside a dark app
Anything styled with the app's theme vars (`var(--text)` = `#e8edf5`) renders
**white-on-white** inside `.report-page`. The customer quotes shipped invisible
exactly this way. Verify colour with `getComputedStyle`, never a screenshot.

### The service worker caches `app.js` cache-first
Local changes don't appear until you unregister the SW and clear caches. Bump
`CACHE` in `sw.js` on every deploy touching `app.js`/`styles.css`. This wasted time
twice in one session.

### Ad blockers strip elements with generic ids
`id="login"` was silently hidden — the admin page rendered blank *even in incognito*.
Avoid `login`, `ad`, `banner`.

### `style.display = ''` reverts to the stylesheet
If CSS says `display:none`, setting `''` keeps it hidden. Use `'block'`.

### `wrangler pages dev` state can corrupt across concurrent servers
`_cf_ALARM has 3 columns but 2 values` → the runtime refuses to start. Use
`--persist-to <isolated dir>` when running a second server.

---

## 4. Product design principles that earned their keep

- **Every score is explainable.** Each factor emits a finding *and* a sales pitch.
  Never add an opaque score.

- **There are two review features. Don't conflate them.**

  | | `reviewInsight()` | `mineReviews()` |
  |---|---|---|
  | Input | public rating + count | the ≤5 review texts Google exposes |
  | Method | arithmetic | an LLM reads the text |
  | Output | "≥12 reviews are below 5★" | "2 people mention overcharging — here's the quote" |
  | Truth | a **provable floor**, safe to quote | inference; quotes verified verbatim |
  | Cost | free | Enterprise SKU + an AI call |

  Derived, not fetched: `deficit = (5 − rating) × count` → at least `ceil(deficit/4)`
  reviews are sub-5-star. Conservative `rating ± 0.05` bounds, so the "at least N"
  figure is **always safe to say to a prospect**.

- **Two voices.** Agency copy (`pitch`, `summary`) carries the sales rationale;
  client copy (`clientPitch`, `clientSummary`) never does. `clientMining()` strips
  the agency fields before anything is published. *The prospect must never read
  your sales notes.*

- **The AI is never load-bearing.** No binding, or every model erroring, degrades to
  a keyword miner and a template reply. The feature gets dumber; it never 500s.

- **Gate on affordability, not tier.** An account that can pay for a thing may do
  it, whatever it's called. Tier checks calcify; budgets don't.

- **Cache what's expensive, before you charge for it.** Review mining checks KV
  *before* reserving any budget. A cache hit costs nothing (34ms, measured).

- **Never cache per-account data in a shared entry.** Nearly shipped: the mined-review
  KV entry carried the miner's credit balance, so the next user would have seen it.

- **The closing paragraph must match what was found.** We told a 95/100 Grade-A
  listing we'd "resolve the critical issues above" — of which there were none.

- **Failure must not discard what the customer already paid for.** Running out of
  credits mid-quadtree keeps the leads already fetched.

- **Never auto-send outreach.** One-click *assisted*, never bulk blast. Bulk
  WhatsApp automation violates their terms and risks bans.

- **Don't scrape Google.** The whole product depends on the Places key.

---

## 5. Things I got wrong (Claude), and the lesson

Three times in one session I stated a specific with confidence and was wrong. In
each case the **structural reasoning survived** and the **specific claim didn't.**

| Claim | Reality | How it was caught |
|---|---|---|
| "Add `places.reviews` to the search FIELD_MASK" | Would have billed the Enterprise SKU on **every row of a 1,604-lead deep search**. | Caught before writing code. |
| "Trials can run an exhaustive Tokyo search — most urgent thing here" | `newTrial()` hardcodes `deep:false`; `/api/plan` and `/api/zones` 403 without it. A trial was 3 fast searches ≈ **9 calls**. Said twice before checking. | `grep`, 30 seconds. |
| "LeadsGorilla uses a credit system" | They use **BYOK**, and their "$47 one-time" **renews annually**. | Web search, after the user pushed back. |
| "$19/mo is the real business" | Invented. No cost data, no comps, no willingness-to-pay. (Local Falcon's floor is $24.99, credit-metered.) | User asked "is that the best model?" |

**Lesson: verify specifics.** When a number or a competitor fact is handed to you,
check it before you build on it. The reasoning is worth more than the recall.

Corollary, the one that nearly shipped: the *"still sitting there unanswered"* line
was already in the outreach email and the call script. It sounded persuasive. It was
unknowable. **Persuasive and unverifiable is the most dangerous combination in this
product** — every sentence is read aloud to a stranger who knows the truth.

---

## 6. Open risks

**Google Maps Platform Terms — unread.** The app has a **CSV export button** and
stores lead lists **indefinitely**. The terms restrict caching Places content beyond
30 days and restrict bulk export/redistribution. *This has not been read by anyone.*
A ToS violation doesn't get a warning — it kills the key, and every customer's app
stops at once. **Read them before selling.** BYOK partly moves that risk onto the
customer's own Google account.

*(The 30-day KV cache on review mining happens to sit inside that window. That was
for cost, not compliance — but it's the right side of the line.)*

**Workers AI is per-our-account.** 1,000 users mining reviews share one daily
allocation. Fine at launch. BYOK the Gemini key when it bites.

**The ledger is eventually consistent.** Drift bounded by `BATCHES_IN_PARALLEL`,
errs toward over-charging the customer. Fine at this scale; not at 1,000 paying users.

**Mega-city result sets.** Tokyo deep returns 6,137 rows. "Audit all websites" over
thousands of sites is slow and API-heavy. Cap it before selling at scale.

---

## 7. Product observations, unfixed

**Practitioner stub listings inflate the pipeline.** Searching `dentist` in
`Cambridge` returned five separate "leads" at one address — `Dental Surgery, 16
Emmanuel Rd` — individual dentists listed under the same practice. Each scores 85–90
opportunity (no website, no rating, no reviews), which is exactly what a stub listing
looks like. You'd email one practice five times, your "Hot leads" count is inflated,
and a real practice with a good website ranks *below* its own staff's stubs.
Common for dental, medical, legal. Fix: group by address; collapse stubs into the
parent, or badge "same address as N other leads".

**`Prepared <date>` lies.** The in-app report renders `new Date()` at *view* time, so
an old lead looks freshly prepared. Leads saved before `reviewInsight()` shipped show
no Review Intelligence section — re-save to populate.

---

## 8. Roadmap, in the order that makes sense

1. **BYOK onboarding wizard.** The differentiator, and the competitor's worst review.
2. **Real SKU costs** from Billing → Reports; replace the guessed `COST` weights.
3. **Read the Maps Platform Terms.** Before selling, not after.
4. **Address-grouping** for practitioner stubs.
5. **Demo-website generator** for no-website leads — *"I already built you a preview,
   want it live?"* The killer feature. Gemini Flash suits it better than Workers AI.
6. **Monitoring layer** — scheduled scans, rank/review change alerts, trend data.
   *Only when a customer asks.* This is the subscription, and the bridge is elegant:
   we already store every lead's rating, review count and rank, so re-scanning on a
   schedule yields the exact asset Local Falcon sells — for the **prospects** an
   agency is chasing, not just the clients they've won. Nobody makes that product.
7. **SaaS-ify:** Supabase Auth + Stripe. The trial/credit system is the groundwork.
