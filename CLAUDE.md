# LeadLion — Engineering Notes

Local-business lead generation for marketing agencies. A self-hosted, zero-cost
alternative to LeadsGorilla. **Live at https://leadlion.pages.dev** (app at `/app`).

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
    places.js     shared Google Places helpers, geocodeCity, quadtree config
    webaudit.js   13-factor website audit (regex heuristics, no DOM)
    pagespeed.js  Google Lighthouse mobile score
    reportPage.js server-rendered public report
    accounts.js   trial/full accounts in KV + resolveAccess()
    demo.js       deterministic fake data (no API key needed)
  api/
    search.js     demo + 'fast' (top-60) + trial caps          [single request]
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
| `REPORTS` (KV namespace) | hosted reports, view counts, accounts |

Google APIs enabled on the key: **Places API (New)**, **PageSpeed Insights**.

> **TODO:** enable **Geocoding API** and add it to the key's API restrictions.
> Without it, city resolution silently uses the weaker Places fallback.

## Local development

```bash
npx wrangler pages dev public --kv REPORTS   # http://localhost:8788
```
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
- **Two voices.** Agency-facing copy (`headline`/`pitch`) carries the sales
  rationale; client-facing copy (`clientHeadline`/`clientPitch`) never does.
  The prospect must never read your sales notes.
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
  (positivity-skewed), with no way to sort by worst.
- Saved leads live in localStorage unless Supabase is configured (`schema.sql`).

## Roadmap

1. **AI layer** on free Cloudflare Workers AI + Gemini Flash free tier:
   review mining (verbatim quotes, testimonials) → then the killer feature,
   **auto-generating a demo website** for no-website leads.
2. **Landing page rebuild** to Awwwards standard — spec in `PRD-landing.md`.
3. **SaaS-ify:** Supabase Auth + Stripe. The trial/admin system is the groundwork.
4. Gaps vs LeadsGorilla worth considering: Facebook as a second source,
   built-in email sequences (SMTP), AI copywriting.
