'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { q, qq, transaction } = require('./db');
const { uploadReceipt, deleteReceipt } = require('./lib/blob');
const { sendEmail, emailConfigured, appUrl, layout, button } = require('./lib/email');
const { notifyPendingApprover, notifyClaimantRejected, notifyClaimantDecision, sendReminderDigest } = require('./lib/notify');

const app = express();

const BEHIND_PROXY = process.env.VERCEL === '1'
  || process.env.RENDER === 'true'
  || process.env.TRUST_PROXY === '1'
  || process.env.NODE_ENV === 'production';

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('SESSION_SECRET is not set — generated a temporary one. Set SESSION_SECRET in production so logins persist.');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.disable('x-powered-by');
if (BEHIND_PROXY) app.set('trust proxy', 1);

// Canonical host: 308-redirect the old auto-generated domain to the new one so
// clid-internalportal.vercel.app is the single primary address.
const CANONICAL_HOST = process.env.CANONICAL_HOST || 'clid-internalportal.vercel.app';
const OLD_HOSTS = new Set(['reimbursement-mawan.vercel.app']);
app.use((req, res, next) => {
  if (OLD_HOSTS.has(req.hostname)) {
    return res.redirect(308, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// Content-Security-Policy. The frontend is same-origin only: its own scripts
// (app.js, reset.js, vendor/pdf-lib) and styles, fetches to /api, and images
// served from this origin (plus data:/blob: for client-generated PDFs). Inline
// styles are still used in the markup, so style-src allows 'unsafe-inline';
// scripts do not, so script-src stays strict ('self' with no inline).
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'"
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieSession({
  name: 'rsess',
  keys: [SESSION_SECRET],
  maxAge: 8 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: BEHIND_PROXY
}));

// File uploads held in memory, then pushed to Vercel Blob.
// Vercel server uploads are capped at ~4.5 MB per request, so limit to 4 MB.
// Attachments are limited to PDFs and images so they can be embedded cleanly in
// the generated claim PDF.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) =>
    ALLOWED_MIME.has(file.mimetype) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.mimetype}`))
});

// async route wrapper
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const iso = (v) => (v instanceof Date ? v.toISOString() : v);

// Email address handling: stored lower-cased; a blank string means "no email".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (v) => String(v == null ? '' : v).trim().toLowerCase();
// Public base URL for links in emails: APP_URL if set, else derived from the
// incoming request (protocol + host behind Vercel's proxy).
function baseUrl(req) {
  const configured = appUrl();
  if (configured) return configured;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : '';
}

// Postgres int[] can come back as a JS array or a "{1,2}" literal depending on
// the driver — normalise either into a plain array of numbers.
function asIntArray(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  if (typeof v === 'string') return v.replace(/[{}]/g, '').split(',').map(s => Number(s.trim())).filter(Number.isFinite);
  return [];
}
// A Postgres int[] literal ("{1,2,3}") for binding as $n::int[].
const intArrayLiteral = (ids) => `{${ids.join(',')}}`;

async function loadUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  const rows = await q('SELECT id, username, full_name, email, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids, can_mark_paid, active FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}
const requireAuth = ah(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  req.user = u;
  next();
});
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
}

function parseAmountToCents(input) {
  if (typeof input === 'number') return Math.round(input * 100);
  const cleaned = String(input).replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}
async function nextClaimNo() {
  const year = new Date().getFullYear();
  const rows = await q('SELECT COUNT(*)::int AS n FROM claims WHERE claim_no LIKE $1', [`RC-${year}-%`]);
  return `RC-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}
async function logHistory(claimId, actor, action, fromStatus, toStatus, comment = '') {
  await q(
    `INSERT INTO claim_history (claim_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [claimId, actor.id, actor.full_name, action, fromStatus, toStatus, comment]
  );
}
function groupBy(rows, key) {
  const m = {};
  for (const r of rows) (m[r[key]] = m[r[key]] || []).push(r);
  return m;
}
function baseClaim(row, attachments, history, nameMap) {
  return {
    id: row.id,
    claim_no: row.claim_no,
    employee_id: row.employee_id,
    claimant_name: row.claimant_name,
    expense_date: row.expense_date,
    department: row.department,
    bank_name: row.bank_name,
    recipient_name: row.recipient_name,
    bank_account_no: row.bank_account_no,
    db_no: row.db_no || '',
    expense_type: row.expense_type,
    amount: Number(row.amount_cents) / 100,
    currency: row.currency,
    description: row.description,
    status: row.status,
    manager_comment: row.manager_comment,
    manager_id: row.manager_id == null ? null : Number(row.manager_id),
    paid_by: row.paid_by == null ? null : Number(row.paid_by),
    approvers: asIntArray(row.approver_ids).map(id => ({ id, name: (nameMap && nameMap[id]) || `User #${id}` })),
    current_step: row.current_step || 0,
    decided_at: iso(row.decided_at),
    paid_at: iso(row.paid_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    attachments: (attachments || []).map(a => ({
      id: a.id, original_name: a.original_name, mime_type: a.mime_type,
      size_bytes: a.size_bytes, uploaded_at: iso(a.uploaded_at)
    })),
    history: (history || []).map(h => ({
      actor_name: h.actor_name, action: h.action, from_status: h.from_status,
      to_status: h.to_status, comment: h.comment, created_at: iso(h.created_at)
    }))
  };
}
// Batch-load attachments + history for many claims in two queries.
async function serializeMany(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const atts = await q(
    `SELECT id, claim_id, original_name, mime_type, size_bytes, uploaded_at
     FROM attachments WHERE claim_id IN (${ph}) ORDER BY id`, ids);
  const hist = await q(
    `SELECT claim_id, actor_name, action, from_status, to_status, comment, created_at
     FROM claim_history WHERE claim_id IN (${ph}) ORDER BY id`, ids);
  const a = groupBy(atts, 'claim_id');
  const h = groupBy(hist, 'claim_id');

  // Batch-load the names for every distinct approver referenced across claims.
  const approverIds = [...new Set(rows.flatMap(r => asIntArray(r.approver_ids)))];
  const nameMap = {};
  if (approverIds.length) {
    const aph = approverIds.map((_, i) => `$${i + 1}`).join(',');
    const us = await q(`SELECT id, full_name FROM users WHERE id IN (${aph})`, approverIds);
    for (const u of us) nameMap[u.id] = u.full_name;
  }
  return rows.map(r => baseClaim(r, a[r.id], h[r.id], nameMap));
}
async function serializeOne(row) {
  return (await serializeMany([row]))[0];
}
async function loadClaimOr404(req, res) {
  const rows = await q('SELECT * FROM claims WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Claim not found' }); return null; }
  return rows[0];
}

// Build the notification payload for a claim row (the shape lib/notify expects).
function reimbNotify(row) {
  return { claimNo: row.claim_no, claimantName: row.claimant_name,
    typeLabel: 'reimbursement claim', amount: Number(row.amount_cents) / 100, currency: row.currency };
}
function mealNotify(row) {
  return { claimNo: row.claim_no, claimantName: row.claimant_name,
    typeLabel: 'meal allowance claim', amount: Number(row.total_cents) / 100, currency: row.currency };
}
// The approver whose turn it currently is (1-based current_step), or null.
function currentApproverId(row) {
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  return step >= 1 && step <= ids.length ? ids[step - 1] : null;
}

// Bank details, claimant name and department now come from the claimant's
// account, so they are not required on the claim form itself.
const REQUIRED_FIELDS = ['expense_date', 'expense_type'];

// --- Approval routing -------------------------------------------------------
// Each account has an ordered list of approvers. A claim advances through them
// one at a time: only the approver at the current step may act. Super admins can
// always override. A claim with no approvers can only be approved by a superadmin.
function userCanApprove(user, claim) {
  if (user.role === 'superadmin') return true;
  const ids = asIntArray(claim.approver_ids);
  if (!ids.length) return false;
  return ids[(claim.current_step || 1) - 1] === user.id;
}

// A calendar date (YYYY-MM-DD) — the payment date picked when marking a claim
// as paid.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Who may record a payment (mark paid / revert a payment): super admins always,
// plus any account a super admin has granted the can_mark_paid permission.
function canMarkPaid(user) {
  return user.role === 'superadmin' || user.can_mark_paid === true;
}

