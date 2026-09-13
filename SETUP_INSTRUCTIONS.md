# ✅ Camping Booking Backend - Setup Instructions

## 🎯 What This Is

This is the **complete fixed backend** for your Team Explo Era adventure booking system.

**Technology:** Cloudflare Workers + Telegram Bot Integration  
**Status:** ✅ Ready to deploy  
**Key Fix:** `wrangler.toml` has been updated with correct `SITE_BASE_URL`

---

## 🚀 Quick Deploy (5 minutes)

### Step 1: Prerequisites

Make sure you have:
```bash
node --version      # Should show: v16.x.x or higher
npm --version       # Should show: 8.x.x or higher
git --version       # Should show: git version 2.x.x
```

**If missing, install:**
- Node.js: https://nodejs.org/
- Git: https://git-scm.com/

### Step 2: Navigate to Project

```bash
cd Camping-booking-backend
```

### Step 3: Install Dependencies

```bash
npm install
```

Wait for completion (1-2 minutes).

### Step 4: Authenticate with Cloudflare

```bash
wrangler login
```

A browser window opens → Log in with your Cloudflare account → Click Authorize → Done

### Step 5: Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

**You should see:**
```
✓ Published to https://teamexploera-backend.book-and-explore.workers.dev
```

### Step 6: Test It Works

```bash
curl https://teamexploera-backend.book-and-explore.workers.dev/api/content?site=root
```

**Should return JSON** (not error)

---

## ✅ That's It!

Your backend is now deployed and working. ✨

---

## 📁 What's Included

```
Camping-booking-backend/
├── wrangler.toml              ← ✅ FIXED with correct SITE_BASE_URL
├── package.json               ← Dependencies
├── src/
│   ├── index.js               ← Main API router
│   ├── booking.js             ← Booking endpoints
│   ├── content-api.js         ← Content/pricing endpoints
│   ├── telegram-bot.js        ← Telegram admin bot
│   ├── era-ai.js              ← AI chat assistant
│   ├── pricing.js             ← Price calculations
│   ├── ratings.js             ← Visitor ratings
│   ├── reviews.js             ← Reviews management
│   ├── store.js               ← Data storage
│   ├── stats.js               ← Statistics
│   ├── conversations.js       ← Chat conversations
│   ├── telegram.js            ← Telegram utilities
│   ├── telegram-bot-additions.js
│   ├── content-schema.js      ← Content schema
│   └── walker.js              ← Tree walking utilities
│
└── SETUP_INSTRUCTIONS.md      ← This file
```

---

## 🔧 Configuration

### wrangler.toml - ALREADY FIXED ✅

This file has been updated with:

```toml
# ✅ This is now correct:
SITE_BASE_URL = "https://team-eplo-era-explore.pages.dev/"

# Your Telegram settings:
TELEGRAM_CHAT_ID = "-1003766158262"
TELEGRAM_ADMIN_CHAT_ID = "8550710288"
ADMIN_USER_IDS = "8550710288"
```

### Environment Secrets (First Time Only)

You need to set these one-time secrets. In terminal:

```bash
# Telegram bot token (from @BotFather)
wrangler secret put TELEGRAM_BOT_TOKEN
# → Paste your token → Press Enter → Ctrl+D (Mac) or Ctrl+Z (Windows)

# Random secret for webhooks
wrangler secret put WEBHOOK_SECRET
# → Paste something like: abc123xyz789secret → Press Enter → Ctrl+D/Ctrl+Z

# Random secret for admin API
wrangler secret put ADMIN_API_SECRET
# → Paste something like: admin_secret_123 → Press Enter → Ctrl+D/Ctrl+Z
```

**Verify secrets are set:**
```bash
wrangler secret list
```

Should show all three secrets.

---

## 🚀 API Endpoints

Your backend provides these endpoints:

### Content & Pricing
```
GET  /api/content?site=root|krem-chympe|wilderness-expedition
GET  /api/prices?site=root
GET  /api/images?site=root
GET  /api/highlights?site=root
POST /api/calculate-price
```

### Bookings
```
POST /api/visit          ← User visits site
POST /api/tap            ← User taps item
POST /api/draft          ← User creates draft
POST /api/submit         ← User submits booking
GET  /api/status/:id     ← Check booking status
```

### AI Chat (ERA)
```
POST /api/era/message    ← Send message to AI
GET  /api/era/poll       ← Get AI response
POST /api/era/typing     ← User is typing
```

