# Bring Your Own Key (BYOK) — User Manual

*How LeadLion's live data works, why we do it this way, and how to set it up in about 5 minutes.*

---

## 1. What is BYOK?

LeadLion finds real local businesses using **Google's Places data** — ratings, reviews, photos, websites, opening hours, and more. Every search you run makes calls to Google's API, and Google charges for those calls.

**BYOK — "Bring Your Own Key" — means those searches run on *your* Google account, using a free key you create in a few minutes, instead of ours.**

You paste your Google API key once into **Settings → Your Google API key**. From then on:

- Your searches are **unlimited** — capped only by your own Google budget, not by us.
- Google bills **you** directly for what you use (and for most people, that's **nothing** — see below).
- We **stop counting API credits** for you entirely.

Your key lives in **your browser only**. It is sent with each search but **never saved on our servers**. (More on this in the Privacy section.)

---

## 2. Why we do it this way

Most lead-generation tools quietly resell you the same Google data at a markup, or lock "unlimited" searches behind a monthly subscription that gets more expensive the more you use it. We think that's backwards. Here's our approach:

**You buy LeadLion once. You never pay us for API usage.**

- The Google calls have a real cost. Instead of marking them up and reselling them to you, we let you pay Google **directly, at cost** — which is usually **$0** thanks to Google's free tiers.
- That keeps LeadLion **cheap and honest**: a one-time tool, not a meter that punishes you for using it.
- It makes your searches **genuinely unlimited**. Your volume is limited by your own Google allowance (which is generous), not by credits we ration to protect our bill.

In short: **BYOK is how we keep the software affordable and your searches uncapped — by taking our markup on API calls down to zero.**

---

## 3. What it actually costs you

For almost everyone, running LeadLion on your own key costs **nothing** for a long time:

- **New to Google Cloud?** Google gives every new account a **one-time free trial — currently $300 in credit over 90 days.** Your first few months of searching typically cost $0, and Google **does not charge your card** during the trial; services simply pause if you somehow exhaust it.
- **After the trial**, Google still includes a **free monthly usage allowance that renews on the 1st of each month.** Light and normal usage usually stays inside it.
- **Only if you go beyond the free allowance** in a heavy month do you pay Google — directly, and typically a small amount.

The **usage counter in Settings** shows where you stand each month (it resets on the 1st). Call counts are exact; the dollar figure is a labelled estimate.

> **You are never billed by LeadLion for API usage. Google bills you directly, and only if you exceed its free tier.**

---

## 4. Your key is private

We designed BYOK so we never hold your billable credential:

- Your key is stored in **this browser only** (local storage). Clearing your browser data removes it.
- It is **sent with each search request** so the search can run — and then **discarded**. We **never save it** on our servers or in any database.
- Why it matters: if we stored customer keys, a single breach could leak every customer's billable Google key at once. Keeping it in your browser removes that risk entirely.

---

## 5. Setting up your key (about 5 minutes)

1. Go to **[console.cloud.google.com](https://console.cloud.google.com)** and **create a project** (any name).
2. **Enable these three APIs** (search each by name in the console and click *Enable*):
   - **Places API (New)**
   - **Geocoding API**
   - **PageSpeed Insights API**
3. Go to **APIs & Services → Credentials → Create credentials → API key.**
4. Click the new key. Under **"APIs that can be accessed using this key,"** restrict it to just those three APIs. Press **OK**, then **Save** at the bottom of the page.
   > ⚠️ The **OK** button alone does not save — you must also click **Save** at the bottom.
5. **Enable billing** on the project. Google requires a card on file even for the free tier, but **it isn't charged unless you exceed the free allowance.**
6. Copy the key (it starts with `AIza…`) and **paste it into LeadLion → Settings → Your Google API key.**

**Leave "Application restrictions" set to `None`.** LeadLion's searches run from our server, so a *website* restriction would block every request. Restricting by **API** (step 4) is what keeps the key safe — restricting by website would break it.

---

## 6. Test your key

After pasting your key, click **Test key** (next to the input in Settings). It runs **one live search on your key** and tells you exactly where you stand:

| Result | What it means | What to do |
|---|---|---|
| ✅ **Working** | Your key is valid and LeadLion ran a real search on it. | Nothing — you're all set. |
| ✗ **Google rejected it** | The key exists but Google won't accept it (API not enabled, or a website restriction is blocking it). | Confirm **Places API (New)** is enabled and **Application restrictions = None**. |
| ⚠️ **Not a valid key format** | What you pasted doesn't look like a Google key (they start with `AIza…`). | Re-copy the key — a stray space or truncation is common. |

**Why testing matters:** without it, a mistyped or mis-restricted key can fail *silently* — your searches would quietly fall back to a shared key (or fail mid-search) and you'd never know. The Test button removes the guesswork.

---

## 7. FAQ

**Will my card be charged?**
Not by LeadLion, ever. By Google, only if you exceed its free monthly allowance (and never at all during the one-time $300 / 90-day trial).

**Do you see or store my key?**
No. It stays in your browser and is only passed along to run each search. We never save it.

**Why must "Application restrictions" be `None`?**
Searches are made from LeadLion's server, not your browser, so there's no fixed website or IP to restrict to. The **API restriction** (limiting the key to the three APIs) is what secures it.

**Can I remove or change my key?**
Yes — clear the field in Settings (or clear your browser data) and it's gone. Paste a new one anytime.

**What if I don't add a key?**
You can explore with sample/demo data and any credits issued to you, but live, unlimited searching needs your own key — that's the model.

**A different Google account resets the free trial.**
Each new Google account gets its own one-time $300 / 90-day trial, so a fresh account is also a fresh allowance.

---

*Questions or a key that won't validate? Use **Test key** first — it usually points straight at the fix.*