// --- Revert (undo one step) -------------------------------------------------
// Revert walks a claim back exactly one node of its lifecycle, and only the
// actor who owns that node may do it (super admins may always override):
//   paid                 -> approved     (the payer, i.e. a super admin)
//   approved             -> submitted    (the final approver — manager_id)
//   submitted @ step k>1 -> submitted @ k-1  (the approver of the previous step)
//   submitted @ step ≤1  -> rejected     (the claimant cancels to edit & resubmit)
// A rejected claim has nothing to revert (the claimant edits & resubmits it).
// Returns a plan { kind, action, from, to, comment } or a refusal { error, code }.
function planRevert(row, user) {
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  const isSuper = user.role === 'superadmin';
  if (row.status === 'paid') {
    if (!canMarkPaid(user)) return { error: 'You do not have permission to revert a payment', code: 403 };
    return { kind: 'unpay', action: 'reverted payment', from: 'paid', to: 'approved' };
  }
  if (row.status === 'approved') {
    if (!isSuper && Number(row.manager_id) !== user.id) {
      return { error: 'Only the approver who approved this claim can revert the approval', code: 403 };
    }
    return { kind: 'unapprove-final', action: 'reverted approval', from: 'approved', to: 'submitted' };
  }
  if (row.status === 'submitted') {
    if (step > 1) {
      if (!isSuper && ids[step - 2] !== user.id) {
        return { error: 'Only the approver of the previous step can revert it', code: 403 };
      }
      return { kind: 'unapprove-step', action: 'reverted approval', from: 'submitted', to: 'submitted' };
    }
    if (!isSuper && Number(row.employee_id) !== user.id) {
      return { error: 'Only the claimant can revert this submission', code: 403 };
    }
    return { kind: 'cancel', action: 'reverted — cancelled to edit', from: 'submitted', to: 'rejected',
      comment: 'Reverted by the claimant to make changes' };
  }
  return { error: `A ${row.status} claim cannot be reverted`, code: 409 };
}

// --- Stale-approver guards --------------------------------------------------
// Keep only the still-active approvers from a candidate list, preserving order.
// Used when a claim is submitted/resubmitted so a new claim never routes to a
// deactivated account (which could never log in to act on it). If every
// candidate is inactive the claim ends up with no approvers — a superadmin can
// still finalise it, which is the right fallback.
async function activeApproverIds(candidateIds) {
  const ids = asIntArray(candidateIds);
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rows = await q(`SELECT id FROM users WHERE id IN (${ph}) AND active = TRUE`, ids);
  const ok = new Set(rows.map(r => Number(r.id)));
  return ids.filter(id => ok.has(id));
}

