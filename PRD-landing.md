# LeadLion — Product Requirements Document
### Awwwards-Grade Marketing Landing Page

**Version:** 1.0
**Owner:** Owais (Nexosol)
**Status:** Draft for design/build
**Last updated:** 2026-07-08

---

## 0. TL;DR

LeadLion is a live, working local-business lead-generation platform (a modern, self-hosted LeadsGorilla alternative). The product is done and shipping. **This PRD is specifically about rebuilding the public marketing landing page (`/`) into an Awwwards-worthy experience** — a page that makes agencies and freelancers feel "this is the most premium tool in the category" within 3 seconds, and converts them into the app (`/app`) or a trial.

The bar: **Awwwards Site of the Day quality** — considered art direction, a signature interactive moment, buttery motion, flawless responsive behavior, and sub-second load — while staying inside our zero-cost, self-contained Cloudflare Pages constraints.

---

## 1. Product Context

### 1.1 What LeadLion is
A tool for marketing agencies, freelancers, and consultants to **find local businesses that need help, prove it, and close them.**

**Core capabilities (all live):**
- **Deep city search** — tile any city into a grid, pull 150+ Google Business listings past the 60-result cap, each scored 0–100 by *sales opportunity*.
- **Explainable audits** — 10-factor GMB score + 13-factor website audit + real Google Lighthouse mobile-speed test. Every gap ships with a sales pitch.
- **Competitor benchmarking** — "You're #56 of 151; competitors average 480 reviews, you have 48."
- **Branded, trackable reports** — publish a shareable audit link under your brand; get notified when the prospect opens it.
- **1-click WhatsApp outreach** — messages pre-written from the business's real audit findings.
- **Built-in CRM** — pipeline, map view, dashboard, bulk actions, CSV export.
- **Access tiers** — demo / trial / full, with an admin panel to issue trial codes (SaaS groundwork).

### 1.2 Positioning
> "The modern local lead-gen platform — find, prove, and close local clients in one place."

**vs LeadsGorilla:** cheaper ($0 self-hosted vs $47–99), deeper (150+ leads, real speed audits, competitor benchmarks, open-tracked reports, WhatsApp), and yours (your data, your infra).

### 1.3 Target audience (personas)
| Persona | Who | What makes them click |
|---|---|---|
| **Solo agency owner** | 1–3 person digital agency, does GMB/web/SEO | "Find me clients who obviously need this, today." |
| **Freelance closer** | Cold-outreach freelancer | "Give me leads + the exact message to send." |
| **SMM/SEO consultant** | Sells retainers | "Show the prospect hard proof they're losing customers." |

Primary market skews **Pakistan / MENA / South Asia / LATAM** (WhatsApp-first), plus global agencies.

---

## 2. Goals & Success Metrics

### 2.1 Primary goal
Turn the landing page into a **conversion-optimized, award-caliber showpiece** that (a) sells the product in one scroll and (b) is portfolio-worthy enough to submit to Awwwards / CSS Design Awards / Godly.

### 2.2 Success metrics
| Metric | Target |
|---|---|
| Hero-to-"Launch App" click-through | ≥ 12% |
| Scroll depth past "How it works" | ≥ 55% |
| Lighthouse Performance (mobile) | ≥ 90 |
| Lighthouse Accessibility | ≥ 95 |
| Largest Contentful Paint (mobile, 4G) | < 2.0s |
| Cumulative Layout Shift | < 0.05 |
| Awwwards submission-ready | Yes (design + motion honors bar) |

### 2.3 Non-goals (out of scope for this PRD)
- Changes to the app (`/app`) UI.
- Backend/API changes.
- Blog/CMS, pricing page, auth flows.
- Facebook lead sourcing, AI features (separate roadmap).

---

## 3. Brand System (must be honored)

The page must feel like the same brand as the app and logo.

**Logo:** Friendly-fierce lion head inside a gold **map pin** (the pin = "local"). File: `/logo.png` (transparent). Wordmark: **LeadLion** (one word; "Lion" in gold).

