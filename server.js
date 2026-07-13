require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const Stripe = require('stripe');
const db = require('./db');
const { router: authRouter, requireAuth, requireVerified } = require('./auth');

const app = express();
app.use(cors({ origin: (process.env.ALLOWED_ORIGIN || '*').split(',') }));

// Twilio's SDK validates the Account SID format at construction time and
// throws synchronously if it's missing/malformed. Guard it so the rest of
// the server (auth, etc.) still boots even before Twilio is configured —
// only the Twilio-dependent routes below will fail until it's set up.
let client = null;
try {
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch (err) {
  console.warn('Twilio client not initialized (check TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in .env):', err.message);
}
function requireTwilio(req, res, next) {
  if (!client) return res.status(503).json({ error: 'Twilio is not configured on this server yet' });
  next();
}

// Stripe's SDK also throws at construction time if no key is provided at
// all (not just an invalid one) — same guard pattern as Twilio above.
let stripe = null;
try {
  stripe = Stripe(process.env.STRIPE_SECRET_KEY);
} catch (err) {
  console.warn('Stripe client not initialized (check STRIPE_SECRET_KEY in .env):', err.message);
}
function requireStripe(req, res, next) {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured on this server yet' });
  next();
}

// The Stripe webhook route needs the raw request body to verify the
// signature, so it must be registered with express.raw() BEFORE the
// general express.json() middleware below applies to everything else.
app.post('/api/webhooks/stripe', requireStripe, express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { phoneNumber, country, type, userId } = session.metadata || {};

    if (!phoneNumber) {
      console.error('Checkout completed but no phoneNumber in metadata', session.id);
      return res.json({ received: true });
    }

    try {
      if (!client) throw new Error('Twilio is not configured on this server');
      // Payment is confirmed — NOW actually buy the number from Twilio.
      const purchased = await client.incomingPhoneNumbers.create({ phoneNumber });
      console.log(`Purchased ${purchased.phoneNumber} (sid ${purchased.sid}) after payment ${session.id}`);

      db.prepare(`
        INSERT INTO numbers (user_id, phone_number, twilio_sid, country, type, stripe_session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(Number(userId), purchased.phoneNumber, purchased.sid, country || null, type || null, session.id);
    } catch (err) {
      console.error('Payment succeeded but Twilio purchase failed:', err.message);
      // TODO: this is the one case that needs a human or an automated
      // refund — the user paid but you couldn't deliver the number.
      // Consider calling stripe.refunds.create({ payment_intent: session.payment_intent }).
    }
  }

  res.json({ received: true });
});

// Everything else can use normal JSON body parsing.
app.use(express.json());

app.use('/api/auth', authRouter);

// ---------------------------------------------------------------------------
// GET /api/numbers/search?country=GB&type=local&limit=10
// Searches Twilio's available number inventory for a country.
// type: "local" | "mobile" | "tollFree"
// ---------------------------------------------------------------------------
app.get('/api/numbers/search', requireTwilio, async (req, res) => {
  const { country, type = 'local', limit = 10 } = req.query;
  if (!country) return res.status(400).json({ error: 'country is required, e.g. GB, JP, DE' });

  try {
    const list = await client.availablePhoneNumbers(country)[type].list({ limit: Number(limit) });
    const results = list.map(n => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality,
      region: n.region,
      capabilities: n.capabilities, // { voice, sms, mms }
    }));
    res.json({ country, type, results });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Twilio search failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/checkout/create-session
// Body: { phoneNumber, country, type, price } (price in whole dollars)
// Creates a Stripe Checkout session. The number is NOT purchased yet —
// that only happens once Stripe confirms payment, in the webhook below.
// The frontend should redirect the browser to the returned `url`.
// ---------------------------------------------------------------------------
app.post('/api/checkout/create-session', requireVerified, requireStripe, async (req, res) => {
  const { phoneNumber, country, type, price } = req.body;
  if (!phoneNumber || !price) {
    return res.status(400).json({ error: 'phoneNumber and price are required' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${country || ''} number — ${phoneNumber}`.trim(),
            description: type === 'voip' ? 'Standing VoIP line, billed monthly' : 'SMS verification number',
          },
          unit_amount: Math.round(Number(price) * 100), // Stripe wants cents
        },
        quantity: 1,
      }],
      metadata: { phoneNumber, country: country || '', type: type || '', userId: String(req.user.sub) },
      success_url: `${process.env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/farline-website.html`,
    });
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Stripe session creation failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/checkout/session/:id
// Lets the success page confirm what actually happened, rather than
// assuming success just because the browser landed on success_url.
// ---------------------------------------------------------------------------
app.get('/api/checkout/session/:id', requireStripe, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({
      paymentStatus: session.payment_status, // "paid" | "unpaid" | "no_payment_required"
      phoneNumber: session.metadata?.phoneNumber,
      country: session.metadata?.country,
    });
  } catch (err) {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/numbers/purchase
// Body: { phoneNumber: "+442071838750" }
// Buys a number directly, bypassing payment. Keep this admin-only (behind
// your own auth) — the public flow should go through
// /api/checkout/create-session so the user pays before Twilio bills you.
// ---------------------------------------------------------------------------
app.post('/api/numbers/purchase', requireTwilio, async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });

  try {
    const purchased = await client.incomingPhoneNumbers.create({ phoneNumber });
    res.json({
      sid: purchased.sid,
      phoneNumber: purchased.phoneNumber,
      status: 'purchased',
    });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Twilio purchase failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/numbers/mine — numbers the logged-in user has actually paid for
// (from our own database), as opposed to /api/numbers/owned which lists
// everything on the whole Twilio account.
// ---------------------------------------------------------------------------
app.get('/api/numbers/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT phone_number, country, type, status, created_at FROM numbers WHERE user_id = ? ORDER BY created_at DESC').all(req.user.sub);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// GET /api/numbers/mine/:phoneNumber/messages — inbox for one of the
// user's numbers. Confirms ownership before returning anything.
// ---------------------------------------------------------------------------
app.get('/api/numbers/mine/:phoneNumber/messages', requireAuth, (req, res) => {
  const owns = db.prepare('SELECT 1 FROM numbers WHERE user_id = ? AND phone_number = ?').get(req.user.sub, req.params.phoneNumber);
  if (!owns) return res.status(404).json({ error: 'number not found on this account' });

  const messages = db.prepare('SELECT from_number, body, received_at FROM messages WHERE phone_number = ? ORDER BY received_at DESC').all(req.params.phoneNumber);
  res.json(messages);
});

// ---------------------------------------------------------------------------
// GET /api/numbers/owned
// Lists numbers already purchased on this Twilio account (your "inventory").
// ---------------------------------------------------------------------------
app.get('/api/numbers/owned', requireTwilio, async (req, res) => {
  try {
    const owned = await client.incomingPhoneNumbers.list({ limit: 50 });
    res.json(owned.map(n => ({ sid: n.sid, phoneNumber: n.phoneNumber, friendlyName: n.friendlyName })));
  } catch (err) {
    res.status(502).json({ error: 'Twilio list failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/numbers/:sid
// Releases (cancels) a purchased number — stops billing for it.
// ---------------------------------------------------------------------------
app.delete('/api/numbers/:sid', requireTwilio, async (req, res) => {
  try {
    await client.incomingPhoneNumbers(req.params.sid).remove();
    res.json({ status: 'released', sid: req.params.sid });
  } catch (err) {
    res.status(502).json({ error: 'Twilio release failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/sms
// Point a purchased number's "A message comes in" webhook (in the Twilio
// console, or set programmatically) at this URL to receive incoming SMS/
// verification codes server-side, then push them to your app's inbox UI.
// ---------------------------------------------------------------------------
app.post('/api/webhooks/sms', (req, res) => {
  const { From, To, Body } = req.body;
  console.log(`SMS to ${To} from ${From}: ${Body}`);
  db.prepare('INSERT INTO messages (phone_number, from_number, body) VALUES (?, ?, ?)').run(To, From, Body);
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>'); // empty TwiML = don't reply
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Mani Nums backend running on http://localhost:${port}`);
  console.log('--- Config check ---');
  console.log(`Twilio:        ${client ? 'OK' : 'NOT CONFIGURED (numbers/* routes will 503)'}`);
  console.log(`Stripe:        ${stripe ? 'OK' : 'NOT CONFIGURED (checkout/* routes will 503)'}`);
  console.log(`JWT_SECRET:    ${process.env.JWT_SECRET ? 'OK' : 'MISSING (auth will fail on first request)'}`);
  console.log(`SITE_URL:      ${process.env.SITE_URL || 'NOT SET (email links and Stripe redirects will be broken)'}`);
  console.log(`SMTP:          ${process.env.SMTP_HOST ? 'configured (not verified — check the inbox after signing up)' : 'NOT CONFIGURED (verification/reset emails will fail silently, logged as errors)'}`);
  console.log('--------------------');
});