// How many still-open (submitted) claims — reimbursement + meal — have this user
// as the approver whose turn it currently is. Postgres arrays are 1-based, and
// current_step is 1-based, so approver_ids[current_step] is the pending approver.
async function openClaimsAwaitingApprover(userId) {
  const [reimb, meal] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM claims
       WHERE status = 'submitted' AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId]),
    q(`SELECT COUNT(*)::int AS n FROM meal_claims
       WHERE status = 'submitted' AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId])
  ]);
  return Number(reimb[0].n) + Number(meal[0].n);
}

// --- Front-page purposes ----------------------------------------------------
// Which "purpose" buttons (New Claim / New Meal Allowance) a user may see. A
// purpose is visible only when it is enabled on BOTH the user's department and
// their job position (AND). Unknown/blank department or position => nothing.
async function computePurposes(user) {
  const empty = { claim: false, meal: false };
  const dept = String(user.department || '').trim();
  const pos = String(user.position || '').trim();
  if (!dept || !pos) return empty;
  const [drows, prows] = await Promise.all([
    q('SELECT allow_claim, allow_meal FROM departments   WHERE lower(name) = lower($1) AND active = TRUE', [dept]),
    q('SELECT allow_claim, allow_meal FROM job_positions WHERE lower(name) = lower($1) AND active = TRUE', [pos])
  ]);
  const d = drows[0], p = prows[0];
  if (!d || !p) return empty;
  return {
    claim: !!(d.allow_claim && p.allow_claim),
    meal: !!(d.allow_meal && p.allow_meal)
  };
}

// --- Job-position ranking & department-scoped account management -------------
// Job positions form an ordered ladder (job_positions.rank, 1 = most senior),
// editable by super admins in Settings. Account management is scoped to the
// actor's OWN department, and an actor may manage only positions ranked strictly
// below their own (higher number = more junior = fewer rights). Superadmins are
// unrestricted (all departments; they use full Settings). Positions are matched
// case-insensitively by name against job_positions.
//
// The ladder helpers below are PURE: each takes a `pos` map (from loadPositions)
// so a request loads the ranking once and threads it through. `pos` maps
// lower(name) → { rank, can_manage }.
async function loadPositions() {
  const rows = await q('SELECT name, rank, can_manage FROM job_positions');
  const byName = new Map();
  for (const r of rows) {
    byName.set(String(r.name).trim().toLowerCase(),
      { name: String(r.name).trim(), rank: r.rank || Infinity, can_manage: !!r.can_manage });
  }
  return byName;
}
// 1-based rank; Infinity for a position not found (weakest — manages nobody, and
// is itself not manageable by rank).
function positionRank(name, pos) {
  const rec = pos.get(String(name || '').trim().toLowerCase());
  return rec ? rec.rank : Infinity;
}
// Whether a user may delegate account management at all. Superadmins and admins
// always may (department- and rank-limited elsewhere); a plain user may only if
// their job position is flagged can_manage. NOTE: this now gates only *team
// account management* (reset password / enable-disable) — account CREATION is
// super-admin only (see POST /api/users). The 'admin' role is no longer special
// here; management is governed purely by the position flag.
function hasDelegation(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  const rec = pos.get(String(user.position || '').trim().toLowerCase());
  return !!(rec && rec.can_manage);
}

// The canonical position names a user may create accounts for: every position
// ranked strictly below their own. Empty unless they hold delegation rights and
// their own position is on the ladder. Returned most-senior-first by rank.
function creatablePositions(user, pos) {
  if (!hasDelegation(user, pos)) return [];
  const rank = positionRank(user.position, pos);
  if (rank === Infinity) return [];
  return [...pos.values()]
    .filter((rec) => rec.rank > rank)
    .sort((a, b) => a.rank - b.rank)
    .map((rec) => rec.name);
}

// Whether `actor` may manage (reset password / enable-disable) the account
// `target`. Superadmins may manage anyone. Everyone else (admins and delegated
// seniors) may manage any NON-superadmin in their OWN department whose position
// ranks strictly below their own — regardless of the target's role. This keeps
// management purely rank + department based (a Manager can reset/disable a more
// junior Supervisor whether that Supervisor is a plain user or an admin), while
// still protecting superadmins and anyone at or above the actor's own rank.
// (Account *creation* is separately restricted to role 'user' — see POST.)
function canManageAccount(actor, target, pos) {
  if (actor.role === 'superadmin') return true;
  if (!hasDelegation(actor, pos)) return false;
  if (target.role === 'superadmin') return false;
  const aDept = String(actor.department || '').trim().toLowerCase();
  const tDept = String(target.department || '').trim().toLowerCase();
  if (!aDept || aDept !== tDept) return false;
  const tRank = positionRank(target.position, pos);
  if (tRank === Infinity) return false;
  return positionRank(actor.position, pos) < tRank;
}

// --- Expense-insights visibility -------------------------------------------
// Who may see company-wide expense insights vs. only their own department's:
// super admins always; anyone in a Finance department (any position); and anyone
// whose job position ranks at General Manager or above (rank <= GM's rank, since
// rank 1 is the most senior). Everyone else is scoped to their own department.
// GM's rank is read live from the ladder (super admins can reorder it); if no
// "General Manager" position exists, fall back to the seeded GM rank (5).
const GM_FALLBACK_RANK = 5;
const isFinanceDept = (dept) => /financ/i.test(String(dept || ''));
function insightsSeeAll(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (isFinanceDept(user.department)) return true;
  const gm = positionRank('general manager', pos);
  const gmRank = gm === Infinity ? GM_FALLBACK_RANK : gm;
  const r = positionRank(user.position, pos);
  return r !== Infinity && r <= gmRank;
}

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

app.post('/api/login', ah(async (req, res) => {
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
  req.session.userId = user.id;
  const pos = await loadPositions();
  res.json({ user: {
    id: user.id, username: user.username, full_name: user.full_name, role: user.role, email: user.email,
    department: user.department, position: user.position, can_mark_paid: !!user.can_mark_paid,
    purposes: await computePurposes(user), creatable_positions: creatablePositions(user, pos),
    can_manage_accounts: hasDelegation(user, pos)
  } });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', ah(async (req, res) => {
  const u = await loadUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  const pos = await loadPositions();
  res.json({ user: { ...u, purposes: await computePurposes(u), creatable_positions: creatablePositions(u, pos),
    can_manage_accounts: hasDelegation(u, pos) } });
}));

// Self-service profile: a user may edit their own bank / payout details (but
// not role, department, approvers, etc.).
app.put('/api/me', requireAuth, ah(async (req, res) => {
  const { bank_name, recipient_name, bank_account_no, email } = req.body || {};
  const nextEmail = normEmail(email);
  if (nextEmail && !EMAIL_RE.test(nextEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (nextEmail) {
    const dupe = await q('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [nextEmail, req.user.id]);
    if (dupe[0]) return res.status(409).json({ error: 'That email is already used by another account' });
  }
  await q('UPDATE users SET bank_name = $1, recipient_name = $2, bank_account_no = $3, email = $4 WHERE id = $5', [
    String(bank_name || '').trim(), String(recipient_name || '').trim(),
    String(bank_account_no || '').trim(), nextEmail, req.user.id]);
  const u = await loadUser(req);
  const pos = await loadPositions();
  res.json({ user: { ...u, purposes: await computePurposes(u), creatable_positions: creatablePositions(u, pos),
    can_manage_accounts: hasDelegation(u, pos) } });
}));

app.post('/api/me/password', requireAuth, ah(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const rows = await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!bcrypt.compareSync(String(current_password || ''), rows[0].password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(new_password), 10), req.user.id]);
  res.json({ ok: true });
}));

// --- Forgot / reset password ------------------------------------------------
// A user requests a reset by email or username; we email a one-time link that
// carries a random token (only its SHA-256 hash is stored). The link lands on
// /reset.html which posts the token + a new password back to /api/reset-password.
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.post('/api/forgot-password', ah(async (req, res) => {
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

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MS);
  await q('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [user.id]);
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

app.post('/api/reset-password', ah(async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing or invalid reset link.' });
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const rows = await q(
    `SELECT id, user_id FROM password_resets
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     ORDER BY id DESC LIMIT 1`, [sha256(String(token))]);
  const rec = rows[0];
  if (!rec) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(new_password), 10), rec.user_id]);
  await q('UPDATE password_resets SET used_at = now() WHERE id = $1', [rec.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------
app.get('/api/claims', requireAuth, ah(async (req, res) => {
  const { status, department, q: search } = req.query;
  const where = [];
  const params = [];
  const add = (clause, val) => { params.push(val); where.push(clause.replace('$$', `$${params.length}`)); };

  if (req.user.role !== 'superadmin') {
    params.push(req.user.id);
    const p = `$${params.length}`;
    where.push(`(employee_id = ${p} OR ${p} = ANY(approver_ids))`);
  }
  if (status) add('status = $$', status);
  if (department) add('department = $$', department);
  if (search) {
    const like = `%${search}%`;
    params.push(like);
    const p = `$${params.length}`;
    where.push(`(claim_no ILIKE ${p} OR claimant_name ILIKE ${p} OR recipient_name ILIKE ${p} OR expense_type ILIKE ${p} OR db_no ILIKE ${p})`);
  }
  const rows = await q(
    `SELECT * FROM claims ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC`, params);
  res.json({ claims: await serializeMany(rows) });
}));

app.get('/api/claims/summary', requireAuth, ah(async (req, res) => {
  const scope = req.user.role === 'superadmin' ? '' : 'WHERE (employee_id = $1 OR $1 = ANY(approver_ids))';
  const params = req.user.role === 'superadmin' ? [] : [req.user.id];
  const rows = await q(
    `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS total
     FROM claims ${scope} GROUP BY status`, params);
  const summary = { submitted: 0, approved: 0, rejected: 0, paid: 0, total_amount: 0 };
  for (const r of rows) {
    summary[r.status] = Number(r.n);
    summary.total_amount += Number(r.total) / 100;
  }
  res.json({ summary });
}));

app.get('/api/claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (req.user.role !== 'superadmin' && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own claims' });
  }
  res.json({ claim: await serializeOne(row) });
}));

// Sequence backing claims.id, so later inserts in the same transaction can
// reference the just-created claim via currval() without a JS round-trip.
const CLAIM_SEQ = "pg_get_serial_sequence('claims','id')";

// Create a claim together with its attachments and initial history row as one
// atomic transaction — all commit or none. Retries on a claim_no collision.
async function createClaim(req, b, cents, approverIds, uploaded) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextClaimNo();
    const queries = [qq(
      `INSERT INTO claims
        (claim_no, employee_id, claimant_name, expense_date, department, db_no, bank_name,
         recipient_name, bank_account_no, expense_type, amount_cents, currency, description,
         status, approver_ids, current_step)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14::int[],$15)`,
      [claimNo, req.user.id, String(req.user.full_name || '').trim(), String(b.expense_date).trim(),
       String(req.user.department || '').trim(), String(b.db_no || '').trim(),
       String(req.user.bank_name || '').trim(),
       String(req.user.recipient_name || '').trim(), String(req.user.bank_account_no || '').trim(),
       String(b.expense_type).trim(), cents,
       String(b.currency || 'IDR').trim().slice(0, 8), String(b.description || '').trim(),
       intArrayLiteral(approverIds), approverIds.length ? 1 : 0])];
    for (const u of uploaded) {
      queries.push(qq(
        `INSERT INTO attachments (claim_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
         VALUES (currval(${CLAIM_SEQ}),$1,$2,$3,$4,$5)`,
        [u.url, u.pathname, u.original_name, u.mime, u.size]));
    }
    queries.push(qq(
      `INSERT INTO claim_history (claim_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES (currval(${CLAIM_SEQ}),$1,$2,'submitted',NULL,'submitted','')`,
      [req.user.id, String(req.user.full_name || '').trim()]));
    queries.push(qq(`SELECT currval(${CLAIM_SEQ})::int AS id`));
    try {
      const results = await transaction(queries);
      return results[results.length - 1][0].id;
    } catch (e) {
      const msg = String(e.message || '');
      if (e.code === '23505' || msg.includes('claim_no') || msg.includes('duplicate')) continue;
      throw e;
    }
  }
  throw new Error('Could not allocate a claim number — please try again');
}

app.post('/api/claims', requireAuth,
  upload.array('files', 8), ah(async (req, res) => {
    const b = req.body || {};
    for (const f of REQUIRED_FIELDS) {
      if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `Missing required field: ${f}` });
    }
    const cents = parseAmountToCents(b.amount);
    if (cents === null || cents <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });

    // Upload receipts to Blob first; roll them back if the claim insert fails.
    const uploaded = [];
    try {
      for (const file of req.files || []) {
        const r = await uploadReceipt(file.buffer, file.originalname, file.mimetype);
        uploaded.push({ ...r, original_name: file.originalname, mime: file.mimetype, size: file.size });
      }
      const approverIds = await activeApproverIds(req.user.approver_ids);
      const claimId = await createClaim(req, b, cents, approverIds, uploaded);
      const rows = await q('SELECT * FROM claims WHERE id = $1', [claimId]);
      const first = currentApproverId(rows[0]);
      if (first) await notifyPendingApprover(first, reimbNotify(rows[0]));
      res.status(201).json({ claim: await serializeOne(rows[0]) });
    } catch (e) {
      for (const u of uploaded) await deleteReceipt(u.url);
      throw e;
    }
  }));

app.put('/api/claims/:id', requireAuth, upload.array('files', 8), ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (row.employee_id !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You can only edit your own claims' });
  }
  if (row.status !== 'rejected') {
    return res.status(409).json({ error: 'Only rejected claims can be edited and resubmitted' });
  }
  const b = req.body || {};
  for (const f of REQUIRED_FIELDS) {
    if (!b[f] || !String(b[f]).trim()) return res.status(400).json({ error: `Missing required field: ${f}` });
  }
  const cents = parseAmountToCents(b.amount);
  if (cents === null || cents <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });

  const uploaded = [];
  try {
    for (const file of req.files || []) {
      const r = await uploadReceipt(file.buffer, file.originalname, file.mimetype);
      uploaded.push({ ...r, original_name: file.originalname, mime: file.mimetype, size: file.size });
    }
    // Claimant name, department, bank details + approvers come from the account.
    const emp = (await q(
      'SELECT full_name, department, bank_name, recipient_name, bank_account_no, approver_ids FROM users WHERE id = $1',
      [row.employee_id]))[0] || {};
    const approverIds = await activeApproverIds(emp.approver_ids);
    const claimId = Number(row.id);
    const queries = [qq(
      `UPDATE claims SET claimant_name=$1, expense_date=$2, department=$3, db_no=$4, bank_name=$5,
         recipient_name=$6, bank_account_no=$7, expense_type=$8, amount_cents=$9, currency=$10,
         description=$11, status='submitted', manager_comment='', manager_id=NULL,
         decided_at=NULL, approver_ids=$12::int[], current_step=$13, updated_at=now() WHERE id=$14`,
      [String(emp.full_name || '').trim(), String(b.expense_date).trim(), String(emp.department || '').trim(),
       String(b.db_no || '').trim(), String(emp.bank_name || '').trim(), String(emp.recipient_name || '').trim(),
       String(emp.bank_account_no || '').trim(),
       String(b.expense_type).trim(), cents, String(b.currency || row.currency).trim().slice(0, 8),
       String(b.description || '').trim(), intArrayLiteral(approverIds), approverIds.length ? 1 : 0, claimId])];
    for (const u of uploaded) {
      queries.push(qq(
        `INSERT INTO attachments (claim_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
         VALUES ($1,$2,$3,$4,$5,$6)`, [claimId, u.url, u.pathname, u.original_name, u.mime, u.size]));
    }
    queries.push(qq(
      `INSERT INTO claim_history (claim_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES ($1,$2,$3,'resubmitted','rejected','submitted',$4)`,
      [claimId, req.user.id, String(req.user.full_name || '').trim(), String(b.resubmit_note || '').trim()]));
    await transaction(queries);
    const rows = await q('SELECT * FROM claims WHERE id = $1', [row.id]);
    const first = currentApproverId(rows[0]);
    if (first) await notifyPendingApprover(first, reimbNotify(rows[0]));
    res.json({ claim: await serializeOne(rows[0]) });
  } catch (e) {
    for (const u of uploaded) await deleteReceipt(u.url);
    throw e;
  }
}));

app.post('/api/claims/:id/approve', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot approve a claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) {
    return res.status(403).json({ error: 'You are not the approver for this step' });
  }
  const comment = String((req.body && req.body.comment) || '').trim();
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  // A superadmin override finalises immediately; otherwise advance one step and
  // only mark fully approved once the last approver has signed off.
  const finalise = req.user.role === 'superadmin' || !ids.length || step >= ids.length;
  if (finalise) {
    await q(`UPDATE claims SET status='approved', manager_id=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
      [req.user.id, comment, row.id]);
    await logHistory(row.id, req.user, ids.length ? `approved — step ${step} of ${ids.length}` : 'approved', 'submitted', 'approved', comment);
  } else {
    await q(`UPDATE claims SET current_step=$1, updated_at=now() WHERE id=$2`, [step + 1, row.id]);
    await logHistory(row.id, req.user, `approved — step ${step} of ${ids.length}`, 'submitted', 'submitted', comment);
  }
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  if (finalise) {
    // Fully approved: let the claimant know.
    await notifyClaimantDecision(rows[0].employee_id, reimbNotify(rows[0]), 'approved');
  } else {
    // Chain advanced: tell the next approver it's their turn.
    const next = currentApproverId(rows[0]);
    if (next) await notifyPendingApprover(next, reimbNotify(rows[0]));
  }
  res.json({ claim: await serializeOne(rows[0]) });
}));