**Color tokens:**
```
--bg:      #0e1116   (near-black base)
--panel:   #161b23
--card:    #1c2330
--border:  #2a3446
--text:    #e8edf5
--dim:     #94a3b8
--accent:  #f5a623   (brand gold — primary)
--accent2: #d97706   (amber)
--gold-lt: #fcd34d
--green:   #34d399   (cold/good)
--red:     #f87171   (hot/critical)
--blue:    #60a5fa
```

**Type:** System stack today (`-apple-system, Segoe UI, Roboto`). For the award page, upgrade to a **premium display typeface** for headlines (see §5.2) + a clean grotesk/sans for body. Must be self-hosted (see §6).

**Voice:** Confident, direct, sales-savvy, a little swagger. Short punchy headlines. No corporate fluff. Example lines already in use: *"Find local businesses that need you — and close them."*, *"Your next 100 clients are one search away."*

**Motif:** The **map pin** and the **opportunity score pill** (colored 0–100 chip) are signature visual elements — reuse them as design language.

---

## 4. Experience Principles (the "Awwwards" bar)

1. **One signature moment.** The page needs a single, memorable interaction people screenshot/share (see §5.3 hero concept). Awwwards juries reward a bold idea executed cleanly, not ten mediocre effects.
2. **Motion with meaning.** Every animation reinforces the story (finding → scoring → closing). Physics-based easing, staggered reveals, scroll-linked scenes. Never gratuitous.
3. **Editorial layout.** Confident whitespace, strong typographic hierarchy, asymmetry, oversized numerals. It should look designed, not templated.
4. **Depth & material.** Layered dark UI, soft gold glows, subtle grain/noise, glassy panels, tasteful shadows. Premium, not flashy.
5. **Perceived speed.** Instant first paint, content-first, animations that never block reading. Respect `prefers-reduced-motion`.
6. **Flawless on every screen.** The mobile experience must be as considered as desktop — most of the target market is on phones.

---

## 5. The Landing Page — Section-by-Section Spec

> Single long-scroll page at `/`. Sticky, glassy nav. Primary CTA everywhere: **Launch App →** (`/app`). Secondary: **See how it works** (anchor).

### 5.1 Sticky Nav
- Left: logo (46px) + "LeadLion".
- Center (desktop): Features · How it works · vs LeadsGorilla · Pricing (anchor).
- Right: **Launch App →** (gold button).
- Behavior: transparent over hero → frosted glass (`backdrop-blur`) after 40px scroll. Subtle border appears. Logo micro-bounces on load.

### 5.2 Hero — the make-or-break
**Headline:** `Find local businesses that ` *(gold gradient)* `need you.` `— and close them.`
**Subhead:** "Search any city. LeadLion scores every business by sales opportunity, audits their Google listing & website, and hands you the report and WhatsApp message to win the deal."
**CTAs:** `Start finding leads free →` (gold, magnetic) + `See how it works` (ghost).
**Trust line:** "No credit card · Works instantly with demo data."

**Art direction:**
- Deep #0e1116 canvas with a large, soft radial gold glow behind the headline.
- Fine animated **grain/noise** overlay (CSS or tiny canvas) for filmic texture.
- Oversized display headline (clamp 40→72px), tight tracking, gold-gradient keyword with a subtle shimmer sweep on load.
- Word-by-word or line **mask reveal** on entry (staggered, spring easing).

**Type upgrade:** self-hosted variable display font for headlines. Suggested directions (pick one, license-clean / open): **Clash Display**, **General Sans**, **Satoshi** (Fontshare — free), or **Space Grotesk** (OFL). Body: **Inter** or **General Sans**. Ship as `woff2`, `font-display: swap`, subset to Latin.

### 5.3 ⭐ Signature Moment — "The Live Lead Radar" (hero interactive)
The one thing that wins the award and *demonstrates the product* at the same time.

**Concept:** An interactive, stylized **map/grid** beside/under the headline showing pins dropping across a city. Each pin pulses and reveals an **opportunity score chip** (red = hot). As the user moves the cursor (or on scroll), pins "scan" and sort — the weakest businesses float to the top of a mini results list that types itself in ("Corner Barbershop — no website — 88").

- **Desktop:** cursor-reactive; pins parallax; a spotlight follows the pointer.
- **Mobile:** auto-plays a 6–8s looped "scan" sequence (reduced-motion: static hero mock instead).
- Built with SVG + CSS/JS or a lightweight canvas. No heavy 3D unless it stays within the perf budget.
- This replaces the current static "browser mockup" with something alive and on-message.

