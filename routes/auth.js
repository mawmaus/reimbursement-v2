'use strict';

// Sign-in / sign-out with throttling, the session payload (/api/me), profile
// and password changes, and password reset.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q } = require('../db');
const { sendEmail, layout, button } = require('../lib/email');
const { ah, normLang, normEmail, EMAIL_RE, sha256, baseUrl, escHtml } = require('../lib/util');
const {
  loadPositions, attachCaps, creatablePositions, hasDelegation,
  insightsCanView, accountsSeeAllDepts
} = require('../lib/permissions');
const { regionPrefsFor } = require('../lib/settings');
const { computePurposes, unrealizedAdvanceCount, approver1Choices } = require('../lib/workflow');
const { loadUser, requireAuth, SET_PASSWORD_SQL, startSession } = require('../lib/auth');
const { surveyPending } = require('../lib/survey');

const router = express.Router();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const MAX_LOGIN_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginKey = (req) => req.ip || 'unknown';

// Failed-login throttling is kept in the database (table `login_attempts`) so a
// single client's failures are counted across all serverless instances — an
// in-memory Map would give each instance its own counter and reset on recycle.
// `first_at` marks the start of the 15-minute window.

// Minutes remaining before this client may try again, or 0 if not blocked.
async function loginBlockedFor(req) {
  const rows = await q('SELECT fails, first_at FROM login_attempts WHERE attempt_key = $1', [loginKey(req)]);
  const rec = rows[0];
  if (!rec) return 0;
  const age = Date.now() - new Date(rec.first_at).getTime();
  if (age >= LOGIN_WINDOW_MS) {
    await q('DELETE FROM login_attempts WHERE attempt_key = $1', [loginKey(req)]);
    return 0;
  }
  if (rec.fails >= MAX_LOGIN_FAILS) return Math.ceil((LOGIN_WINDOW_MS - age) / 60000);
  return 0;
}
// Record one failure: start a fresh window if none is open (or the last has
// expired), otherwise increment the running count. Done in a single atomic
// upsert so concurrent attempts can't clobber the counter.
async function recordLoginFail(req) {
  await q(
    `INSERT INTO login_attempts (attempt_key, fails, first_at)
     VALUES ($1, 1, now())
     ON CONFLICT (attempt_key) DO UPDATE SET
       fails    = CASE WHEN now() - login_attempts.first_at >= $2::interval THEN 1     ELSE login_attempts.fails + 1 END,
       first_at = CASE WHEN now() - login_attempts.first_at >= $2::interval THEN now() ELSE login_attempts.first_at    END`,
    [loginKey(req), `${LOGIN_WINDOW_MS} milliseconds`]);
}
// Clear a client's failures after a successful login.
async function clearLoginFails(req) {
  await q('DELETE FROM login_attempts WHERE attempt_key = $1', [loginKey(req)]);
}

router.post('/api/login', ah(async (req, res) => {
  const blocked = await loginBlockedFor(req);
  if (blocked > 0) return res.status(429).json({ error: `Too many failed attempts. Try again in ${blocked} min.` });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const rows = await q('SELECT * FROM users WHERE username = $1', [String(username).trim()]);
  const user = rows[0];
  if (!user || !user.active || !bcrypt.compareSync(String(password), user.password_hash)) {
    await recordLoginFail(req);
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  await clearLoginFails(req);
  startSession(req, user);
  res.json({ user: {
    id: user.id, username: user.username, full_name: user.full_name, role: user.role, email: user.email,
    department: user.department, position: user.position, can_mark_paid: !!user.can_mark_paid,
    allow_advance: !!user.allow_advance, region: user.region || '',
    ...(await sessionExtras(user))
  } });
}));

router.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

// The per-session extras the client needs alongside the account (region
// defaults, what it may submit, what it may manage, its caps). Shared by sign-in,
// /api/me and the profile saves; the lookups are independent so they run
// together. Attaches u.caps as a side effect.
async function sessionExtras(u) {
  const [pos, prefs, purposes, unrealized, approver1, survey] = await Promise.all([
    loadPositions(u.region), regionPrefsFor(u.region), computePurposes(u),
    unrealizedAdvanceCount(u.id), approver1Choices(u.approver1_options),
    surveyPending(u.id), attachCaps(u)
  ]);
  return {
    language: normLang(u.language), ...prefs, purposes, creatable_positions: creatablePositions(u, pos),
    my_unrealized_advances: unrealized, approver1_choices: approver1,
    can_manage_accounts: hasDelegation(u, pos), can_view_insights: insightsCanView(u, pos),
    sees_all_departments: accountsSeeAllDepts(u, pos), caps: u.caps, survey_pending: survey
  };
}

router.get('/api/me', ah(async (req, res) => {
  const u = await loadUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: { ...u, ...(await sessionExtras(u)) } });
}));

