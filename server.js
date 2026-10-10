require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
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

// ---------------------------------------------------------------------------
// Paystack (payments). Replaces Stripe, which doesn't support Nigerian
// businesses. Uses Paystack's REST API directly, so there is no SDK to
// construct and nothing to crash at boot when the key is missing.
//
// PAYSTACK_CURRENCY: "USD" (default; USD must be enabled on your Paystack
// account) or "NGN". With NGN, prices (set in dollars by the frontend) are
// converted using USD_NGN_RATE, e.g. 1500.
// ---------------------------------------------------------------------------
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_CURRENCY = (process.env.PAYSTACK_CURRENCY || 'USD').toUpperCase();

function requirePaystack(req, res, next) {
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Payments are not configured on this server yet' });
  next();
}

async function paystack(method, path, body) {
  const resp = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.status === false) throw new Error(data.message || `Paystack HTTP ${resp.status}`);
  return data.data;
}

// ---------------------------------------------------------------------------
// Catalog: what each country's numbers cost, in USD. This is the source of
// truth for pricing — the website's displayed prices should match it. To add
// a country or change a price, edit this list and push.
// type: "sms" = per-code verification number, "voip" = standing line (monthly)
// ---------------------------------------------------------------------------
const CATALOG = [
  { code: '+44',  country: 'United Kingdom', type: 'sms',  price: 2.40 },
  { code: '+81',  country: 'Japan',          type: 'sms',  price: 3.10 },
  { code: '+49',  country: 'Germany',        type: 'voip', price: 8.00 },
  { code: '+55',  country: 'Brazil',         type: 'sms',  price: 1.90 },
  { code: '+971', country: 'UAE',            type: 'voip', price: 11.50 },
  { code: '+33',  country: 'France',         type: 'sms',  price: 2.20 },
  { code: '+82',  country: 'South Korea',    type: 'sms',  price: 2.90 },
  { code: '+1',   country: 'Canada',         type: 'voip', price: 6.50 },
  { code: '+65',  country: 'Singapore',      type: 'voip', price: 9.00 },
];
function lookupCatalog(phoneNumber) {
  // Longest dial-code prefix wins (e.g. +971 before +9...).
  return CATALOG
    .filter(c => phoneNumber.startsWith(c.code))
    .sort((a, b) => b.code.length - a.code.length)[0] || null;
}

// Admin-only routes (direct purchase, release, account inventory) spend or
// destroy real Twilio resources, so they require a secret key header.
// If ADMIN_KEY isn't set on the server, these routes stay disabled.
function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(503).json({ error: 'Admin routes are disabled (ADMIN_KEY not set)' });
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const expected = Buffer.from(key);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Public base URL of this backend, used to point purchased numbers' SMS
// webhook at us and to validate Twilio's request signatures.
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://mani-nums-backend.onrender.com';

