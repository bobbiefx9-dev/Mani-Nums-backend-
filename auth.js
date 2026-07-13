const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { sendMail, verificationEmail, resetEmail } = require('./mailer');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '30d';

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// Generates a random token, stores only its hash (so a leaked database
// doesn't hand out valid reset/verify links), returns the raw token to
// put in the email link.
function createToken(userId, purpose, ttlMs) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, hash, purpose, expiresAt);
  return raw;
}

function consumeToken(raw, purpose) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const row = db.prepare(`
    SELECT * FROM auth_tokens
    WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(hash, purpose);
  if (!row) return null;
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

// ---------------------------------------------------------------------------
// POST /api/auth/signup
// Body: { email, password }
// Sends a verification email; the account works for login immediately,
// but see requireVerified below for gating specific actions on it.
// ---------------------------------------------------------------------------
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'an account with that email already exists' });

  const passwordHash = await bcrypt.hash(password, 12);
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email.toLowerCase(), passwordHash);
  const user = { id: info.lastInsertRowid, email: email.toLowerCase() };

  try {
    const rawToken = createToken(user.id, 'verify_email', 24 * 60 * 60 * 1000);
    const link = `${process.env.SITE_URL}/verify-email.html?token=${rawToken}`;
    await sendMail({ to: user.email, subject: 'Confirm your Mani Nums account', html: verificationEmail(link) });
  } catch (err) {
    // Don't fail signup just because email sending had a hiccup — log it
    // and let the user request another verification email later.
    console.error('Failed to send verification email:', err.message);
  }

  res.status(201).json({ token: signToken(user), user: { ...user, emailVerified: false } });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// Body: { email, password }
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // Same error for "no such user" and "wrong password" — don't reveal
  // which one it was, that just helps someone enumerate valid emails.
  if (!row) return res.status(401).json({ error: 'invalid email or password' });

  const match = await bcrypt.compare(password, row.password_hash);
  if (!match) return res.status(401).json({ error: 'invalid email or password' });

  const user = { id: row.id, email: row.email };
  res.json({ token: signToken(user), user: { ...user, emailVerified: !!row.email_verified } });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — returns the current user based on the bearer token
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(req.user.sub);
  if (!row) return res.status(404).json({ error: 'user not found' });
  res.json({ user: { id: row.id, email: row.email, emailVerified: !!row.email_verified } });
});

// ---------------------------------------------------------------------------
// GET /api/auth/verify-email?token=...
// Called by the link in the verification email.
// ---------------------------------------------------------------------------
router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const row = consumeToken(token, 'verify_email');
  if (!row) return res.status(400).json({ error: 'that link is invalid or has expired' });

  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
  res.json({ verified: true });
});

// ---------------------------------------------------------------------------
// POST /api/auth/resend-verification
// Requires login (so we know which account to send it for).
// ---------------------------------------------------------------------------
router.post('/resend-verification', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!row) return res.status(404).json({ error: 'user not found' });
  if (row.email_verified) return res.json({ message: 'already verified' });

  try {
    const rawToken = createToken(row.id, 'verify_email', 24 * 60 * 60 * 1000);
    const link = `${process.env.SITE_URL}/verify-email.html?token=${rawToken}`;
    await sendMail({ to: row.email, subject: 'Confirm your Mani Nums account', html: verificationEmail(link) });
  } catch (err) {
    console.error('Failed to resend verification email:', err.message);
    return res.status(502).json({ error: 'could not send email right now, try again shortly' });
  }
  res.json({ message: 'verification email sent' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/request-password-reset
// Body: { email }
// Always responds the same way whether or not the email exists — telling
// the caller "no account with that email" would let someone enumerate
// which addresses have accounts.
// ---------------------------------------------------------------------------
router.post('/request-password-reset', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (row) {
    try {
      const rawToken = createToken(row.id, 'reset_password', 60 * 60 * 1000);
      const link = `${process.env.SITE_URL}/reset-password.html?token=${rawToken}`;
      await sendMail({ to: row.email, subject: 'Reset your Mani Nums password', html: resetEmail(link) });
    } catch (err) {
      console.error('Failed to send reset email:', err.message);
    }
  }

  res.json({ message: 'if an account exists for that email, a reset link has been sent' });
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password
// Body: { token, password }
// ---------------------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  const row = consumeToken(token, 'reset_password');
  if (!row) return res.status(400).json({ error: 'that link is invalid or has expired' });

  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
  res.json({ message: 'password updated, you can log in now' });
});

// ---------------------------------------------------------------------------
// Middleware: requires "Authorization: Bearer <token>", attaches req.user
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { sub, email, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// Middleware: like requireAuth, but also requires a verified email.
// Use this on actions you want gated on proven email ownership (e.g.
// starting checkout), separate from full identity/KYC checks.
// ---------------------------------------------------------------------------
function requireVerified(req, res, next) {
  requireAuth(req, res, () => {
    const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.sub);
    if (!row || !row.email_verified) {
      return res.status(403).json({ error: 'please verify your email first' });
    }
    next();
  });
}

module.exports = { router, requireAuth, requireVerified };