// Self-service profile: a user may edit their own bank / payout details (but
// not role, department, approvers, etc.).
router.put('/api/me', requireAuth, ah(async (req, res) => {
  const body = req.body || {};
  // Language-only updates (from the language switcher) skip the bank/email fields
  // so switching language never touches or requires the rest of the profile.
  if (Object.prototype.hasOwnProperty.call(body, 'language') && Object.keys(body).length === 1) {
    await q('UPDATE users SET language = $1 WHERE id = $2', [normLang(body.language), req.user.id]);
    const u = await loadUser(req);
    return res.json({ user: { ...u, ...(await sessionExtras(u)) } });
  }
  const { bank_name, recipient_name, bank_account_no, email } = body;
  const nextEmail = normEmail(email);
  if (nextEmail && !EMAIL_RE.test(nextEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (nextEmail) {
    const dupe = await q('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [nextEmail, req.user.id]);
    if (dupe[0]) return res.status(409).json({ error: 'That email is already used by another account' });
  }
  // A language may ride along with a full profile save too.
  const nextLang = Object.prototype.hasOwnProperty.call(body, 'language') ? normLang(body.language) : normLang(req.user.language);
  await q('UPDATE users SET bank_name = $1, recipient_name = $2, bank_account_no = $3, email = $4, language = $5 WHERE id = $6', [
    String(bank_name || '').trim(), String(recipient_name || '').trim(),
    String(bank_account_no || '').trim(), nextEmail, nextLang, req.user.id]);
  const u = await loadUser(req);
  res.json({ user: { ...u, ...(await sessionExtras(u)) } });
}));

router.post('/api/me/password', requireAuth, ah(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const rows = await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!bcrypt.compareSync(String(current_password || ''), rows[0].password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  // Signs out the account's other sessions; this one stays signed in.
  const [{ session_version }] = await q(SET_PASSWORD_SQL, [bcrypt.hashSync(String(new_password), 10), req.user.id]);
  startSession(req, { id: req.user.id, session_version });
  res.json({ ok: true });
}));

// --- Forgot / reset password ------------------------------------------------
// A user requests a reset by email or username; we email a one-time link that
// carries a random token (only its SHA-256 hash is stored). The link lands on
// /reset.html which posts the token + a new password back to /api/reset-password.
const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_MAX_PER_HOUR = 5;

router.post('/api/forgot-password', ah(async (req, res) => {
  const blocked = await loginBlockedFor(req);
  if (blocked > 0) return res.status(429).json({ error: `Too many attempts. Try again in ${blocked} min.` });
  const identifier = String((req.body && req.body.identifier) || '').trim();
  // Respond identically whether or not the account exists, so this can't be
  // used to enumerate registered emails / usernames.
  const generic = { ok: true, message: 'If that account exists, we’ve emailed a password reset link.' };
  if (!identifier) return res.json(generic);
  const rows = await q(
    `SELECT id, full_name, email, active FROM users
     WHERE lower(email) = lower($1) OR lower(username) = lower($1) LIMIT 1`, [identifier]);
  const user = rows[0];
  if (!user || !user.active || !user.email) { await recordLoginFail(req); return res.json(generic); }

  // Per-account cap, so nobody can flood a colleague's inbox (or keep killing
  // their link) by asking over and over: one email a minute, five an hour. Over
  // the cap the answer is the same generic one and nothing is sent.
  const [recent] = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(MAX(created_at) > now() - interval '1 minute', false) AS just_sent
       FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user.id]);
  if (recent && (recent.just_sent || recent.n >= RESET_MAX_PER_HOUR)) return res.json(generic);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MS);
  // Older links stop working, but their rows stay a day so the cap above can
  // count them.
  await q('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
  await q(`DELETE FROM password_resets WHERE user_id = $1 AND created_at < now() - interval '1 day'`, [user.id]);
  await q('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [user.id, sha256(token), expires.toISOString()]);

  const link = `${baseUrl(req)}/reset.html?token=${token}`;
  const inner = `
    <p style="margin:0 0 8px">Hi ${escHtml(user.full_name)},</p>
    <p style="margin:0 0 8px">We received a request to reset your Reimbursement Portal password.</p>
    <p style="margin:0 0 8px">This link is valid for 1 hour and can be used once. If you didn’t request it, you can safely ignore this email.</p>
    ${button(link, 'Reset your password')}
    <p style="margin:12px 0 0;color:#6b7280;font-size:12px;word-break:break-all">Or paste this link into your browser:<br>${escHtml(link)}</p>`;
  await sendEmail({
    to: user.email,
    subject: 'Reset your Reimbursement Portal password',
    html: layout('Password reset', inner),
    text: `Hi ${user.full_name}, reset your Reimbursement Portal password using this link (valid 1 hour, single use): ${link}`
  });
  res.json(generic);
}));

router.post('/api/reset-password', ah(async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing or invalid reset link.' });
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  // Spend the link and learn whose it is in one statement, so two submissions
  // racing on the same link can't both get through.
  const rows = await q(
    `UPDATE password_resets SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`, [sha256(String(token))]);
  const rec = rows[0];
  if (!rec) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  // Signs out every existing session of the account.
  await q(SET_PASSWORD_SQL, [bcrypt.hashSync(String(new_password), 10), rec.user_id]);
  res.json({ ok: true });
}));

module.exports = router;
