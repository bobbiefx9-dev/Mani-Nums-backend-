# Mani Nums — Twilio-backed numbers marketplace

Two pieces:
- `farline-website.html` — the storefront (front-end only, no build step)
- `backend/` — a small Express server that talks to Twilio on the site's behalf

The website never talks to Twilio directly. It calls your backend; your backend
holds the Twilio credentials and makes the real API calls. This is required —
if the Auth Token ships in the browser, anyone can read it and drain your
Twilio account.

## 1. Set up the backend

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` — from the Twilio Console
  (console.twilio.com), under Account Info.
- `ALLOWED_ORIGIN` — wherever you're serving the website from, e.g.
  `http://localhost:5500` if you're using a local dev server.
- `STRIPE_SECRET_KEY` — from dashboard.stripe.com/test/apikeys. Use a
  **test mode** key while developing; it starts with `sk_test_`.
- `SITE_URL` — where the website is served from, so Stripe knows where to
  send the user back to after paying.
- `STRIPE_WEBHOOK_SECRET` — see below, this one takes an extra step.
- `JWT_SECRET` — any long random string, used to sign login sessions.
  Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` — used to
  send verification and password-reset emails. For local testing without a
  real mailbox, sign up free at ethereal.email — it gives you throwaway
  SMTP credentials and a web inbox where you can see the emails your
  backend sends, without needing a real inbox or a paid provider.

### Database

User accounts and purchased numbers are stored in a local SQLite file,
`backend/farline.db`, created automatically the first time you run the
server (via `db.js`). No separate database server to install. Delete the
file to reset everything during development.

### Stripe webhook setup (local development)

Stripe needs to notify your backend when a payment succeeds. Locally, use
the Stripe CLI to forward events to your machine:

```bash
stripe login
stripe listen --forward-to localhost:4000/api/webhooks/stripe
```

This prints a `whsec_...` value — put that in `.env` as `STRIPE_WEBHOOK_SECRET`.
Keep `stripe listen` running alongside `npm start` while you test.

In production, instead create a webhook endpoint in the Stripe Dashboard
(Developers → Webhooks) pointing at `https://your-domain.com/api/webhooks/stripe`,
subscribed to the `checkout.session.completed` event, and use the signing
secret it gives you.

Then run it:

```bash
npm start
```

You should see `Mani Nums backend running on http://localhost:4000`.

## 2. Point the website at your backend

Open `farline-website.html`. Near the top of the `<script>` block there's:

```js
const API_BASE = window.FARLINE_API_BASE || 'http://localhost:4000';
```

If your backend runs somewhere other than `localhost:4000` (e.g. once deployed),
either edit that default, or set `window.FARLINE_API_BASE = '...'` in a
`<script>` tag before this one loads.

Serve the HTML file with any static server (opening it directly as a `file://`
URL will also work for browsing, but `fetch` calls to the backend need the page
served over http:// to avoid CORS/mixed-content issues in some browsers):

```bash
npx serve .
```

## 3. What works right now vs. what's still a placeholder

**Works against real Twilio + Stripe, once `.env` is filled in:**
- Email/password accounts (`POST /api/auth/signup`, `POST /api/auth/login`,
  `GET /api/auth/me`) — passwords are hashed with bcrypt, sessions are JWTs
  sent as `Authorization: Bearer <token>`.
- **Email verification.** Signup sends a verification email
  (`verify-email.html` + `GET /api/auth/verify-email`). Reserving a number
  now requires a verified email — `POST /api/checkout/create-session` uses
  a `requireVerified` middleware, distinct from `requireAuth`, so you can
  reuse `requireAuth` alone anywhere you just need "logged in" without also
  needing "proven their email."
  `POST /api/auth/resend-verification` re-sends the email if needed.
- **Password reset.** `POST /api/auth/request-password-reset` (always
  responds the same way whether or not the email exists, to avoid leaking
  which addresses have accounts) + `reset-password.html` +
  `POST /api/auth/reset-password`. Reset and verification tokens are
  random, stored only as a hash in `auth_tokens`, and expire (1 hour for
  reset, 24 hours for verification).
- Searching available numbers per country (`GET /api/numbers/search`)
- Real payment flow, now tied to a logged-in user: the site requires login
  before creating a Stripe Checkout session
  (`POST /api/checkout/create-session`), the user pays on Stripe's hosted
  page, and only once Stripe confirms payment (via the
  `/api/webhooks/stripe` webhook) does the backend buy the number from
  Twilio and save it in the database against that user's account.
- `GET /api/numbers/mine` — a logged-in user's own purchased numbers, from
  our database (as opposed to `/api/numbers/owned`, which is admin-only and
  lists the whole Twilio account).
- `GET /api/numbers/mine/:phoneNumber/messages` — a basic inbox: incoming
  SMS to a number are now saved (see `/api/webhooks/sms`), and this
  endpoint returns them, after confirming the requesting user actually
  owns that number.
- **`account.html`** — a page using both endpoints above: lists a user's
  numbers on the left, shows the selected number's messages on the right,
  and polls for new messages every 10 seconds. Linked from the main site
  nav ("My numbers") and from the post-checkout success page.
- The success page (`success.html`) double-checks payment status with
  `GET /api/checkout/session/:id` rather than assuming success just because
  the browser landed there.
- Listing all numbers on the Twilio account (`GET /api/numbers/owned`)
- Releasing a number (`DELETE /api/numbers/:sid`)
- `POST /api/numbers/purchase` still exists as a direct Twilio purchase
  with no payment gate — keep this admin-only (behind your own auth), it's
  meant for internal use, not the public checkout flow.

**Still placeholder / up to you:**
- **Identity verification (KYC).** Some countries require ID checks before
  Twilio will even release certain number ranges to your account, and you'll
  want your own KYC gate before letting a user reserve a number, to match the
  "trust & limits" section on the site.
- **Inbox / message history.** The SMS webhook currently just logs incoming
  messages to the console. You'll want a database table keyed by phone
  number, and a way for the owning user to see their messages in the UI.
- **Standing VoIP call handling.** Buying a number gives you SMS by default;
  routing inbound *voice* calls (e.g. to the user's own phone, or to an app)
  needs a Voice webhook and TwiML — Twilio's docs cover this under
  "Programmable Voice."

## 4. Country coverage

Twilio doesn't sell numbers everywhere, and coverage/pricing changes over
time — check `https://www.twilio.com/en-us/guidelines/global-number-availability`
before promising a country on the site. Some countries also require the buyer
to be a local business entity (regulatory bundles), which is a manual process
in the Twilio Console, not something the API can fully automate.

## 5. A note on partial configuration

The server is written to boot even if Twilio, Stripe, or SMTP aren't
configured yet — those routes just return a `503` instead of crashing the
whole process (Twilio and Stripe's SDKs both throw at *construction time*
if their keys are missing/malformed, which would otherwise take auth and
everything else down with them). On startup you'll see a config summary
in the console telling you exactly what's missing:

```
--- Config check ---
Twilio:        NOT CONFIGURED (numbers/* routes will 503)
Stripe:        OK
JWT_SECRET:    OK
SITE_URL:      http://localhost:5500
SMTP:          NOT CONFIGURED (verification/reset emails will fail silently, logged as errors)
--------------------
```

Useful if you want to test the accounts flow before wiring up Twilio, or
vice versa.
