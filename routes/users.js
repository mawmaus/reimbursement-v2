'use strict';

// Account administration: list, create, edit, reset password, enable/disable,
// test email.

const express = require('express');
const bcrypt = require('bcryptjs');
const { q } = require('../db');
const { sendEmail, emailConfigured, layout, button } = require('../lib/email');
const { requireAuth, requireRole, requireCap, SET_PASSWORD_SQL, startSession } = require('../lib/auth');
const {
  ah, normEmail, EMAIL_RE, escHtml, baseUrl, intArrayLiteral, asIntArray, iso,
  isActive
} = require('../lib/util');
const { ALL_REGIONS, seesAllRegions, normRegion } = require('../lib/settings');
const {
  loadPositions, hasDelegation, accountsSeeAllDepts, ROLES, creatableRolesFor,
  canManageAccount
} = require('../lib/permissions');
const { parseApprovalLimit } = require('../lib/money');
const { openClaimsAwaitingApprover } = require('../lib/workflow');

const router = express.Router();

// Send a test email so an admin can confirm the Resend configuration works.
// Defaults to the admin's own account email; a recipient can be supplied.
router.post('/api/test-email', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
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
// An account's approvers must be in the same region as the account (All-regions
// accounts and All-regions approvers are unrestricted). Returns an error string
// if any listed approver is out of region, else '' when the chain is valid.
async function approversRegionError(ids, region) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length || region === ALL_REGIONS || !region) return '';
  const rows = await q(`SELECT region FROM users WHERE id = ANY($1::int[])`, [intArrayLiteral(list)]);
  for (const r of rows) {
    const rr = String(r.region || '');
    if (rr !== String(region) && rr !== ALL_REGIONS) return 'Approvers must be in the same region as the account';
  }
  return '';
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

