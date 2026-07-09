# LeadLion — Engineering Notes

Local-business lead generation for marketing agencies. A self-hosted, zero-cost
alternative to LeadsGorilla. **Live at https://leadlion.pages.dev** (app at `/app`).

> **This file: what you must know to change the code without breaking it.**
> For *why* the product and pricing are shaped this way — the competitor research,
> the cost model's derivation, the open ToS risk, and the roadmap — see
> [`LEARNINGS.md`](LEARNINGS.md). Keep each fact in exactly one file.

---

## ⚠️ Hard-won gotchas — read before changing anything

These cost real debugging time. Do not rediscover them.

### 1. Cloudflare caps a Worker at **50 outbound subrequests** per invocation
Measured on the live site: it fails at request **#51** with
`Too many subrequests by single Worker invocation`.

**`wrangler pages dev` has NO such cap.** Server-side code that fans out to many
`fetch()` calls will pass every local test and break in production. This exact bug
shipped once (a deep search using ~77 Google calls in one request).

- **KV reads/writes do NOT count** as subrequests.
- Anything needing >45 outbound calls **must be split across multiple HTTP
  requests**, driven by the browser. See `/api/plan` + `/api/zones`.

### 2. The service worker caches `app.js` **cache-first**
Local code changes won't appear until you unregister the SW and clear caches:
```js
for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
```
**Bump `CACHE` in `public/sw.js`** (`leadlion-vN`) on every deploy that touches
`app.js`/`styles.css`, or returning users get stale code.

The SW deliberately ignores `/`, `/admin`, `/privacy`, `/terms`, `/api/*`, `/r/*`
— it once served the cached app shell for `/admin`, rendering a blank page.

### 3. Places API (New) needs **no delay** between pagination pages
`nextPageToken` validates immediately. A 1.5s sleep (a legacy-API habit) was
costing ~2/3 of total search time. Removed. Don't add it back.

### 4. Places text search is **not a geocoder**
It is business-first. `"Cambridge"` resolved to a clothing store in a Karachi mall;
`"São Paulo"` to the Bela Vista district. Note that the bare `political` place type
**also matches neighbourhoods** — never filter on it alone.

Resolution order (`geocodeCity` in `functions/_lib/places.js`):
1. **Geocoding API** (correct tool, disambiguates globally)
2. Fallback: Places text search filtered by `GEO_TIERS` priority
   (`locality > administrative_area > country > sublocality`)
3. Unresolvable (`"Springfield"`) → fall back to top-60 + "add a country" warning

### 5. Ad blockers hide elements with generic ids
`id="login"` was silently stripped by an ad blocker (it looked like a login-wall),
rendering the admin page blank *even in incognito*. Admin ids are now prefixed
(`ll-admin-auth`, `ll-admin-panel`). Avoid generic ids like `login`, `ad`, `banner`.

### 6. `style.display = ''` reverts to the stylesheet
If CSS says `#x { display: none }`, setting `el.style.display = ''` keeps it hidden.
Use `'block'`. (This is why the admin panel stayed blank after a successful login.)

### 7. Asking Places for `reviews` switches to the most expensive SKU
Adding `reviews` to a field mask moves the call into Google's **Enterprise +
Atmosphere** tier. **Never put it in `FIELD_MASK` in `places.js`** — that would bill
the top SKU for every row of a 1,600-lead deep search.

Review text is fetched **on demand, one lead at a time**, via Place Details in
`_lib/reviews.js`, and cached in KV under `rev:<placeId>` for 30 days. A cache hit
costs nothing (KV reads are free and are not subrequests).