app.post('/api/claims/:id/reject', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  const comment = String((req.body && req.body.comment) || '').trim();
  if (!comment) return res.status(400).json({ error: 'A reason is required when rejecting a claim' });
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot reject a claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) {
    return res.status(403).json({ error: 'You are not the approver for this claim' });
  }
  await q(`UPDATE claims SET status='rejected', manager_id=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
    [req.user.id, comment, row.id]);
  await logHistory(row.id, req.user, 'rejected', 'submitted', 'rejected', comment);
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  await notifyClaimantRejected(rows[0].employee_id, { ...reimbNotify(rows[0]), reason: comment });
  res.json({ claim: await serializeOne(rows[0]) });
}));

app.post('/api/claims/:id/mark-paid', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to mark claims as paid' });
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved claims can be marked as paid' });
  const paymentDate = String((req.body && req.body.payment_date) || '').trim();
  if (!DATE_RE.test(paymentDate)) return res.status(400).json({ error: 'A payment date is required to mark a claim as paid' });
  await q(`UPDATE claims SET status='paid', paid_by=$1, paid_at=$2, updated_at=now() WHERE id=$3`, [req.user.id, paymentDate, row.id]);
  await logHistory(row.id, req.user, `marked paid — ${paymentDate}`, 'approved', 'paid', String((req.body && req.body.comment) || '').trim());
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  await notifyClaimantDecision(rows[0].employee_id, reimbNotify(rows[0]), 'paid');
  res.json({ claim: await serializeOne(rows[0]) });
}));

// Revert a reimbursement claim one step back (see planRevert).
app.post('/api/claims/:id/revert', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  const plan = planRevert(row, req.user);
  if (plan.error) return res.status(plan.code).json({ error: plan.error });
  const step = row.current_step || 0;
  if (plan.kind === 'unpay') {
    await q(`UPDATE claims SET status='approved', paid_by=NULL, paid_at=NULL, updated_at=now() WHERE id=$1`, [row.id]);
  } else if (plan.kind === 'unapprove-final') {
    await q(`UPDATE claims SET status='submitted', manager_id=NULL, manager_comment='', decided_at=NULL, updated_at=now() WHERE id=$1`, [row.id]);
  } else if (plan.kind === 'unapprove-step') {
    await q(`UPDATE claims SET current_step=$1, updated_at=now() WHERE id=$2`, [step - 1, row.id]);
  } else { // cancel
    await q(`UPDATE claims SET status='rejected', manager_id=NULL, manager_comment=$1, decided_at=now(), updated_at=now() WHERE id=$2`,
      [plan.comment, row.id]);
  }
  await logHistory(row.id, req.user, plan.action, plan.from, plan.to, plan.comment || '');
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  res.json({ claim: await serializeOne(rows[0]) });
}));

// Download an attachment — auth-scoped, streamed from Blob (URL never exposed).
app.get('/api/claims/:id/attachments/:attId', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (req.user.role !== 'superadmin' && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  const rows = await q('SELECT * FROM attachments WHERE id=$1 AND claim_id=$2', [req.params.attId, row.id]);
  const att = rows[0];
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const r = await fetch(att.blob_url);
  if (!r.ok) return res.status(502).json({ error: 'Could not fetch file from storage' });
  // Only render images and PDFs in the browser (safe to display inline, and the
  // useful case for viewing a receipt). Everything else (Office docs, CSV, text)
  // is forced to download so the browser never tries to render it in-page.
  const inlineOk = att.mime_type === 'application/pdf' || att.mime_type.startsWith('image/');
  const disposition = inlineOk ? 'inline' : 'attachment';
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(att.original_name)}"`);
  res.send(Buffer.from(await r.arrayBuffer()));
}));

// Delete a reimbursement claim outright (super admin only) — clears its
// attachments (and their blobs) and history first. Meant for tidying up test
// data; there is no undo.
app.delete('/api/claims/:id', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  const atts = await q('SELECT blob_url FROM attachments WHERE claim_id = $1', [row.id]);
  // Remove the database rows atomically first; only once that commits do we
  // delete the blobs (which can't be rolled back). If the transaction fails the
  // blobs are untouched, so we never orphan a claim that points at missing files.
  const claimId = Number(row.id);
  await transaction([
    qq('DELETE FROM attachments WHERE claim_id = $1', [claimId]),
    qq('DELETE FROM claim_history WHERE claim_id = $1', [claimId]),
    qq('DELETE FROM claims WHERE id = $1', [claimId])
  ]);
  for (const a of atts) await deleteReceipt(a.blob_url);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Meal allowance claims
// A header + line items, following the same submit → approve chain → reject /
// resubmit → paid workflow as reimbursement claims (see userCanApprove).
// ---------------------------------------------------------------------------
async function nextMealClaimNo() {
  const year = new Date().getFullYear();
  const rows = await q('SELECT COUNT(*)::int AS n FROM meal_claims WHERE claim_no LIKE $1', [`MA-${year}-%`]);
  return `MA-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}
async function logMealHistory(claimId, actor, action, fromStatus, toStatus, comment = '') {
  await q(
    `INSERT INTO meal_claim_history (meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [claimId, actor.id, actor.full_name, action, fromStatus, toStatus, comment]);
}
// Validate + normalise the submitted line items. Fully-blank rows are dropped;
// a kept row needs a date and a positive amount. Returns { lines, totalCents }.
function normaliseMealLines(input) {
  if (!Array.isArray(input)) return { error: 'Lines must be a list' };
  const lines = [];
  let totalCents = 0;
  for (const raw of input) {
    const r = raw || {};
    const date = String(r.date || r.line_date || '').trim();
    const site = String(r.site || '').trim();
    const category = String(r.category || r.job_category || '').trim();
    const description = String(r.desc || r.description || '').trim();
    const cents = parseAmountToCents(r.amount);
    const blank = !date && !site && !category && !description && (cents === null || cents === 0);
    if (blank) continue;
    if (!date) return { error: 'Every filled row needs a date' };
    if (cents === null || cents <= 0) return { error: 'Every filled row needs a positive amount' };
    totalCents += cents;
    lines.push({ line_date: date, site, job_category: category, amount_cents: cents, description });
  }
  if (!lines.length) return { error: 'Add at least one line with a date and amount' };
  return { lines, totalCents };
}
function baseMealClaim(row, lines, history, nameMap) {
  return {
    id: row.id, type: 'meal', claim_no: row.claim_no,
    employee_id: row.employee_id, claimant_name: row.claimant_name,
    department: row.department, bank_name: row.bank_name,
    recipient_name: row.recipient_name, bank_account_no: row.bank_account_no,
    total_amount: Number(row.total_cents) / 100, currency: row.currency,
    status: row.status, manager_comment: row.manager_comment,
    manager_id: row.manager_id == null ? null : Number(row.manager_id),
    paid_by: row.paid_by == null ? null : Number(row.paid_by),
    approvers: asIntArray(row.approver_ids).map(id => ({ id, name: (nameMap && nameMap[id]) || `User #${id}` })),
    current_step: row.current_step || 0,
    decided_at: iso(row.decided_at), paid_at: iso(row.paid_at),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    lines: (lines || []).map(l => ({
      line_date: l.line_date, site: l.site, job_category: l.job_category,
      amount: Number(l.amount_cents) / 100, description: l.description
    })),
    history: (history || []).map(h => ({
      actor_name: h.actor_name, action: h.action, from_status: h.from_status,
      to_status: h.to_status, comment: h.comment, created_at: iso(h.created_at)
    }))
  };
}
async function serializeManyMeal(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const lines = await q(
    `SELECT * FROM meal_claim_lines WHERE meal_claim_id IN (${ph}) ORDER BY sort_order, id`, ids);
  const hist = await q(
    `SELECT meal_claim_id, actor_name, action, from_status, to_status, comment, created_at
     FROM meal_claim_history WHERE meal_claim_id IN (${ph}) ORDER BY id`, ids);
  const l = groupBy(lines, 'meal_claim_id');
  const h = groupBy(hist, 'meal_claim_id');
  const approverIds = [...new Set(rows.flatMap(r => asIntArray(r.approver_ids)))];
  const nameMap = {};
  if (approverIds.length) {
    const aph = approverIds.map((_, i) => `$${i + 1}`).join(',');
    const us = await q(`SELECT id, full_name FROM users WHERE id IN (${aph})`, approverIds);
    for (const u of us) nameMap[u.id] = u.full_name;
  }
  return rows.map(r => baseMealClaim(r, l[r.id], h[r.id], nameMap));
}
async function serializeOneMeal(row) { return (await serializeManyMeal([row]))[0]; }
async function loadMealClaimOr404(req, res) {
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Meal claim not found' }); return null; }
  return rows[0];
}

app.get('/api/meal-claims', requireAuth, ah(async (req, res) => {
  const { status, department, q: search } = req.query;
  const where = [];
  const params = [];
  const add = (clause, val) => { params.push(val); where.push(clause.replace('$$', `$${params.length}`)); };
  if (req.user.role !== 'superadmin') {
    params.push(req.user.id);
    const p = `$${params.length}`;
    where.push(`(employee_id = ${p} OR ${p} = ANY(approver_ids))`);
  }
  if (status) add('status = $$', status);
  if (department) add('department = $$', department);
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    // Meal claims carry the DB number per line (meal_claim_lines.site), so search
    // it via EXISTS in addition to the header fields.
    where.push(`(claim_no ILIKE ${p} OR claimant_name ILIKE ${p} OR EXISTS (SELECT 1 FROM meal_claim_lines l WHERE l.meal_claim_id = meal_claims.id AND l.site ILIKE ${p}))`);
  }
  const rows = await q(
    `SELECT * FROM meal_claims ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC`, params);
  res.json({ claims: await serializeManyMeal(rows) });
}));