router.get('/api/users', requireAuth, ah(async (req, res) => {
  const isSuper = req.user.role === 'superadmin';
  const pos = await loadPositions(req.user.region);
  // Superadmins read every account; admins and delegated seniors read only their
  // own department's accounts (to populate Manage-accounts) — except Director-and-
  // above positions, which read every department (region-bounded). Everyone else
  // is forbidden.
  if (!isSuper && !hasDelegation(req.user, pos)) {
    return res.status(403).json({ error: 'You do not have permission for this action' });
  }
  const cols = 'id, username, full_name, email, role, department, position, region, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid, allow_advance, approval_limit_cents, active, created_by, created_by_name, created_at';
  let users;
  if (isSuper) {
    users = await q(`SELECT ${cols} FROM users ORDER BY id`);
  } else {
    const where = [];
    const params = [];
    // Department scope: own department only, unless a Director-and-above position
    // (which sees every department).
    if (!accountsSeeAllDepts(req.user, pos)) {
      params.push(String(req.user.department || '').trim());
      where.push(`lower(department) = lower($${params.length})`);
    }
    // Region isolation: a region-scoped manager sees only same-region accounts.
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`region = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    users = await q(`SELECT ${cols} FROM users ${clause} ORDER BY id`, params);
  }
  res.json({ users: users.map(u => ({ ...u, approver_ids: asIntArray(u.approver_ids), approver1_options: asIntArray(u.approver1_options), created_at: iso(u.created_at) })) });
}));
// Account creation is super-admin only. Everyone else — including admins and
// senior positions — can no longer create accounts (they may still reset /
// enable-disable their team; see canManageAccount).
router.post('/api/users', requireAuth, requireCap('create_accounts'), ah(async (req, res) => {
  const isSuper = req.user.role === 'superadmin';
  const { username, password, full_name, email,
    bank_name, recipient_name, bank_account_no } = req.body || {};
  let { role, department, position, approver_ids, approver1_options } = req.body || {};
  if (!username || !password || !full_name || !role) return res.status(400).json({ error: 'username, password, full_name and role are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // Delegated creators (non-super) may only create accounts more junior than
  // themselves; a super admin may assign any role. Guards against self-escalation
  // regardless of what the client sent.
  if (!isSuper && !creatableRolesFor(req.user).includes(role)) {
    return res.status(403).json({ error: 'You cannot create an account with that role' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const nextEmail = normEmail(email);
  if (nextEmail && !EMAIL_RE.test(nextEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  const exists = await q('SELECT 1 FROM users WHERE username = $1', [String(username).trim()]);
  if (exists[0]) return res.status(409).json({ error: 'Username already exists' });
  if (nextEmail) {
    const dupe = await q('SELECT 1 FROM users WHERE lower(email) = $1', [nextEmail]);
    if (dupe[0]) return res.status(409).json({ error: 'That email is already used by another account' });
  }
  // Region: super admins / all-region creators choose any region (incl. All
  // regions); a region-scoped creator may only create accounts in their region.
  let region;
  if (seesAllRegions(req.user)) {
    region = await normRegion((req.body || {}).region);
    if (region === null) return res.status(400).json({ error: 'Invalid region' });
  } else {
    region = String(req.user.region || '');
  }
  if (!region) return res.status(400).json({ error: 'Region is required' });
  const apprIds = sanitizeApproverIds(approver_ids);
  const appr1Ids = sanitizeApproverIds(approver1_options);
  const are = await approversRegionError([...apprIds, ...appr1Ids], region);
  if (are) return res.status(400).json({ error: are });
  // Only a super admin may grant the mark-paid permission.
  const canMarkPaidFlag = isSuper && isActive((req.body || {}).can_mark_paid);
  // Same for the cash-advance grant: it is a per-account permission now, so a
  // delegated creator's accounts start without it and a super admin grants it.
  const allowAdvanceFlag = isSuper && isActive((req.body || {}).allow_advance);
  // Approval limit (cents; null = unlimited). Defaults to unlimited when the
  // caller omits both fields, preserving the historical any-amount behaviour.
  const limit = parseApprovalLimit(req.body || {});
  if (limit.error) return res.status(400).json({ error: limit.error });
  const rows = await q(
    `INSERT INTO users (username, password_hash, full_name, role, department, position, region, email, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid, allow_advance, approval_limit_cents, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::int[],$13::int[],$14,$15,$16,$17,$18) RETURNING id`,
    [String(username).trim(), bcrypt.hashSync(String(password), 10), String(full_name).trim(), role,
     String(department || '').trim(), String(position || '').trim(), region, nextEmail,
     String(bank_name || '').trim(), String(recipient_name || '').trim(),
     String(bank_account_no || '').trim(), intArrayLiteral(apprIds),
     intArrayLiteral(appr1Ids), canMarkPaidFlag, allowAdvanceFlag, limit.cents,
     req.user.id, req.user.full_name || req.user.username || '']);
  res.status(201).json({ id: rows[0].id });
}));
router.put('/api/users/:id', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const rows = await q('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { username, full_name, role, department, position, region, active, password, email,
    bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid,
    allow_advance } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // Checked up front: a refused edit must not have saved anything else.
  if (password && String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  let nextRegion = u.region;
  if (region !== undefined) {
    nextRegion = await normRegion(region);
    if (nextRegion === null) return res.status(400).json({ error: 'Invalid region' });
  }
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
  const nextApprover1Options = approver1_options !== undefined
    ? sanitizeApproverIds(approver1_options, u.id) : asIntArray(u.approver1_options);
  const areEdit = await approversRegionError([...nextApprovers, ...nextApprover1Options], nextRegion);
  if (areEdit) return res.status(400).json({ error: areEdit });
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
  // Approval limit: only change it when the caller actually sends the fields;
  // otherwise keep the account's existing limit.
  let nextLimit = u.approval_limit_cents;
  const b = req.body || {};
  if (Object.prototype.hasOwnProperty.call(b, 'approval_unlimited') ||
      Object.prototype.hasOwnProperty.call(b, 'approval_limit')) {
    const lim = parseApprovalLimit(b);
    if (lim.error) return res.status(400).json({ error: lim.error });
    nextLimit = lim.cents;
  }
  await q(`UPDATE users SET username=$1, full_name=$2, role=$3, department=$4, position=$5, active=$6,
             bank_name=$7, recipient_name=$8, bank_account_no=$9, approver_ids=$10::int[], email=$11,
             can_mark_paid=$12, approver1_options=$14::int[], region=$15, approval_limit_cents=$16,
             allow_advance=$17 WHERE id=$13`, [
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
    u.id,
    intArrayLiteral(nextApprover1Options),
    nextRegion,
    nextLimit,
    allow_advance !== undefined ? isActive(allow_advance) : u.allow_advance
  ]);
  if (password) {
    // Signs the account out everywhere (keeping the admin signed in if it is their own).
    const [{ session_version }] = await q(SET_PASSWORD_SQL, [bcrypt.hashSync(String(password), 10), u.id]);
    if (u.id === req.user.id) startSession(req, { id: u.id, session_version });
  }
  res.json({ ok: true });
}));

// Reset a single account's password. Superadmins may reset anyone (they also
// have the full edit form); delegated creators may reset only the accounts they
// manage (see canManageAccount). Deliberately narrower than PUT /api/users/:id
// so a delegated user cannot change role, department, approvers or active state.
router.post('/api/users/:id/reset-password', requireAuth, ah(async (req, res) => {
  const rows = await q('SELECT id, role, department, position, region FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManageAccount(req.user, target, await loadPositions(target.region))) {
    return res.status(403).json({ error: 'You do not have permission to reset this account\'s password' });
  }
  const password = (req.body && req.body.password) || '';
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  // Signs the account out everywhere (keeping the admin signed in if it is their own).
  const [{ session_version }] = await q(SET_PASSWORD_SQL, [bcrypt.hashSync(String(password), 10), target.id]);
  if (target.id === req.user.id) startSession(req, { id: target.id, session_version });
  res.json({ ok: true });
}));

// Enable/disable a single account. Same delegated scope as reset-password.
// Applies the same stale-approver guard as the full edit form: an account that
// is the current approver on open claims can't be deactivated (it would strand
// those claims), so an admin must resolve or reassign them first.
router.post('/api/users/:id/set-active', requireAuth, ah(async (req, res) => {
  const rows = await q('SELECT id, role, department, position, active, region FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManageAccount(req.user, target, await loadPositions(target.region))) {
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

module.exports = router;