### 8. Workers AI may return `response` as an **object**, not a string
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` hands back an already-parsed object;
`@cf/meta/llama-3.1-8b-instruct-fast` returns a JSON string that can be truncated
at `max_tokens`. `parseJson()` in `reviews.js` handles both (object passthrough,
fence stripping, and bracket-repair for truncated output). `String(raw)` on the
70b response silently yields `"[object Object]"`.

### 9. Google exposes **no owner-reply field** on reviews
The Places API Review object has no "business responded" property. Never write copy
claiming a review is *unanswered* or *ignored* — we cannot know, and the pitch dies
the moment a prospect says "we replied to that one." The AI prompt forbids it
explicitly; so does the heuristic copy. This was caught in review, after it had
already been written into the outreach email and the call script.

### 10. KV has no atomic increment — reserve *before* you spend
The credit ledger lives in a KV value, and two concurrent requests can read the
same counter and both write. So every endpoint **reserves the worst case before
calling Google, then refunds the difference**. Never charge after the fact: the
failure mode you want is over-counting the customer, not under-counting your bill.
Drift is bounded by `BATCHES_IN_PARALLEL`. If it ever needs to be exact, this
wants a Durable Object, not a KV key.

### 11. A batch reserves all-or-nothing, so size it to the credits left
`/api/zones` reserves `zones × 3` up front. A 15-zone batch needs 45 credits — so
a user with 20 credits got a 402 and **stranded 20 unspent credits**. `runQuadtree`
now shrinks the batch (and the parallelism) to what the balance can cover.
Measured: same 30-credit budget went from **120 leads to 278**.

### 12. The report page is a **light** document inside a **dark** app
`.report-page` is `background:#fff; color:#1a202c`. Any component styled with the
app's theme vars (`var(--text)` = `#e8edf5`) renders **white-on-white** in there.
The customer quotes shipped invisible exactly this way. Re-state colours under a
`.report-page .foo { … }` rule. Verify with `getComputedStyle`, not a screenshot.

### 13. The report's closing paragraph must match what was found
It once told a 95/100 Grade-A listing that we'd "resolve the critical issues
above" — of which there were none. `ctaCopy()` (app.js) and the `cta` const
(reportPage.js) branch on critical / opportunity / clean. Keep both in step.

### 14. A quote read aloud to a prospect **must be verbatim**
Models paraphrase. `verifyQuotes()` normalizes and checks every quote is a real
substring of a source review; a quote that fails is **dropped** (the theme survives
without it). Never relax this — an invented customer quote is unrecoverable.

---

## Architecture

Static frontend + Cloudflare Pages Functions. **No build step.** Everything in
`public/` is hand-authored and served as-is.

```
public/
  index.html      landing page (marketing)         → /
  app.html        the app shell (SPA)              → /app
  app.js          all app logic (views, store, quadtree orchestrator)
  admin.html      trial-account admin panel        → /admin
  privacy.html · terms.html
  styles.css · logo.png · sw.js · manifest.webmanifest

functions/
  _lib/
    scoring.js    10-factor GMB score + reviewInsight() star-math
    reviews.js    AI review mining (Workers AI) + reply drafting + heuristic fallback
    places.js     shared Google Places helpers, geocodeCity, quadtree config
    webaudit.js   13-factor website audit (regex heuristics, no DOM)
    pagespeed.js  Google Lighthouse mobile score
    reportPage.js server-rendered public report
    accounts.js   trial/full accounts in KV + resolveAccess()
    demo.js       deterministic fake data (no API key needed)
  api/
    search.js     demo + 'fast' (top-60) + trial caps          [single request]
    reviews.js    mine review text / draft an owner reply      [full tier, KV-cached]
    plan.js       resolve city → root zones + quadtree config  [~2 Google calls]
    zones.js      search a batch of ≤15 zones                  [≤45 subrequests]
    webaudit.js · pagespeed.js · report.js · auth.js · admin.js
  r/[id].js       public shareable report + view tracking
```

### Deep search = client-orchestrated adaptive quadtree

Google caps every query at **60 results** (3 pages × 20). A zone returning 60 is
**saturated** — there's more inside than we can see.

```
/api/plan  → geocode city, return 2×2 root zones + { maxDepth, budget, minSpan }
browser    → BFS loop:
               POST /api/zones with ≤15 zones  (45 subrequests, under the cap)
               any zone that came back saturated → split into 4 → next level
               stop at maxDepth, minSpan, or the API-call budget
```

Empty countryside costs 1 call and is never revisited. Dense downtowns get
subdivided. Progress streams to the search button; leftover dense zones are
reported as `truncatedZones` rather than silently dropped.

**Measured:** Karachi 452 → **1,604** leads (23s). Tokyo 3,700 → **6,137**.
Sukkur unchanged at 24 leads but **20 → 5** API calls.