### Ratings
```
GET  /api/ratings?site=root
POST /api/ratings        ← Submit rating
```

---

## 🔄 Redeploy (After Making Changes)

If you make changes to the code:

```bash
# Edit files as needed

# Commit and push
git add .
git commit -m "Description of changes"
git push origin main

# Deploy
npx wrangler deploy
```

---

## 🆘 Troubleshooting

### "wrangler: command not found"
```bash
npm install -g wrangler
```

### "Cannot find module"
```bash
npm install
npx wrangler deploy
```

### "Unauthorized (401)" error
```bash
wrangler logout
wrangler login
npx wrangler deploy
```

### Deployment times out
```bash
# Try again (sometimes Cloudflare is slow)
npx wrangler deploy
```

### "KV namespace does not exist"
```bash
# The namespace ID might be wrong. Create a new one:
wrangler kv:namespace create BOOKINGS

# Copy the ID it gives you
# Open wrangler.toml and update the id in:
# kv_namespaces = [ { binding = "BOOKINGS", id = "PASTE_HERE" } ]

# Then redeploy
npx wrangler deploy
```

### API returns 404
```bash
# Check deployment was successful
wrangler deployments list

# If last deployment failed, redeploy
npm install
npx wrangler deploy
```

---

## 📋 Testing Endpoints

### Test if backend is running

```bash
curl https://teamexploera-backend.book-and-explore.workers.dev/api/content?site=root
```

Should return JSON with your site configuration.

### Test booking submission

```bash
curl -X POST https://teamexploera-backend.book-and-explore.workers.dev/api/submit \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "phone": "9160018775",
    "package": "Cave Expedition",
    "total": 5000
  }'
```

Should return booking confirmation.

---

## 🔗 Integration with Frontend

The frontend (`team-eplo-era-site`) automatically connects to this backend.

**Frontend uses these endpoints:**
- Fetches site content from `/api/content`
- Submits bookings to `/api/submit`
- Gets prices from `/api/calculate-price`

**File that connects them:** `team-eplo-era-explore/live-content.js`

```javascript
// This is already set correctly:
const BACKEND_URL = "https://teamexploera-backend.book-and-explore.workers.dev";
```

---

## 📊 View Backend Logs

To see what's happening on your backend:

```bash
wrangler tail
```

This shows real-time logs of requests and errors.

---

## 🗑️ Reset Everything

If you want to start fresh:

```bash
# Delete all bookings and content from KV
wrangler kv:key delete --namespace-id cd92b965c0ed4581bebe2cb0b941d9cb "*"

# WARNING: This deletes everything! Use with caution.
```

---

## 📞 Quick Reference

**Backend URL:** `https://teamexploera-backend.book-and-explore.workers.dev`

**Test backend:**
```bash
curl https://teamexploera-backend.book-and-explore.workers.dev/api/content?site=root
```

**Deploy:**
```bash
npx wrangler deploy
```

**View logs:**
```bash
wrangler tail
```

**List deployments:**
```bash
wrangler deployments list
```

---

## ✅ Deployment Checklist

Before deploying, verify:

- [ ] You have Node.js installed
- [ ] You have Cloudflare account
- [ ] You have Telegram bot token
- [ ] `npm install` completed without errors
- [ ] `wrangler login` succeeded
- [ ] Secrets are set (`wrangler secret list`)
- [ ] `wrangler.toml` has correct `SITE_BASE_URL`

Then:
```bash
npx wrangler deploy
```

Wait for success message and test with curl.

---

## 🎯 What Happens Next

1. ✅ Backend deploys to Cloudflare Workers
2. ✅ Frontend can access backend APIs
3. ✅ Bookings are saved and forwarded to Telegram
4. ✅ Admin bot receives notifications
5. ✅ Visitors can submit forms and contact you via WhatsApp

---

## 📵 Manual WhatsApp Mode (added)

A new toggle in the Telegram admin bot's main menu — **"📵 Manual WhatsApp
Mode"** — lets you take bookings off the automatic guide-assignment
pipeline and send them to the group only, with visitors backed up on
WhatsApp too. No redeploy needed to use it day-to-day — it's a live
switch stored the same way as every other admin setting.

**When you turn it ON, every new booking:**
- Posts to Telegram **immediately, automatically** — exactly like
  normal, except it always goes to the **group only** (guide
  auto-assignment is skipped entirely, even if an eligible guide
  exists), tagged "📵 Manual booking" so it's easy to spot.