app.get('/api/meal-claims/summary', requireAuth, ah(async (req, res) => {
  const scope = req.user.role === 'superadmin' ? '' : 'WHERE (employee_id = $1 OR $1 = ANY(approver_ids))';
  const params = req.user.role === 'superadmin' ? [] : [req.user.id];
  const rows = await q(
    `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_cents),0)::bigint AS total
     FROM meal_claims ${scope} GROUP BY status`, params);
  const summary = { submitted: 0, approved: 0, rejected: 0, paid: 0, total_amount: 0 };
  for (const r of rows) {
    summary[r.status] = Number(r.n);
    summary.total_amount += Number(r.total) / 100;
  }
  res.json({ summary });
}));

app.get('/api/meal-claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (req.user.role !== 'superadmin' && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own meal claims' });
  }
  res.json({ claim: await serializeOneMeal(row) });
}));

// Delete a meal allowance claim outright (super admin only) — removes its line
// items and history first. For clearing test data; no undo.
app.delete('/api/meal-claims/:id', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  const claimId = Number(row.id);
  await transaction([
    qq('DELETE FROM meal_claim_lines WHERE meal_claim_id = $1', [claimId]),
    qq('DELETE FROM meal_claim_history WHERE meal_claim_id = $1', [claimId]),
    qq('DELETE FROM meal_claims WHERE id = $1', [claimId])
  ]);
  res.json({ ok: true });
}));

// Sequence backing meal_claims.id (see CLAIM_SEQ).
const MEAL_SEQ = "pg_get_serial_sequence('meal_claims','id')";

// One lazy meal-line INSERT. `claimIdExpr` is a trusted SQL fragment: a numeric
// claim id (resubmit) or currval(...) (new claim) — never user input.
function mealLineQuery(claimIdExpr, l, i) {
  return qq(
    `INSERT INTO meal_claim_lines (meal_claim_id, sort_order, line_date, site, job_category, amount_cents, description)
     VALUES (${claimIdExpr},$1,$2,$3,$4,$5,$6)`,
    [i, l.line_date, l.site, l.job_category, l.amount_cents, l.description]);
}

// Create a meal claim, its line items and initial history row as one atomic
// transaction. Retries on a claim_no collision.
async function createMealClaim(req, lines, totalCents, approverIds) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextMealClaimNo();
    const queries = [qq(
      `INSERT INTO meal_claims
        (claim_no, employee_id, claimant_name, department, bank_name, recipient_name,
         bank_account_no, total_cents, currency, status, approver_ids, current_step)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10::int[],$11)`,
      [claimNo, req.user.id, String(req.user.full_name || '').trim(), String(req.user.department || '').trim(),
       String(req.user.bank_name || '').trim(), String(req.user.recipient_name || '').trim(),
       String(req.user.bank_account_no || '').trim(), totalCents, 'IDR',
       intArrayLiteral(approverIds), approverIds.length ? 1 : 0])];
    lines.forEach((l, i) => queries.push(mealLineQuery(`currval(${MEAL_SEQ})`, l, i)));
    queries.push(qq(
      `INSERT INTO meal_claim_history (meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES (currval(${MEAL_SEQ}),$1,$2,'submitted',NULL,'submitted','')`,
      [req.user.id, String(req.user.full_name || '').trim()]));
    queries.push(qq(`SELECT currval(${MEAL_SEQ})::int AS id`));
    try {
      const results = await transaction(queries);
      return results[results.length - 1][0].id;
    } catch (e) {
      const msg = String(e.message || '');
      if (e.code === '23505' || msg.includes('claim_no') || msg.includes('duplicate')) continue;
      throw e;
    }
  }
  throw new Error('Could not allocate a claim number — please try again');
}

app.post('/api/meal-claims', requireAuth, ah(async (req, res) => {
  const parsed = normaliseMealLines((req.body || {}).lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const approverIds = await activeApproverIds(req.user.approver_ids);
  const claimId = await createMealClaim(req, parsed.lines, parsed.totalCents, approverIds);
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [claimId]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, mealNotify(rows[0]));
  res.status(201).json({ claim: await serializeOneMeal(rows[0]) });
}));