### Access tiers (all enforced server-side)

| | Data | Searches | Results | Deep | Export | Share |
|---|---|---|---|---|---|---|
| **demo** (no code) | fake | ∞ | 20 | ✗ | ✗ | ✗ |
| **trial** (issued code) | live | 3 | 20 | ✗ | ✗ | ✗ |
| **full** (owner) | live | ∞ | ∞ | ✓ | ✓ | ✓ |

### The cost model — two meters, because two things cost money

`_lib/accounts.js`. **1 API credit = 1 Google HTTP call**, the same way Local
Falcon defines "1 credit = 1 map pin". Metering *searches* rather than *calls* is
how you sell a $47 licence and receive a $200 bill: a fast search is 3 calls, a
deep search is hundreds.

| Meter | Charges for | Skipped when |
|---|---|---|
| `apiBudget` / `apiCallsUsed` | Google Places calls on **our** key | the customer brings their own key |
| `aiCredits` / `aiCreditsUsed` | Workers AI (mining, reply drafts) | never — it's always our neurons |

Weights live in `COST`: search page 1 · zone page 1 · geocode 2 · **review mine 10**
(Place Details + `reviews` bills the Enterprise + Atmosphere SKU). Those weights
are a documented approximation — **check Billing → Reports before pricing on them.**

Endpoints gate on **affordability, not tier**. An account that can pay for a thing
may do it, whatever it's called.

### BYOK — bring your own key

The customer's Google key lives in **their browser** (`settings.googleApiKey`) and
is sent with every request that spends a call. It is **deliberately never persisted
server-side**: storing customer credentials in KV would mean one KV compromise
leaks every customer's billable Google key at once.

When a valid-looking key arrives, `resolveKey()` uses it and the API meter is not
charged — their key, their bill. That is the business model: our cost of goods
goes to zero, and the one-time licence stops being a liability we sell.

A malformed key falls back to the server key **and is metered** (verified).

### Browser-only usage counter

Separate from the server credit ledger. `recordUsage()` in `app.js` keeps a
month-rolling tally in localStorage (`leadlion_usage`) — searches, Google API calls,
review mines — and **nothing is sent to or stored on the server**. Shown in Settings
(`usageCard()`).

The **call counts are exact** — the server returns the real `apiCalls` per search;
a fast search is 3, a deep search is `q.apiCalls`, a mine is 1 (0 if cached/demo).
The **dollar figure is a labelled estimate** via `EST_USD` (placeholder rates — see
the same Billing → Reports TODO). Two different things:

- **Server ledger** (`apiCallsUsed` in KV) — enforces trial/credit *limits*. Can't
  be client-side: a limit you don't record is one DevTools edit from being bypassed.
- **Browser counter** (`leadlion_usage`) — *informational*. For a BYOK user there's
  nothing to enforce (their key, their bill), so their usage is theirs to see and
  ours never to record.

- Login gate in `app.js` (`renderGate`/`enterApp`/`boot`), session in localStorage.
- The **`ADMIN_PASSWORD` secret doubles as the owner's login code.**
- Accounts live in the `REPORTS` KV namespace under `acct:<code>` keys.
- `/api/plan` and `/api/zones` require the **full** tier (trials get 403).
- **Lead storage is namespaced per session** (`leadlion_leads__trial` etc.) so a
  trial never sees or writes the owner's pipeline. Supabase sync is owner-only.

---

## Cloudflare setup (all already done)

| Binding / secret | Purpose |
|---|---|
| `GOOGLE_PLACES_API_KEY` (secret) | Places API (New) + PageSpeed |
| `ADMIN_PASSWORD` (secret) | admin panel + owner login |
| `REPORTS` (KV namespace) | hosted reports, view counts, accounts, review cache |
| `AI` (Workers AI binding) | review mining + reply drafting |

Google APIs enabled on the key: **Places API (New)**, **PageSpeed Insights**.

> **TODO:** enable **Geocoding API** and add it to the key's API restrictions.
> Without it, city resolution silently uses the weaker Places fallback.
>
> The **`AI`** binding is added and verified live (2026-07-09) — production mining
> reads real reviews with the 70b model. If it were ever removed, mining silently
> degrades to the keyword miner (badge flips `AI-read` → `keyword`).