- Arrives with the **receipt attached** (if the visitor uploaded one)
  and working **✅ Confirm / ❌ Reject / 🚫 Block** buttons — same as
  any other booking.
- **Also** opens the visitor's own WhatsApp automatically, prefilled
  with every booking detail plus a short code — as a backup record for
  both of you, sent at the same time as the group post, not instead of
  it.
- The site's live "waiting for your guide" status tracker is off for
  visitors (there's no live guide-confirmation wait to show, since it's
  group-only) — they see a simple "Booking Sent — Check WhatsApp"
  screen instead.

If the group post itself fails for some reason (bad bot token, bot not
in the group, etc.), the booking isn't lost — it's saved and can be
posted later by pasting its code into the bot (the same code the
visitor's WhatsApp message shows), which posts it then instead. In the
normal, working case this fallback never comes into play.

**When you turn it OFF:** everything instantly goes back to normal for
every new booking — guide auto-assignment and live status tracking on
the site, both restored. Nothing needs to be migrated.

Where to find it: open the bot, tap **/menu**, and the toggle is near
the bottom of the main menu. The menu also shows a banner reminding you
it's on, so you can't forget it's active.

---

## 🛡️ Security Hardening (added)

This Worker now has an active security layer (`src/security.js`) sitting in
front of every route. **No new bindings and no wrangler.toml changes are
needed — just deploy as usual.**

**What it does automatically:**
- Blocks IPs on a growing blocklist (24h auto-block after repeated abuse)
- Detects and blocks common attack probes (SQLi/XSS payloads, path
  traversal, `.env`/`wp-admin`/`phpmyadmin`-style scanner requests, known
  vulnerability-scanner user agents)
- Rate-limits every endpoint per IP (tighter on booking/rating/chat
  submissions, looser on public reads)
- Rejects oversized request bodies before they're parsed
- Sends you a **Telegram alert** the moment it blocks or flags an IP
  (throttled so an attacker can't spam your chat)
- Uses timing-safe comparison for `ADMIN_API_SECRET` and
  `TELEGRAM_WEBHOOK_SECRET` (was a plain `!==` before — vulnerable in
  theory to a timing attack)
- Adds standard security response headers (`X-Frame-Options`,
  `X-Content-Type-Options`, a strict `Content-Security-Policy`, etc.)
- A hidden honeypot field on every booking form silently drops
  bot-submitted bookings before they ever reach Telegram

**New admin endpoints** (same `x-admin-secret` header as
`/api/admin/reset-images` — set via `wrangler secret put ADMIN_API_SECRET`
if you haven't already):
- `GET /api/admin/security-status?ip=1.2.3.4&secret=...` — check if an IP
  is currently blocked
- `POST /api/admin/unblock` `{ "ip": "1.2.3.4" }` (header
  `x-admin-secret`) — lift a block, e.g. if a real visitor gets caught by
  mistake

**What you'll see in Telegram** when something suspicious happens:
a `🚨 Security alert` message in your admin chat with the offending IP,
what triggered it, and the path involved. If it crosses the strike
threshold you'll also get an "IP auto-blocked" message.

**Worth doing on top of this (Cloudflare-side, outside this repo):**
- Turn on Cloudflare's free **WAF managed rules** and **Bot Fight Mode**
  for the domain in front of this Worker (dashboard → Security) — this
  catches volumetric/DDoS-scale attacks *before* they even reach the
  Worker, which no application-level code can do.
- Rotate `TELEGRAM_BOT_TOKEN`, `ADMIN_API_SECRET`, and
  `TELEGRAM_WEBHOOK_SECRET` periodically, and confirm they're set as
  **Secrets** (`wrangler secret put ...`), never in `[vars]`.
- Consider adding Cloudflare Turnstile (free, privacy-friendly CAPTCHA)
  to the booking form for extra bot resistance — ask if you'd like this
  wired in.

---

## 📚 Additional Resources

- **Cloudflare Workers Docs:** https://developers.cloudflare.com/workers/
- **Wrangler CLI Docs:** https://developers.cloudflare.com/workers/wrangler/install-and-update/
- **Telegram Bot API:** https://core.telegram.org/bots/api

---

## ✨ You're All Set!

This backend is completely fixed and ready to run.

**Frontend Setup:** See `team-eplo-era-explore/SETUP_INSTRUCTIONS.md`

**Status:** ✅ Ready to Deploy

---

**Version:** 1.0 - September 2, 2026  
**Status:** ✅ Fully Fixed  
