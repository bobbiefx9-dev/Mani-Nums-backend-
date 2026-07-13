# Deploying Mani Nums

Two things to deploy: the backend (Node/Express/SQLite) and the static
website (the HTML files). They're independent — deploy in either order,
but you'll need the backend's URL before the site is fully working.

## 1. Deploy the backend (Render)

Render is used here because its free/starter tier includes a persistent
disk, which the SQLite database needs (most hosts wipe local disk on every
deploy — Render's disk survives deploys and restarts).

1. Push the `backend/` folder to a GitHub repo (Render deploys from git).
2. In the Render dashboard: New → Blueprint, point it at the repo. It will
   read `render.yaml` and set up the service, including a 1GB disk mounted
   at `/opt/render/project/src/data`.
3. Render will prompt you to fill in the env vars marked `sync: false` in
   `render.yaml` (Twilio, Stripe, SMTP, `SITE_URL`, `ALLOWED_ORIGIN`) — use
   your **live** Twilio/Stripe credentials here, not test ones, once you're
   ready to accept real payments. `JWT_SECRET` is generated for you.
4. Deploy. Render gives you a URL like `https://mani-nums-backend.onrender.com`
   — that's your backend's public address.
5. In the Stripe Dashboard (Developers → Webhooks), add an endpoint at
   `https://mani-nums-backend.onrender.com/api/webhooks/stripe`, subscribed
   to `checkout.session.completed`. Copy the signing secret it gives you
   into the `STRIPE_WEBHOOK_SECRET` env var on Render.
6. In the Twilio Console, for each number you plan to resell, set its
   messaging webhook to `https://mani-nums-backend.onrender.com/api/webhooks/sms`.

Prefer Railway or Fly.io instead? Same idea — just make sure whichever you
pick gives you a **persistent volume**, and mount it, and set `DB_PATH` to
somewhere inside that volume (see `.env.example`).

## 2. Deploy the website (Netlify, Vercel, or similar)

The site is plain HTML/CSS/JS — no build step.

**Netlify (drag-and-drop, fastest):**
1. Go to app.netlify.com/drop
2. Drag in the folder containing `farline-website.html`, `account.html`,
   `success.html`, `verify-email.html`, `reset-password.html`, and `config.js`
3. Netlify gives you a URL immediately (rename it in site settings if you want)

**Vercel (if you prefer it, or want git-based deploys):**
```bash
npm install -g vercel
cd path/to/site-folder
vercel --prod
```

Either way, once deployed, rename `farline-website.html` to `index.html`
(or configure the host's redirect/rewrite rules) so it loads at the root URL.

## 3. Point the two halves at each other

Open `config.js` and change the one line:

```js
window.FARLINE_API_BASE = 'https://mani-nums-backend.onrender.com';
```

This is the only file that needs editing — every page (`farline-website.html`,
`account.html`, `success.html`, `verify-email.html`, `reset-password.html`)
reads from this shared value.

Then, back on the backend, make sure these two env vars match your deployed
site's real URL:
- `SITE_URL` — used to build the links inside verification/reset emails,
  and the Stripe Checkout success/cancel URLs
- `ALLOWED_ORIGIN` — CORS allowlist; must match exactly (including https://
  and no trailing slash) or the browser will block requests to the backend

## 4. Going live with real money

Both Stripe and Twilio have a test/sandbox mode you've been using so far.
Before accepting real customers:

- **Stripe**: toggle to Live mode in the dashboard, generate live API keys,
  update `STRIPE_SECRET_KEY` on the backend, and redo the webhook endpoint
  setup for live mode (test-mode and live-mode webhooks are separate).
- **Twilio**: upgrade from a trial account (trial accounts can only send
  SMS to verified numbers and show a "sent from a Twilio trial account"
  prefix) — add a payment method in the Twilio Console.
- Re-check `https://www.twilio.com/en-us/guidelines/global-number-availability`
  for which countries you can actually list, and any KYC/regulatory bundle
  requirements for specific countries — some require manual approval in
  the Twilio Console, not just an API call.

## 5. What's still manual after deployment

- **Monitoring/logs**: Render's dashboard shows logs by default; consider
  adding error alerting (e.g. Sentry) before real users hit issues you
  won't otherwise notice.
- **Database backups**: the SQLite file on the persistent disk isn't
  automatically backed up — Render's disks don't include automatic
  snapshots on the starter tier. Consider a scheduled job that copies
  `farline.db` somewhere durable (S3, etc.), or migrate to a managed
  Postgres instance if this grows past a hobby project.
- **Refunds for failed purchases**: `server.js` has a `TODO` where a Stripe
  payment succeeds but the Twilio purchase fails — that still needs a human
  or an automated refund flow.