*Fallback:* if the interactive is too heavy on mobile, degrade to the polished static results mockup we already have.

### 5.4 Logo/Proof Strip
- Rotating stat counters that count up on scroll: **150+** leads/search · **23** audit checks · **$0** /month · **1-click** WhatsApp.
- Optional: faux "trusted by agencies in 20+ countries" world-dot map (subtle).

### 5.5 "The Problem" — tension section
Short, punchy: *"Most local businesses are quietly losing customers — and they don't even know it."* Animated illustration of a broken/slow listing. Sets up the value.

### 5.6 Features — the capability grid
6 cards, each with a **custom gold line-icon** (already built), on hover: lift + glow + a tiny animated micro-demo (e.g., the score chip filling, the map pin dropping, a chat bubble typing).
1. Deep city search
2. Google + website audits
3. Competitor benchmarking
4. Branded reports + open-tracking
5. 1-click WhatsApp outreach
6. Built-in CRM & pipeline

Consider a **scroll-pinned "product tour"**: as the user scrolls this section, a device frame on one side swaps through real app screens (search → audit → report → WhatsApp) synced to the text.

### 5.7 "How it works" — 4 steps
Numbered, horizontally-scrolling or scroll-snapped steps with connecting line animation: **Search a market → Audit in one click → Send the report → Close the deal.** Each step animates in with a real UI snippet.

### 5.8 The Killer Proof — "Show, don't tell"
Interactive mini-audit: visitor types **any business name / their own** → we show a *teaser* audit card (score + 2 findings) → "See the full report in the app." (Uses demo/live tastefully; rate-limited.) This is a second signature moment and a conversion driver.

### 5.9 vs LeadsGorilla — comparison
Sleek comparison table (already drafted): cost, leads/search, real speed audit, competitor benchmarking, open-tracking, WhatsApp, "your data." Animate the ✓/✗ in on scroll. Keep it classy, not petty.

### 5.10 Pricing / Access
Frame the tiers: **Demo (free) · Trial (issued code) · Full.** Emphasize "$0 to run, your infrastructure." CTA to launch.

### 5.11 Testimonials (when available)
Placeholder-ready card marquee. Until real ones exist, use outcome-framed statements ("From a 151-lead scan to 3 booked calls in a day") clearly labeled as illustrative.

### 5.12 Final CTA — big finish
Full-bleed gold-gradient panel: *"Your next 100 clients are one search away."* Giant CTA. Lion pin subtly animated (breathing glow). This is the emotional close.

### 5.13 Footer
Logo, tagline, links (Privacy, Terms, Contact `aifi2k02@gmail.com`), "Built for local marketing agencies." Keep it minimal and elegant.

---

## 6. Technical Requirements & Guardrails

**Non-negotiable stack constraints:**
- **Cloudflare Pages**, static, **no build step** (or a build that outputs to `public/`). Today the site is hand-authored HTML/CSS/JS in `public/`.
- **Self-contained assets.** Fonts, images, icons must be **self-hosted** (`woff2`, inline SVG). No render-blocking external CDNs. (Leaflet/OSM is only used inside the app map, not the landing page.)
- **Performance budget:** total landing weight < **600 KB** on first load (excluding lazy media); hero interactive < 60 KB JS. Lazy-load below-the-fold media. Use `content-visibility` for offscreen sections.
- **Motion tech:** prefer CSS animations + the Web Animations API + `IntersectionObserver` + `scroll-timeline` where supported. If a library is used, keep it tiny (e.g., a scroll/animation micro-lib) and self-hosted — no heavy frameworks.
- **Theme-aware & accessible:** dark by default (brand). Respect `prefers-reduced-motion` (disable parallax/auto-play, keep static). All interactive elements keyboard-navigable; visible focus states; semantic landmarks; alt text; WCAG AA contrast (mind gold-on-dark for small text).
- **Responsive:** fluid type (`clamp`), no horizontal scroll, thumb-friendly targets; the signature interactive has a defined mobile fallback.
- **SEO/meta:** proper `<title>`, meta description, Open Graph + Twitter cards, `og:image` (a branded 1200×630 card), favicon (already set), structured data (SoftwareApplication).
- **PWA-safe:** the service worker must **not** intercept `/` improperly (already fixed — SW ignores `/`, `/admin`, `/privacy`, `/terms`).
- **No layout shift:** reserve space for hero media/fonts; preload the display font.

