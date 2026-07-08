# LeadLion — Learnings

**Why the product and the business are shaped the way they are.**

Two files, each fact in exactly one of them — so neither can drift:

| File | Answers | When to read it |
|---|---|---|
| **`CLAUDE.md`** | *What must I know to change the code without breaking it?* | Before touching the code. Loaded into Claude's context **every session**, so it stays tight. |
| **`LEARNINGS.md`** (this) | *Why is it built this way, and what does it cost?* | Before a product, pricing, or "should we ship this" decision. |

Anything a coder needs mid-edit belongs in `CLAUDE.md`. Anything you'd want before
deciding what to build or what to charge belongs here. **§3 and §4 are indexes into
`CLAUDE.md`, not copies of it.**

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

## 3. Technical facts — index

**These live in `CLAUDE.md`, which is the single source of truth.** Duplicating them
here would guarantee the two files drift and neither could be trusted. This is a
map, not a copy.

| # | Fact | Why it mattered |
|---|---|---|
| 1 | Cloudflare caps a Worker at **50 outbound subrequests** | Passed every local test; broke in production. `wrangler pages dev` has no such cap. Forced the whole client-orchestrated quadtree. |
| 2 | The service worker caches `app.js` **cache-first** | Wasted time twice in one session. Bump `CACHE` on every deploy. |
| 3 | Places API (New) needs **no delay** between pages | A legacy-API habit was costing ~2/3 of search time. |
| 4 | Places text search is **not a geocoder** | `"Cambridge"` → a clothing store in a Karachi mall. |
| 5 | Ad blockers hide elements with generic ids | `id="login"` rendered the admin page blank, even in incognito. |
| 6 | `style.display = ''` reverts to the stylesheet | Admin panel stayed blank after a successful login. |
| 7 | Asking Places for `reviews` switches to the **priciest SKU** | Would have billed Enterprise + Atmosphere on every row of a 1,604-lead search. |
| 8 | Workers AI returns `response` as an **object** on some models | `String(raw)` silently yields `"[object Object]"`. |
| 9 | Google exposes **no owner-reply field** | We cannot know if a review was answered. Never claim it. |
| 10 | **KV has no atomic increment** — reserve before you spend | Over-count the customer, never under-count your bill. |
| 11 | A batch reserves **all-or-nothing** — size it to the credits left | Stranded 20 credits. Fixing it took 120 leads → **278** on the same budget. |
| 12 | The report page is a **light** document inside a **dark** app | The customer quotes shipped invisible, white-on-white. |
| 13 | The closing CTA must match what was found | Told a Grade-A listing we'd fix "the critical issues above". There were none. |
| 14 | A quote read aloud to a prospect **must be verbatim** | Models paraphrase. An invented customer quote is unrecoverable. |

Two more, not in `CLAUDE.md` because they're about the toolchain, not the code:

- **Google exposes only 5 reviews per business**, and they're the "most relevant" —
  positivity-skewed, with no sort-by-worst. Mining a 400-review business reads 5 of
  them. It finds *some* complaints, never all. Say so on every surface.
- **`wrangler pages dev` state corrupts across concurrent servers.**
  `_cf_ALARM has 3 columns but 2 values` → the runtime refuses to start. Use
  `--persist-to <isolated dir>` when running a second server against the same repo.

---

## 4. Design principles — index

**Also in `CLAUDE.md`** (§ *Notable design decisions*). The three that were hardest
won, and the reasoning behind them:

- **There are two review features. Don't conflate them.** `reviewInsight()` is
  arithmetic on the public rating and count — a *provable floor*, safe to quote.
  `mineReviews()` is a model reading the review text — *inference*, and every quote
  is verified verbatim before it can be shown. We confused these two ourselves at
  the start of the session; the UI now labels them **estimated** and **AI-read**.

- **Two voices.** Agency copy carries the sales rationale; client copy never does.
  `clientMining()` strips the agency fields before anything is published. The
  prospect must never read your sales notes.

- **Gate on affordability, not tier.** An account that can pay for a thing may do it,
  whatever it's called. Tier checks calcify as the product grows; budgets don't.

Plus: the AI is never load-bearing (it degrades, never 500s) · cache what's expensive
*before* you charge for it · never cache per-account data in a shared entry · failure
must not discard what the customer already paid for · never auto-send outreach ·
don't scrape Google.

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
7. **Landing page rebuild** to Awwwards standard — spec in `PRD-landing.md`.
8. **SaaS-ify:** Supabase Auth + Stripe. The trial/credit system is the groundwork.

**Deliberately deferred.** Gaps vs LeadsGorilla that look tempting and aren't yet:
Facebook as a second lead source, built-in email sequences (SMTP), AI copywriting.
None of them change the economics, and the economics are the constraint.

✅ **Shipped 2026-07-09:** AI review mining + reply drafting (`_lib/reviews.js`) —
proved the $0 Workers AI approach. Cost metering + BYOK (`_lib/accounts.js`) — made
a business model possible. The order mattered: mining is the differentiator, BYOK is
what makes it sellable.
