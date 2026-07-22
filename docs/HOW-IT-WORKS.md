# LeadLion — How it works (plain English)

*Your own quick reference. For deep engineering detail see [`CLAUDE.md`](../CLAUDE.md); for why the product/business is shaped this way see [`LEARNINGS.md`](../LEARNINGS.md). This file is the map, not the territory.*

---

## 1. What it does, in one line

**You type a niche + a city. LeadLion finds every local business there, scores each one by how badly they need your help, proves it with an audit, and hands you the report and the message to close them.**

---

## 2. The flow

```
Search  →  Score  →  Audit  →  Report  →  Outreach  →  Pipeline
```

| Step | What happens |
|---|---|
| **1. Search** | You enter e.g. `plumber` + `detroit`. We ask Google for businesses there. |
| **2. Score** | Every business gets an **Opportunity score 0–100**. High = they're in bad shape = easy sale. |
| **3. Audit** | Click a lead: 24 checks on their Google listing, their website, and their real mobile speed — each with a sales pitch attached. |
| **4. Report** | Generate a branded audit report (your agency name). Publish it as a link — you get pinged when they open it. |
| **5. Outreach** | Pre-written WhatsApp / email / call script, built from *their* real audit findings. |
| **6. Pipeline** | Save the lead, drag it New → Contacted → Meeting → Won. |

### The score, simply
- **Health score** = how good their online presence is (0–100).
- **Opportunity score** = `100 − health`. **This is the sales number** — high opportunity = they need you.
- Made of **9 checks** worth 100 points total:

| Check | Points |
|---|---|
| Has a website | 20 |
| Star rating | 15 |
| Review volume | 15 |
| Photos | 15 |
| Listing looks claimed/managed | 10 |
| Opening hours listed | 10 |
| Phone number | 5 |
| Primary category set | 5 |
| Marked operational | 5 |

*Plus 14 website checks and 1 mobile-speed check shown in the audit (not part of the 100).*

### Search depths (they cost different amounts)

| Tier | Gets you | Speed |
|---|---|---|
| 🟢 **Quick scout** | ~20 top leads | ~2s — cheapest |
| 🔵 **Standard** | 60 best in the area | ~4s |
| 🟠 **Deep dive** | Whole-city grid, hundreds | ~10s |
| 🔴 **Full sweep** | Everything findable | ~15s, most API calls |

> Google caps any single query at 60 results. Deep/Full get past that by slicing the city into zones and searching each — that's why they cost more.

---

## 3. What powers it — and who pays

| Piece | What it's for | Who pays |
|---|---|---|
| **Google Places API (New)** | Finding the businesses | **You** (your key) |
| **Google Geocoding API** | Turning "detroit" into a real map area | **You** |
| **Google PageSpeed Insights** | The mobile speed audit | **You** |
| **Cloudflare Pages + Functions** | Hosting + the server bits | Free |
| **Cloudflare Workers AI** (Llama 3.3 70B) | Reading reviews, drafting replies | Free |
| **Cloudflare KV** | Hosted reports, view counts, 30-day review cache | Free |

**The money rule:** *Sell the software once. Never sell the API calls.*
You bring your own Google key (**BYOK**) → Google bills you directly → usually **$0** (one-time $300/90-day credit, then a free monthly allowance that renews). We take **no markup**. See [`BYOK.md`](BYOK.md).

---

## 4. Where everything lives

| Thing | Where | Risk |
|---|---|---|
| **Your Google API key** | Your browser only. Never on our servers. | Clearing browser data removes it |
| **Your saved leads** | Browser (`localStorage`) **or** your own Supabase | ⚠️ Browser-only = one cache clear from losing them |
| **Published reports** | Our Cloudflare KV | Fine |
| **Review mining cache** | KV, 30 days | Keeps AI + API costs down |
| **Agency branding** | Your browser | Snapshotted into a report at publish time |

---

## 5. Who can do what

| | Data | Searches | Results | Deep | Export | Share |
|---|---|---|---|---|---|---|
| **demo** (no code) | fake | ∞ | 20 | ✗ | ✗ | ✗ |
| **trial** (issued code) | live | 3 | 20 | ✗ | ✗ | ✗ |
| **full** (you) | live | ∞ | ∞ | ✓ | ✓ | ✓ |

All enforced **server-side** — the browser can't lie its way past it.

---

## 6. Checklists

### ✅ Your setup (do once)
- [ ] **Google API key** — Settings → *Set up my key — guided*. Enable **3 APIs**, leave **Application restrictions = None**, then hit **Test key**.
- [ ] **Supabase** — Settings → *Connect a database — guided*. Otherwise your leads die with your browser cache.
- [ ] **Agency branding** — Settings. This is what appears on every report you send.
- [ ] **Export CSV** occasionally as a free backup.

### ✅ Every deploy
- [ ] **Bump `CACHE` in `public/sw.js`** (`leadlion-vN` → `vN+1`) if you touched `app.js` or `styles.css`. **Skip this and returning users get stale code.**
- [ ] `git push origin main` → Cloudflare auto-deploys.
- [ ] Verify the live version actually flipped (curl `/sw.js`, check the version).

### 🔴 Before charging anyone money
- [ ] **Get the real SKU costs** (Google Billing → Reports, grouped by SKU). Every dollar figure in the app currently sits on *guessed* weights in `_lib/accounts.js`.
- [ ] **Read the Google Maps Platform Terms of Service.** The app has CSV export + stores leads indefinitely; the terms restrict caching Places data past 30 days and bulk export. **A violation kills the API key and stops every customer at once.**

### ⛔ Never do these (they've each bitten before)
- [ ] **Never add `reviews` to `FIELD_MASK`** in `places.js` — it silently jumps to Google's most expensive billing tier for *every* row.
- [ ] **Never let one server request make >50 outbound calls** — Cloudflare hard-caps it. Local dev has no such cap, so it passes every test and breaks in production.
- [ ] **Never claim something the API can't prove.** No "they ignored this review" (Google exposes no reply field). No "you have no business description" (not exposed either). Every sentence gets read aloud to someone who knows the truth.
- [ ] **Never invent a customer quote.** Quotes are verified as real substrings of real reviews; a failed quote is dropped, not paraphrased.
- [ ] **Never add `allow-same-origin`** to the demo-site iframe — that HTML is untrusted and would gain access to your keys.

### 🩺 If something looks wrong
| Symptom | Likely cause |
|---|---|
| Changes don't show up | Service worker cache — bump `sw.js`, hard-refresh |
| "Sync error" badge (red) | Supabase broken → leads saving to browser only |
| Searches failing | Test your Google key in Settings |
| Leads vanished after connecting Supabase | They're still in localStorage — run the migration prompt |
| A finding looks false | Check it's not asserting something the API can't see |

---

## 7. The one-paragraph pitch

> Most tools sell you a list and a subscription. LeadLion takes you from a city name to a signed client — scored leads, a branded audit that proves the problem, and the message to send. And it runs on **your** Google key and **your** database, so we take no cut of the data, nothing of yours sits on our servers, and your searches are never rationed to protect our bill.