**Files impacted:** `public/index.html` (landing), a new `public/landing.css` (extract inline styles), `public/landing.js` (hero interactive + scroll motion), `public/fonts/*.woff2`, `public/og-image.png`. The app (`/app`, `app.js`) is untouched.

---

## 7. Content & Copy (source of truth)

- **Hero H1:** "Find local businesses that **need you** — and close them."
- **Hero sub:** "Search any city. LeadLion scores every business by sales opportunity, audits their Google listing & website, and hands you the report and WhatsApp message to win the deal."
- **Stat strip:** 150+ leads/search · 23 audit checks · $0/month · 1-click WhatsApp.
- **Final CTA:** "Your next 100 clients are one search away."
- **Tone rules:** active voice, second person ("you"), specific numbers over adjectives, no jargon, no fake urgency/countdowns (we're better than that).

---

## 8. Motion & Interaction Detail

| Element | Interaction |
|---|---|
| Page load | Nav + hero mask-reveal, staggered; gold glow fades in |
| Headline keyword | One-time gold shimmer sweep |
| Primary CTA | Magnetic hover (follows cursor slightly) + gold glow pulse |
| Hero radar | Cursor-reactive pins / scroll-scan; mobile auto-loop |
| Stat counters | Count-up on first view |
| Feature cards | Lift + border-glow + micro-demo on hover |
| Product tour | Scroll-pinned device frame swaps screens |
| Comparison | ✓/✗ stagger-in |
| Final CTA | Breathing lion-pin glow |
| Global | `prefers-reduced-motion` → all of the above become static/instant |

**Easing:** spring / `cubic-bezier(0.16,1,0.3,1)` for reveals; avoid linear. Durations 300–700ms. Stagger 40–80ms.

---

## 9. Deliverables & Milestones

**Phase A — Design direction (before code)**
- Moodboard + type pairing chosen.
- Hi-fi hero comp (desktop + mobile) with the signature interactive storyboarded.
- Motion spec (this doc + a short annotated flow).

**Phase B — Build**
1. Foundation: fonts, tokens, nav, hero (static) — ship, measure LCP.
2. Signature hero interactive + mobile fallback.
3. Remaining sections + scroll motion.
4. Polish: micro-interactions, reduced-motion, a11y pass, perf pass.

**Phase C — Ship & submit**
- Lighthouse ≥ 90/95, cross-device QA.
- OG image + meta.
- Deploy, then prepare an Awwwards/Godly/CSSDA submission (screenshots + short write-up of the "Live Lead Radar" concept).

**Acceptance criteria:** meets §2.2 metrics; the signature moment works on desktop + degrades gracefully on mobile + reduced-motion; brand system honored; zero horizontal scroll; no external render-blocking deps.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Heavy hero interactive tanks mobile perf | Strict JS budget; canvas/SVG not 3D; mobile auto-loop is a lightweight pre-rendered sequence; reduced-motion static fallback |
| Fonts cause FOUT/CLS | Preload, `font-display: swap`, subset, reserve space |
| "Award effects" hurt conversion/readability | Motion never blocks content; CTAs always visible; test scroll-depth |
| Scope creep vs zero-cost/no-build rule | Keep hand-authored in `public/`; any tooling must output static, self-contained files |
| Interactive mini-audit abused | Rate-limit; use demo data or capped live |

---

## 11. Appendix — Current state to build on

- Existing landing already has: nav, hero, static mockup, stat strip, features (with custom gold SVG icons), how-it-works, vs-LeadsGorilla table, final CTA, footer — all in `public/index.html`, dark theme, brand tokens inline.
- This PRD is an **upgrade to award-tier**, not a from-scratch rebuild: keep the copy and structure that works; elevate art direction, typography, motion, and add the two signature interactive moments (Lead Radar hero + live mini-audit).
- The app it drives to (`/app`) is complete and live at `leadlion.pages.dev`.

---

*End of PRD.*