## Local development

```bash
npx wrangler pages dev public --kv REPORTS --ai AI   # http://localhost:8788
```
`--ai AI` proxies to **real, remote** Workers AI (it costs neurons even locally,
and needs `wrangler login`). Without the flag, `env.AI` is undefined and you exercise
the heuristic fallback path — which is worth doing deliberately now and then.
Secrets come from `.dev.vars` (gitignored):
```
ADMIN_PASSWORD=admin123
GOOGLE_PLACES_API_KEY=...
```
Remember: **local has no 50-subrequest limit.** Always reason about subrequest
counts, don't rely on local tests to catch them.

---

## Notable design decisions

- **Every score is explainable.** Each factor emits a finding + a sales pitch,
  which flows into the audit report and the outreach copy. Never add an opaque score.
- **Review intelligence is derived, not fetched.** Google's API only exposes 5
  reviews, so `reviewInsight()` bounds how many reviews *must* be below 5 stars
  from the public average + count:
  `deficit = (5 - rating) × count` → at least `ceil(deficit/4)` are sub-5-star.
  Uses conservative `rating ± 0.05` bounds (Google rounds to 1 decimal), so the
  "at least N" figure is **always safe to quote to a prospect**. Labelled
  *estimated* everywhere, and deliberately **not** a scoring factor.
- **There are TWO separate review features. Don't conflate them.**

  | | `reviewInsight()` (scoring.js) | `mineReviews()` (reviews.js) |
  |---|---|---|
  | Input | public rating + count | the ≤5 review texts Google exposes |
  | Method | arithmetic | an LLM reads the text |
  | Output | "≥12 reviews are below 5★" | "2 people mention overcharging — here's the quote" |
  | Cost | free | Enterprise SKU + a Workers AI call |
  | Truth | a provable floor, safe to quote | inference; quotes verified verbatim |
  | Tier | everyone | full plan only |

  They render side by side in the lead modal as *Review intelligence (estimated)*
  and *What customers actually say (AI-read)*.

- **The AI is never load-bearing.** If the `AI` binding is missing or every model
  errors, `mineReviews()` falls back to a keyword miner and `draftReply()` to a
  template. The feature degrades; it never 500s. `aiDiag` in the response says why.

- **Two voices.** Agency-facing copy (`headline`/`pitch`/`summary`) carries the sales
  rationale; client-facing copy (`clientHeadline`/`clientPitch`/`clientSummary`)
  never does. The prospect must never read your sales notes. `clientMining()` in
  `app.js` strips `pitch` and the agency `summary` before anything is published to a
  report — that stripping is the only thing standing between your prospect and a
  line that reads "sell them reputation management."
- **Combined opportunity** = GMB weakness + a headroom-scaled boost from website
  weakness. Website weakness can only *add* opportunity, never lower an
  already-weak lead.
- **Never auto-send outreach.** WhatsApp/email is one-click *assisted*, never bulk
  blast — bulk automation violates WhatsApp's terms and risks bans.
- **Don't scrape Google.** The whole product depends on the Places API key; a
  scraping ban would kill everything. Paid review-data providers carry that risk
  instead, if review depth ever proves worth paying for.

---

## Known limitations

- **Mega-city result sets are huge.** Tokyo deep returns 6,137 rows. Table
  rendering is OK, but "Audit all websites" over thousands of sites is slow and
  API-heavy. **Worth capping before selling at scale.**
- Tokyo deep still leaves ~251 zones truncated (hits the call budget). Exhaustive
  goes deeper at more cost.
- Google exposes **only 5 reviews per business** — and they're the "most relevant"
  (positivity-skewed), with no way to sort by worst. So review mining reads 5 of a
  400-review business. It finds *some* complaints, never all. Every surface says so.
- Saved leads live in localStorage unless Supabase is configured (`schema.sql`).

## Roadmap

See [`LEARNINGS.md` § 8](LEARNINGS.md) — it's sequenced by what the business needs,
with the reasoning for each ordering decision. Landing-page spec: `PRD-landing.md`.