app.put('/api/meal-claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (row.employee_id !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You can only edit your own meal claims' });
  }
  if (row.status !== 'rejected') {
    return res.status(409).json({ error: 'Only rejected meal claims can be edited and resubmitted' });
  }
  const parsed = normaliseMealLines((req.body || {}).lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // Bank details + approvers come from the claimant's account.
  const emp = (await q(
    'SELECT full_name, department, bank_name, recipient_name, bank_account_no, approver_ids FROM users WHERE id = $1',
    [row.employee_id]))[0] || {};
  const approverIds = await activeApproverIds(emp.approver_ids);
  const claimId = Number(row.id);
  const queries = [qq(
    `UPDATE meal_claims SET total_cents=$1, department=$2, bank_name=$3, recipient_name=$4,
       bank_account_no=$5, status='submitted', manager_comment='', manager_id=NULL, decided_at=NULL,
       approver_ids=$6::int[], current_step=$7, updated_at=now() WHERE id=$8`,
    [parsed.totalCents, String(emp.department || '').trim(), String(emp.bank_name || '').trim(),
     String(emp.recipient_name || '').trim(), String(emp.bank_account_no || '').trim(),
     intArrayLiteral(approverIds), approverIds.length ? 1 : 0, claimId]),
    qq('DELETE FROM meal_claim_lines WHERE meal_claim_id = $1', [claimId])];
  parsed.lines.forEach((l, i) => queries.push(mealLineQuery(claimId, l, i)));
  queries.push(qq(
    `INSERT INTO meal_claim_history (meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,'resubmitted','rejected','submitted',$4)`,
    [claimId, req.user.id, String(req.user.full_name || '').trim(), String((req.body && req.body.resubmit_note) || '').trim()]));
  await transaction(queries);
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [row.id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, mealNotify(rows[0]));
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

app.post('/api/meal-claims/:id/approve', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot approve a meal claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) return res.status(403).json({ error: 'You are not the approver for this step' });
  const comment = String((req.body && req.body.comment) || '').trim();
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  const finalise = req.user.role === 'superadmin' || !ids.length || step >= ids.length;
  if (finalise) {
    await q(`UPDATE meal_claims SET status='approved', manager_id=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
      [req.user.id, comment, row.id]);
    await logMealHistory(row.id, req.user, ids.length ? `approved — step ${step} of ${ids.length}` : 'approved', 'submitted', 'approved', comment);
  } else {
    await q(`UPDATE meal_claims SET current_step=$1, updated_at=now() WHERE id=$2`, [step + 1, row.id]);
    await logMealHistory(row.id, req.user, `approved — step ${step} of ${ids.length}`, 'submitted', 'submitted', comment);
  }
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  if (finalise) {
    await notifyClaimantDecision(rows[0].employee_id, mealNotify(rows[0]), 'approved');
  } else {
    const next = currentApproverId(rows[0]);
    if (next) await notifyPendingApprover(next, mealNotify(rows[0]));
  }
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

app.post('/api/meal-claims/:id/reject', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  const comment = String((req.body && req.body.comment) || '').trim();
  if (!comment) return res.status(400).json({ error: 'A reason is required when rejecting a claim' });
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot reject a meal claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) return res.status(403).json({ error: 'You are not the approver for this claim' });
  await q(`UPDATE meal_claims SET status='rejected', manager_id=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
    [req.user.id, comment, row.id]);
  await logMealHistory(row.id, req.user, 'rejected', 'submitted', 'rejected', comment);
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  await notifyClaimantRejected(rows[0].employee_id, { ...mealNotify(rows[0]), reason: comment });
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

app.post('/api/meal-claims/:id/mark-paid', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to mark claims as paid' });
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved meal claims can be marked as paid' });
  const paymentDate = String((req.body && req.body.payment_date) || '').trim();
  if (!DATE_RE.test(paymentDate)) return res.status(400).json({ error: 'A payment date is required to mark a claim as paid' });
  await q(`UPDATE meal_claims SET status='paid', paid_by=$1, paid_at=$2, updated_at=now() WHERE id=$3`, [req.user.id, paymentDate, row.id]);
  await logMealHistory(row.id, req.user, `marked paid — ${paymentDate}`, 'approved', 'paid', String((req.body && req.body.comment) || '').trim());
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  await notifyClaimantDecision(rows[0].employee_id, mealNotify(rows[0]), 'paid');
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

// Revert a meal allowance claim one step back (see planRevert).
app.post('/api/meal-claims/:id/revert', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  const plan = planRevert(row, req.user);
  if (plan.error) return res.status(plan.code).json({ error: plan.error });
  const step = row.current_step || 0;
  if (plan.kind === 'unpay') {
    await q(`UPDATE meal_claims SET status='approved', paid_by=NULL, paid_at=NULL, updated_at=now() WHERE id=$1`, [row.id]);
  } else if (plan.kind === 'unapprove-final') {
    await q(`UPDATE meal_claims SET status='submitted', manager_id=NULL, manager_comment='', decided_at=NULL, updated_at=now() WHERE id=$1`, [row.id]);
  } else if (plan.kind === 'unapprove-step') {
    await q(`UPDATE meal_claims SET current_step=$1, updated_at=now() WHERE id=$2`, [step - 1, row.id]);
  } else { // cancel
    await q(`UPDATE meal_claims SET status='rejected', manager_id=NULL, manager_comment=$1, decided_at=now(), updated_at=now() WHERE id=$2`,
      [plan.comment, row.id]);
  }
  await logMealHistory(row.id, req.user, plan.action, plan.from, plan.to, plan.comment || '');
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

// ---------------------------------------------------------------------------
// Daily reminder (Vercel Cron)
// ---------------------------------------------------------------------------
// Vercel Cron calls this once a day (see vercel.json). It emails every approver
// a digest of the claims currently sitting at their step. Protected by
// CRON_SECRET: Vercel sends it as an "Authorization: Bearer <secret>" header.
app.get('/api/cron/reminders', ah(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const byApprover = new Map(); // approverId -> [claim payloads]
  const push = (id, payload) => {
    if (!id) return;
    if (!byApprover.has(id)) byApprover.set(id, []);
    byApprover.get(id).push(payload);
  };
  const reimb = await q(
    `SELECT claim_no, claimant_name, amount_cents, currency, approver_ids, current_step
     FROM claims WHERE status = 'submitted'`);
  for (const r of reimb) push(currentApproverId(r), reimbNotify(r));
  const meal = await q(
    `SELECT claim_no, claimant_name, total_cents, currency, approver_ids, current_step
     FROM meal_claims WHERE status = 'submitted'`);
  for (const r of meal) push(currentApproverId(r), mealNotify(r));

  let sent = 0;
  for (const [approverId, claims] of byApprover) {
    const r = await sendReminderDigest(approverId, claims);
    if (r && r.ok) sent += 1;
  }
  res.json({ ok: true, approvers: byApprover.size, sent });
}));

// ---------------------------------------------------------------------------
// Export CSV (finance)
// ---------------------------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const EXPORT_STATUSES = ['submitted', 'approved', 'rejected', 'paid'];
// ---------------------------------------------------------------------------
// Expense insights (charts)
// ---------------------------------------------------------------------------
// Aggregated spend for the Insights view. Reimbursement claims and meal
// allowances are folded into one dataset: meal allowances appear as the category
// "Meal allowance", grouped by each line item's date (a meal claim has no single
// expense date). Everything is grouped by expense date. Visibility follows
// insightsSeeAll — company-wide for super admins, Finance, and GM-and-above;
// otherwise pinned to the viewer's own department. Filters: `year`, `department`
// (honoured only for see-all viewers), `db` (DB-number substring — DB lives on
// claims.db_no and, for meals, on each line's `site`), and `status`
// (comma-separated; defaults to approved + paid, i.e. real outflow).
const INSIGHT_STATUSES = ['submitted', 'approved', 'rejected', 'paid'];
app.get('/api/insights', requireAuth, ah(async (req, res) => {
  const pos = await loadPositions();
  const seeAll = insightsSeeAll(req.user, pos);
  const ownDept = String(req.user.department || '').trim();

  let statuses = String(req.query.status || '').split(',').map(s => s.trim())
    .filter(s => INSIGHT_STATUSES.includes(s));
  if (!statuses.length) statuses = ['approved', 'paid'];

  // See-all viewers may narrow to one department; everyone else is pinned to
  // their own. A pinned viewer with no department sees nothing.
  const deptFilter = seeAll ? String(req.query.department || '').trim() : ownDept;
  const db = String(req.query.db || '').trim();

  const params = [];
  const where = [];
  const ph = statuses.map(s => { params.push(s); return `$${params.length}`; }).join(',');
  where.push(`status IN (${ph})`);
  where.push(`d ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`);
  if (deptFilter) { params.push(deptFilter); where.push(`lower(department) = lower($${params.length})`); }
  if (db) { params.push(`%${db}%`); where.push(`db ILIKE $${params.length}`); }
  // A non-see-all viewer whose account has no department must never see the
  // whole company, so short-circuit to an empty result set.
  const noScope = !seeAll && !ownDept;

  const rows = noScope ? [] : await q(
    `SELECT category, substring(d,1,4) AS yr, substring(d,6,2) AS mo,
            cents::bigint AS cents, cid
       FROM (
         SELECT expense_type AS category, department, expense_date AS d,
                amount_cents AS cents, status, COALESCE(db_no,'') AS db, 'c' || id AS cid
           FROM claims
         UNION ALL
         SELECT 'Meal allowance' AS category, m.department, l.line_date AS d,
                l.amount_cents AS cents, m.status, COALESCE(l.site,'') AS db, 'm' || m.id AS cid
           FROM meal_claim_lines l JOIN meal_claims m ON m.id = l.meal_claim_id
       ) ev
      WHERE ${where.join(' AND ')}`, params);

  // Years present (desc). Resolve the selected year: the requested one when it
  // has data, else the most recent year, else the current calendar year.
  const yearsSet = new Set(rows.map(r => r.yr));
  const years = [...yearsSet].sort().reverse();
  const reqYear = String(req.query.year || '').trim();
  const year = (reqYear && yearsSet.has(reqYear)) ? reqYear
    : (years[0] || String(new Date().getFullYear()));

  // By year (all years) — backs the yearly trend toggle.
  const byYearMap = new Map();
  for (const r of rows) byYearMap.set(r.yr, (byYearMap.get(r.yr) || 0) + Number(r.cents));
  const byYear = [...byYearMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([y, cents]) => ({ year: y, cents }));

  // Everything else is for the selected year only.
  const inYear = rows.filter(r => r.yr === year);
  const byTypeMap = new Map();
  for (const r of inYear) byTypeMap.set(r.category, (byTypeMap.get(r.category) || 0) + Number(r.cents));
  const byType = [...byTypeMap.entries()].sort((a, b) => b[1] - a[1])
    .map(([type, cents]) => ({ type, cents }));

  const monthCents = Array(12).fill(0);
  for (const r of inYear) { const m = Number(r.mo); if (m >= 1 && m <= 12) monthCents[m - 1] += Number(r.cents); }
  const byMonth = monthCents.map((cents, i) => ({ month: String(i + 1).padStart(2, '0'), cents }));

  const total = inYear.reduce((s, r) => s + Number(r.cents), 0);
  const claims = new Set(inYear.map(r => r.cid)).size;
  const top = byType[0] || null;
  const kpis = {
    total_cents: total,
    claims,
    avg_cents: claims ? Math.round(total / claims) : 0,
    top_type: top ? top.type : '',
    top_share: top && total ? Math.round((top.cents / total) * 100) : 0
  };

  // Department options for the filter dropdown (see-all viewers only).
  let departments = [];
  if (seeAll) {
    const drows = await q(
      `SELECT DISTINCT department FROM (
         SELECT department FROM claims UNION SELECT department FROM meal_claims
       ) t WHERE COALESCE(TRIM(department), '') <> '' ORDER BY department`);
    departments = drows.map(r => r.department);
  }

  res.json({
    scope: { all: seeAll, department: seeAll ? (deptFilter || null) : (ownDept || null) },
    currency: 'IDR',
    year, years, status: statuses, db, departments,
    byType, byMonth, byYear, kpis
  });
}));

// Export both reimbursement claims and meal allowance claims in one CSV.
// Filters: `status` (comma-separated, any of the four), `from`/`to` (inclusive,
// applied to each row's expense/meal date), and `types` (comma-separated:
// reimbursement, meal \u2014 defaults to both). Reimbursement claims export one row
// each; meal allowances export one row per line item (per day), so finance sees
// the full daily breakdown. A shared column set carries both.
app.get('/api/export.csv', requireAuth, requireRole('superadmin', 'admin'), ah(async (req, res) => {
  const { from, to } = req.query;
  const statuses = String(req.query.status || '').split(',').map(s => s.trim())
    .filter(s => EXPORT_STATUSES.includes(s));
  const types = String(req.query.types || 'reimbursement,meal').split(',').map(s => s.trim());
  const wantReimb = types.includes('reimbursement');
  const wantMeal = types.includes('meal');
  // Optional whitelist of submitter (employee) ids to include.
  const employees = String(req.query.employees || '').split(',')
    .map(s => Number(s.trim())).filter(Number.isInteger);

  const out = []; // { key: sortKey, cells: [...] }

  if (wantReimb) {
    const where = [];
    const params = [];
    if (statuses.length) {
      const ph = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
      statuses.forEach(s => params.push(s));
      where.push(`c.status IN (${ph})`);
    }
    if (employees.length) {
      const ph = employees.map((_, i) => `$${params.length + i + 1}`).join(',');
      employees.forEach(e => params.push(e));
      where.push(`c.employee_id IN (${ph})`);
    }
    if (from) { params.push(from); where.push(`c.expense_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`c.expense_date <= $${params.length}`); }
    const rows = await q(
      `SELECT c.*, u.username AS employee_username FROM claims c JOIN users u ON u.id = c.employee_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params);
    for (const r of rows) {
      out.push({ key: iso(r.created_at) || '', cells: [
        'Reimbursement', r.claim_no, r.employee_username, r.claimant_name, r.department,
        r.bank_name, r.recipient_name, r.bank_account_no, r.expense_date, r.expense_type, r.db_no || '',
        (Number(r.amount_cents) / 100).toFixed(2), r.currency, r.description, r.status,
        r.manager_comment, iso(r.decided_at), iso(r.paid_at), iso(r.created_at)] });
    }
  }

  if (wantMeal) {
    const where = [];
    const params = [];
    if (statuses.length) {
      const ph = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
      statuses.forEach(s => params.push(s));
      where.push(`m.status IN (${ph})`);
    }
    if (employees.length) {
      const ph = employees.map((_, i) => `$${params.length + i + 1}`).join(',');
      employees.forEach(e => params.push(e));
      where.push(`m.employee_id IN (${ph})`);
    }
    if (from) { params.push(from); where.push(`l.line_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`l.line_date <= $${params.length}`); }
    const rows = await q(
      `SELECT m.claim_no, m.claimant_name, m.department, m.bank_name, m.recipient_name,
              m.bank_account_no, m.currency, m.status, m.manager_comment, m.decided_at, m.paid_at,
              m.created_at, u.username AS employee_username,
              l.line_date, l.site, l.job_category, l.amount_cents, l.description, l.sort_order
       FROM meal_claim_lines l
       JOIN meal_claims m ON m.id = l.meal_claim_id
       JOIN users u ON u.id = m.employee_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.created_at, l.sort_order`, params);
    for (const r of rows) {
      out.push({ key: iso(r.created_at) || '', cells: [
        'Meal allowance', r.claim_no, r.employee_username, r.claimant_name, r.department,
        r.bank_name, r.recipient_name, r.bank_account_no, r.line_date, r.job_category, r.site,
        (Number(r.amount_cents) / 100).toFixed(2), r.currency, r.description, r.status,
        r.manager_comment, iso(r.decided_at), iso(r.paid_at), iso(r.created_at)] });
    }
  }

  out.sort((a, b) => String(a.key).localeCompare(String(b.key)));

  const headers = ['Type', 'Claim No', 'Submitted By', 'Claimant Name', 'Department',
    'Bank Name', 'Recipient Name', 'Bank Account No', 'Date', 'Category', 'Site', 'Amount',
    'Currency', 'Description', 'Status', 'Manager Comment', 'Decided At', 'Paid At', 'Created At'];
  const lines = [headers.map(csvCell).join(',')];
  for (const r of out) lines.push(r.cells.map(csvCell).join(','));

  const csv = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claims-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------
const isActive = (v) => v === true || v === 1 || v === '1' || v === 'true';
const ROLES = ['superadmin', 'admin', 'user'];

// Send a test email so an admin can confirm the Resend configuration works.
// Defaults to the admin's own account email; a recipient can be supplied.
app.post('/api/test-email', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  if (!emailConfigured()) {
    return res.status(400).json({ error: 'Email is not configured. Set RESEND_API_KEY and EMAIL_FROM in the environment, then redeploy.' });
  }
  const to = normEmail((req.body && req.body.to) || req.user.email);
  if (!to) return res.status(400).json({ error: 'No recipient — set an email on your account or enter one.' });
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter a valid email address' });
  const inner = `
    <p style="margin:0 0 8px">Hi ${escHtml(req.user.full_name)},</p>
    <p style="margin:0 0 8px">This is a test email from the Reimbursement Portal. If you received it, email delivery is working correctly.</p>
    <p style="margin:0;color:#6b7280;font-size:13px">Sent ${escHtml(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(',', ''))} WIB.</p>
    ${button(`${baseUrl(req)}/`, 'Open the portal')}`;
  const r = await sendEmail({
    to,
    subject: 'Reimbursement Portal — test email',
    html: layout('Test email', inner),
    text: 'This is a test email from the Reimbursement Portal. If you received it, email delivery is working correctly.'
  });
  if (r && r.ok) return res.json({ ok: true, to });
  return res.status(502).json({ error: `Could not send: ${(r && r.error) || 'unknown error'}` });
}));
// Clean an approver-id list: positive integers, de-duplicated, excluding the
// account itself (an account cannot approve its own claims).
function sanitizeApproverIds(input, excludeId) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n !== excludeId && !out.includes(n)) out.push(n);
  }
  return out;
}

// The department Manager (position "Manager") then the FinanceAP account, as an
// ordered approver chain. Returns whichever of the two currently exist and are
// active. CURRENTLY UNUSED: account creation is now super-admin only, so this no
// longer fires automatically — kept in case super-admin-created accounts should
// auto-fill this chain (pending a product decision).
async function adminAutoApproverChain(dept) { // eslint-disable-line no-unused-vars
  const mgr = await q(
    `SELECT id FROM users WHERE active AND lower(department) = lower($1)
       AND lower(position) = 'manager' ORDER BY id LIMIT 1`, [dept]);
  const fin = await q(
    `SELECT id FROM users WHERE active AND lower(username) = 'financeap' ORDER BY id LIMIT 1`);
  const ids = [];
  if (mgr[0]) ids.push(mgr[0].id);
  if (fin[0]) ids.push(fin[0].id);
  return ids;
}

app.get('/api/users', requireAuth, ah(async (req, res) => {
  const isSuper = req.user.role === 'superadmin';
  // Superadmins read every account; admins and delegated seniors read only their
  // own department's accounts (to populate Manage-accounts). Everyone else is
  // forbidden.
  if (!isSuper && !hasDelegation(req.user, await loadPositions())) {
    return res.status(403).json({ error: 'You do not have permission for this action' });
  }
  const cols = 'id, username, full_name, email, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids, can_mark_paid, active, created_by, created_by_name, created_at';
  const users = isSuper
    ? await q(`SELECT ${cols} FROM users ORDER BY id`)
    : await q(`SELECT ${cols} FROM users WHERE lower(department) = lower($1) ORDER BY id`,
        [String(req.user.department || '').trim()]);
  res.json({ users: users.map(u => ({ ...u, approver_ids: asIntArray(u.approver_ids), created_at: iso(u.created_at) })) });
}));
// Account creation is super-admin only. Everyone else — including admins and
// senior positions — can no longer create accounts (they may still reset /
// enable-disable their team; see canManageAccount).
app.post('/api/users', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const isSuper = true;
  const { username, password, full_name, email,
    bank_name, recipient_name, bank_account_no } = req.body || {};
  let { role, department, position, approver_ids } = req.body || {};
  if (!username || !password || !full_name || !role) return res.status(400).json({ error: 'username, password, full_name and role are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const nextEmail = normEmail(email);
  if (nextEmail && !EMAIL_RE.test(nextEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  const exists = await q('SELECT 1 FROM users WHERE username = $1', [String(username).trim()]);
  if (exists[0]) return res.status(409).json({ error: 'Username already exists' });
  if (nextEmail) {
    const dupe = await q('SELECT 1 FROM users WHERE lower(email) = $1', [nextEmail]);
    if (dupe[0]) return res.status(409).json({ error: 'That email is already used by another account' });
  }
  // Only a super admin may grant the mark-paid permission.
  const canMarkPaidFlag = isSuper && isActive((req.body || {}).can_mark_paid);
  const rows = await q(
    `INSERT INTO users (username, password_hash, full_name, role, department, position, email, bank_name, recipient_name, bank_account_no, approver_ids, can_mark_paid, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::int[],$12,$13,$14) RETURNING id`,
    [String(username).trim(), bcrypt.hashSync(String(password), 10), String(full_name).trim(), role,
     String(department || '').trim(), String(position || '').trim(), nextEmail,
     String(bank_name || '').trim(), String(recipient_name || '').trim(),
     String(bank_account_no || '').trim(), intArrayLiteral(sanitizeApproverIds(approver_ids)), canMarkPaidFlag,
     req.user.id, req.user.full_name || req.user.username || '']);
  res.status(201).json({ id: rows[0].id });
}));
app.put('/api/users/:id', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const rows = await q('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { username, full_name, role, department, position, active, password, email,
    bank_name, recipient_name, bank_account_no, approver_ids, can_mark_paid } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // Username can be changed, but must stay unique.
  let nextUsername = u.username;
  if (username != null && String(username).trim() && String(username).trim() !== u.username) {
    nextUsername = String(username).trim();
    const dupe = await q('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [nextUsername, u.id]);
    if (dupe[0]) return res.status(409).json({ error: 'Username already exists' });
  }
  // Email is optional; when supplied it must be valid and unique.
  let nextEmail = u.email;
  if (email !== undefined) {
    nextEmail = normEmail(email);
    if (nextEmail && !EMAIL_RE.test(nextEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (nextEmail) {
      const dupe = await q('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [nextEmail, u.id]);
      if (dupe[0]) return res.status(409).json({ error: 'That email is already used by another account' });
    }
  }
  const nextApprovers = approver_ids !== undefined
    ? sanitizeApproverIds(approver_ids, u.id) : asIntArray(u.approver_ids);
  // Stale-approver guard: deactivating an account that is the pending approver on
  // open claims would strand them (they could no longer sign in to act). Block it
  // so an admin resolves or reassigns those claims first.
  if (u.active && active != null && !isActive(active)) {
    const pending = await openClaimsAwaitingApprover(u.id);
    if (pending > 0) {
      return res.status(409).json({
        error: `This user is the current approver on ${pending} open claim${pending === 1 ? '' : 's'}. Resolve or reassign those before deactivating.`
      });
    }
  }
  await q(`UPDATE users SET username=$1, full_name=$2, role=$3, department=$4, position=$5, active=$6,
             bank_name=$7, recipient_name=$8, bank_account_no=$9, approver_ids=$10::int[], email=$11,
             can_mark_paid=$12 WHERE id=$13`, [
    nextUsername,
    full_name != null ? String(full_name).trim() : u.full_name,
    role || u.role,
    department != null ? String(department).trim() : u.department,
    position != null ? String(position).trim() : u.position,
    active != null ? isActive(active) : u.active,
    bank_name != null ? String(bank_name).trim() : u.bank_name,
    recipient_name != null ? String(recipient_name).trim() : u.recipient_name,
    bank_account_no != null ? String(bank_account_no).trim() : u.bank_account_no,
    intArrayLiteral(nextApprovers),
    nextEmail,
    can_mark_paid !== undefined ? isActive(can_mark_paid) : u.can_mark_paid,
    u.id
  ]);
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(String(password), 10), u.id]);
  }
  res.json({ ok: true });
}));

// Reset a single account's password. Superadmins may reset anyone (they also
// have the full edit form); delegated creators may reset only the accounts they
// manage (see canManageAccount). Deliberately narrower than PUT /api/users/:id
// so a delegated user cannot change role, department, approvers or active state.
app.post('/api/users/:id/reset-password', requireAuth, ah(async (req, res) => {
  const rows = await q('SELECT id, role, department, position FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManageAccount(req.user, target, await loadPositions())) {
    return res.status(403).json({ error: 'You do not have permission to reset this account\'s password' });
  }
  const password = (req.body && req.body.password) || '';
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(password), 10), target.id]);
  res.json({ ok: true });
}));

// Enable/disable a single account. Same delegated scope as reset-password.
// Applies the same stale-approver guard as the full edit form: an account that
// is the current approver on open claims can't be deactivated (it would strand
// those claims), so an admin must resolve or reassign them first.
app.post('/api/users/:id/set-active', requireAuth, ah(async (req, res) => {
  const rows = await q('SELECT id, role, department, position, active FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManageAccount(req.user, target, await loadPositions())) {
    return res.status(403).json({ error: 'You do not have permission to change this account' });
  }
  const next = isActive(req.body && req.body.active);
  if (target.active && !next) {
    const pending = await openClaimsAwaitingApprover(target.id);
    if (pending > 0) {
      return res.status(409).json({
        error: `This user is the current approver on ${pending} open claim${pending === 1 ? '' : 's'}. Resolve or reassign those before deactivating.`
      });
    }
  }
  await q('UPDATE users SET active = $1 WHERE id = $2', [next, target.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Settings: simple lookups (departments, job positions, expense types)
// ---------------------------------------------------------------------------
// Table names and flag column names are hard-coded (never user input), so
// interpolation is safe. `flags` lists extra BOOLEAN columns (e.g. the purpose
// gates allow_claim / allow_meal) that admins can toggle per row.
function lookupRoutes(pathName, table, flags = [], opts = {}) {
  // `opts.ranked` adds a `rank` column (a reorderable seniority ladder) — it is
  // selected, ordered by, and gets its own POST /reorder endpoint below.
  const ranked = !!opts.ranked;
  const orderBy = ranked ? 'rank, name' : 'name';
  const extraCols = ranked ? ['rank'] : [];
  // List — any signed-in user may read (the claim form needs departments and
  // expense types). Non-admins receive only the active entries.
  app.get(`/api/${pathName}`, requireAuth, ah(async (req, res) => {
    const onlyActive = req.user.role !== 'superadmin';
    const cols = ['id', 'name', 'active', ...flags, ...extraCols, 'created_at'].join(', ');
    const items = await q(
      `SELECT ${cols} FROM ${table}
       ${onlyActive ? 'WHERE active = TRUE' : ''} ORDER BY ${orderBy}`);
    res.json({ items: items.map(i => ({ ...i, created_at: iso(i.created_at) })) });
  }));

  // Reorder the whole ladder: body { order: [id, …] } sets rank = position + 1
  // for the listed ids, atomically. Only defined for ranked lookups.
  if (ranked) {
    app.post(`/api/${pathName}/reorder`, requireAuth, requireRole('superadmin'), ah(async (req, res) => {
      const order = (req.body && req.body.order) || [];
      if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of ids' });
      const ids = [];
      for (const v of order) { const n = Number(v); if (Number.isInteger(n) && n > 0) ids.push(n); }
      if (!ids.length) return res.status(400).json({ error: 'order must contain valid ids' });
      await transaction(ids.map((id, i) => qq(`UPDATE ${table} SET rank = $1 WHERE id = $2`, [i + 1, id])));
      res.json({ ok: true });
    }));
  }

  app.post(`/api/${pathName}`, requireAuth, requireRole('superadmin'), ah(async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const exists = await q(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1)`, [name]);
    if (exists[0]) return res.status(409).json({ error: 'That name already exists' });
    const rows = await q(`INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [name]);
    res.status(201).json({ id: rows[0].id });
  }));

  app.put(`/api/${pathName}/:id`, requireAuth, requireRole('superadmin'), ah(async (req, res) => {
    const rows = await q(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    const { name, active } = req.body || {};
    const newName = name != null ? String(name).trim() : item.name;
    if (!newName) return res.status(400).json({ error: 'Name is required' });
    if (newName.toLowerCase() !== item.name.toLowerCase()) {
      const dupe = await q(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND id <> $2`, [newName, item.id]);
      if (dupe[0]) return res.status(409).json({ error: 'That name already exists' });
    }
    // Build the SET clause dynamically so a caller can update just a flag.
    const sets = [];
    const params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    push('name', newName);
    push('active', active != null ? isActive(active) : item.active);
    for (const f of flags) {
      if (req.body && req.body[f] !== undefined) push(f, isActive(req.body[f]));
    }
    params.push(item.id);
    await q(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  }));

  app.delete(`/api/${pathName}/:id`, requireAuth, requireRole('superadmin'), ah(async (req, res) => {
    const rows = await q(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));
}
lookupRoutes('departments', 'departments', ['allow_claim', 'allow_meal']);
lookupRoutes('positions', 'job_positions', ['allow_claim', 'allow_meal', 'can_manage'], { ranked: true });
lookupRoutes('expense-types', 'expense_types');

// ---------------------------------------------------------------------------
// Static frontend + error handling
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 4 MB or smaller' : err.message;
    return res.status(400).json({ error: `Upload error: ${msg}` });
  }
  if (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || 'Request failed' });
  }
  next();
});

module.exports = app;
