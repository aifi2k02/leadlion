# 🦁 LeadLion

**Find, score, and close local business leads.** A modern, self-hosted alternative to LeadsGorilla — search any niche in any city, get every business scored by sales opportunity, generate branded audit reports (PDF), and get personalized outreach scripts. Built for a $0/month stack.

## What it does

1. **Find Leads** — search "plumber in Austin TX" → 20 businesses pulled live from Google Places, each scored 0–100 by *opportunity* (how badly they need marketing help).
2. **Explainable audits** — every score breaks down into 10 weighted factors (website, reviews, rating, photos, claimed status, hours…), each with a sales pitch attached.
3. **Branded audit reports** — one click per lead → client-ready PDF report with your agency's name and contact details (browser Print → Save as PDF).
4. **Outreach scripts** — cold email + phone script auto-written from that business's *actual* audit findings.
5. **Pipeline CRM** — save leads, move them through New → Contacted → Meeting → Won/Lost, add notes, export CSV.
6. **Works instantly** — demo-data mode with no keys; add a free Google API key for live data; connect Supabase to sync leads across devices.

## Stack ($0/month)

| Layer | Service | Free tier |
|---|---|---|
| Hosting + serverless API | Cloudflare Pages + Pages Functions | 100k requests/day |
| Database (optional sync) | Supabase | 500 MB Postgres |
| Business data | Google Places API (New) | thousands of calls/month free |
| Deploys | GitHub → Cloudflare auto-deploy | free |

No build step. No npm dependencies in production.

## Deploy (10 minutes)

1. **Push to GitHub** — create a repo, push this folder.
2. **Cloudflare Pages** — dash.cloudflare.com → Workers & Pages → Create → Pages → connect the repo.
   - Build command: *(leave empty)*
   - Build output directory: `public`
   - The `functions/` directory is picked up automatically as your API.
3. **Google API key (for live data)** — console.cloud.google.com → create project → enable **Places API (New)** → create API key.
   - Best: add it in Cloudflare Pages → Settings → Variables and Secrets as `GOOGLE_PLACES_API_KEY` (server-side, never exposed).
   - Or: paste it in the app's Settings page (stored in your browser only).
4. **Supabase (optional, for cross-device lead sync)** — open your Supabase project → SQL Editor → run `schema.sql` → copy Project URL + anon key into the app's Settings page.

## Local development

```bash
npx wrangler pages dev public
# → http://localhost:8788
```

## Project structure

```
public/            static frontend (no build step)
  index.html
  app.js           SPA: views, storage layer, report + outreach generators
  styles.css
functions/
  api/search.js    POST /api/search — Google Places proxy + demo fallback
  _lib/scoring.js  the 10-factor scoring engine
  _lib/demo.js     deterministic demo-data generator
schema.sql         Supabase table + RLS (run once)
```

## Why it beats LeadsGorilla

- **$0/month self-hosted** vs $49–99/month subscription
- **Transparent scoring** — every point traceable to a factor, shown to the client in the report
- **Outreach scripts personalized per-lead** from real audit findings, not generic templates
- **Your data** — leads live in your Supabase, not a vendor's silo
- **Unlimited searches** within Google's generous free tier, no artificial credit limits