function validateTwilio(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return res.status(503).end();
  const signature = req.headers['x-twilio-signature'];
  if (!signature || !twilio.validateRequest(token, signature, PUBLIC_URL + req.originalUrl, req.body || {})) {
    return res.status(403).end();
  }
  next();
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/paystack
// Paystack calls this when a payment succeeds. It needs the raw request body
// to verify the signature, so it's registered with express.raw() BEFORE the
// general express.json() middleware below applies to everything else.
// Payment is confirmed here, and ONLY here, is the number bought from Twilio.
// ---------------------------------------------------------------------------
const inFlight = new Set();

app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!PAYSTACK_SECRET) return res.status(503).end();

  const expected = Buffer.from(crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex'));
  const given = Buffer.from(String(req.headers['x-paystack-signature'] || ''));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    console.error('Paystack webhook signature check failed');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Bad payload');
  }

  if (event.event !== 'charge.success') return res.json({ received: true });

  const charge = event.data || {};
  const reference = charge.reference;
  const { phoneNumber, country, type, userId } = charge.metadata || {};

  if (!reference || !phoneNumber) {
    console.error('Payment succeeded but reference/phoneNumber missing from metadata', reference);
    return res.json({ received: true });
  }

  // Paystack retries webhooks, so don't buy a second number for the same payment.
  // (The stripe_session_id column now stores the Paystack payment reference.)
  const already = db.prepare('SELECT 1 FROM numbers WHERE stripe_session_id = ?').get(reference);
  if (already || inFlight.has(reference)) return res.json({ received: true });
  inFlight.add(reference);

  try {
    let purchased;
    try {
      if (!client) throw new Error('Twilio is not configured on this server');
      // Payment is confirmed — NOW actually buy the number from Twilio,
      // and point its incoming-SMS webhook at this server.
      purchased = await client.incomingPhoneNumbers.create({
        phoneNumber,
        smsUrl: `${PUBLIC_URL}/api/webhooks/sms`,
        smsMethod: 'POST',
      });
      console.log(`Purchased ${purchased.phoneNumber} (sid ${purchased.sid}) after payment ${reference}`);
    } catch (err) {
      console.error('Payment succeeded but Twilio purchase failed:', err.message);
      // The user paid but we couldn't deliver the number, so refund automatically.
      try {
        await paystack('POST', '/refund', { transaction: reference });
        console.log(`Refund requested for payment ${reference}`);
      } catch (refundErr) {
        console.error(`REFUND FAILED for payment ${reference} — refund manually in the Paystack dashboard:`, refundErr.message);
      }
      return res.json({ received: true });
    }

    try {
      db.prepare(`
        INSERT INTO numbers (user_id, phone_number, twilio_sid, country, type, stripe_session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(Number(userId), purchased.phoneNumber, purchased.sid, country || null, type || null, reference);
    } catch (err) {
      // The number is bought and paid for; don't refund. Log everything needed to fix it by hand.
      console.error(`DB insert failed for ${purchased.phoneNumber} (twilio sid ${purchased.sid}, user ${userId}, payment ${reference}):`, err.message);
    }
    res.json({ received: true });
  } finally {
    inFlight.delete(reference);
  }
});

// Everything else can use normal JSON body parsing.
app.use(express.json());
// Twilio posts incoming-SMS webhooks as form-encoded, not JSON.
app.use(express.urlencoded({ extended: false }));

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
// Body: { phoneNumber } (price/country/type are looked up server-side)
// Starts a Paystack payment. The number is NOT purchased yet — that only
// happens once Paystack confirms payment, in the webhook above.
// The frontend should redirect the browser to the returned `url`.
// ---------------------------------------------------------------------------
app.post('/api/checkout/create-session', requireVerified, requirePaystack, async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber || !/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'phoneNumber is required in international format, e.g. +442071838750' });
  }
  // The server decides the price and type from the number's country code.
  // Anything the browser sends for price/country/type is ignored.
  const item = lookupCatalog(phoneNumber);
  if (!item) return res.status(400).json({ error: 'numbers from that country are not for sale' });
  const dollars = item.price;
  const country = item.country;
  const type = item.type;

  let amount; // in the currency's smallest unit (cents / kobo)
  if (PAYSTACK_CURRENCY === 'NGN') {
    const rate = Number(process.env.USD_NGN_RATE);
    if (!rate) return res.status(503).json({ error: 'USD_NGN_RATE is not set on this server' });
    amount = Math.round(dollars * rate * 100);
  } else {
    amount = Math.round(dollars * 100);
  }

  try {
    const reference = `mn_${crypto.randomUUID()}`;
    const data = await paystack('POST', '/transaction/initialize', {
      email: req.user.email,
      amount,
      currency: PAYSTACK_CURRENCY,
      reference,
      // Paystack appends ?trxref=...&reference=... to this URL.
      callback_url: `${process.env.SITE_URL}/success.html?session_id=${reference}`,
      metadata: {
        phoneNumber,
        country: country || '',
        type: type || '',
        userId: String(req.user.sub),
        cancel_action: `${process.env.SITE_URL}/farline-website.html`,
      },
    });
    res.json({ url: data.authorization_url, id: reference });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'Payment could not be started', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/checkout/session/:id
// Lets the success page confirm what actually happened, rather than
// assuming success just because the browser landed on the callback URL.
// ---------------------------------------------------------------------------
app.get('/api/checkout/session/:id', requirePaystack, async (req, res) => {
  try {
    const tx = await paystack('GET', `/transaction/verify/${encodeURIComponent(req.params.id)}`);
    res.json({
      paymentStatus: tx.status === 'success' ? 'paid' : 'unpaid', // "paid" | "unpaid"
      phoneNumber: tx.metadata?.phoneNumber,
      country: tx.metadata?.country,
    });
  } catch (err) {
    res.status(404).json({ error: 'Payment not found' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/numbers/purchase
// Body: { phoneNumber: "+442071838750" }
// Buys a number directly, bypassing payment. Admin-only (x-admin-key header)
// — the public flow goes through /api/checkout/create-session so the user
// pays before Twilio bills you.
// ---------------------------------------------------------------------------
app.post('/api/numbers/purchase', requireAdmin, requireTwilio, async (req, res) => {
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
// Admin-only.
// ---------------------------------------------------------------------------
app.get('/api/numbers/owned', requireAdmin, requireTwilio, async (req, res) => {
  try {
    const owned = await client.incomingPhoneNumbers.list({ limit: 50 });
    res.json(owned.map(n => ({ sid: n.sid, phoneNumber: n.phoneNumber, friendlyName: n.friendlyName })));
  } catch (err) {
    res.status(502).json({ error: 'Twilio list failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/numbers/:sid
// Releases (cancels) a purchased number — stops billing for it. Admin-only.
// ---------------------------------------------------------------------------
app.delete('/api/numbers/:sid', requireAdmin, requireTwilio, async (req, res) => {
  try {
    await client.incomingPhoneNumbers(req.params.sid).remove();
    res.json({ status: 'released', sid: req.params.sid });
  } catch (err) {
    res.status(502).json({ error: 'Twilio release failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/webhooks/sms
// Purchased numbers are pointed at this URL automatically, so incoming
// SMS/verification codes land in the database and show up in the user's inbox.
// Requests are verified against Twilio's signature.
// ---------------------------------------------------------------------------
app.post('/api/webhooks/sms', validateTwilio, (req, res) => {
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
  console.log(`Paystack:      ${PAYSTACK_SECRET ? `OK (${PAYSTACK_CURRENCY})` : 'NOT CONFIGURED (checkout/* routes will 503)'}`);
  console.log(`JWT_SECRET:    ${process.env.JWT_SECRET ? 'OK' : 'MISSING (auth will fail on first request)'}`);
  console.log(`SITE_URL:      ${process.env.SITE_URL || 'NOT SET (email links and payment redirects will be broken)'}`);
  console.log(`ADMIN_KEY:     ${process.env.ADMIN_KEY ? 'OK' : 'NOT SET (admin routes disabled)'}`);
  console.log(`SMTP:          ${process.env.SMTP_HOST ? 'configured (not verified — check the inbox after signing up)' : 'NOT CONFIGURED (verification/reset emails will fail silently, logged as errors)'}`);
  console.log('--------------------');

  // The Twilio SDK only checks the SID's format at startup, not whether the
  // credentials work, so verify the login for real and say so in the logs.
  if (client) {
    client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch()
      .then(a => console.log(`Twilio login: VERIFIED (${a.status} account)`))
      .catch(err => console.error(`Twilio login: FAILED — ${err.message}. Re-copy TWILIO_AUTH_TOKEN from the Twilio console.`));
  }
});
