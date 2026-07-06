'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { q } = require('./db');
const { uploadReceipt, deleteReceipt } = require('./lib/blob');

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
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
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
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
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
  const rows = await q('SELECT id, username, full_name, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids, active FROM users WHERE id = $1', [id]);
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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const loginAttempts = new Map();
const MAX_LOGIN_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginKey = (req) => req.ip || 'unknown';
function loginBlockedFor(req) {
  const rec = loginAttempts.get(loginKey(req));
  if (!rec) return 0;
  if (rec.fails >= MAX_LOGIN_FAILS && (Date.now() - rec.first) < LOGIN_WINDOW_MS) {
    return Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rec.first)) / 60000);
  }
  if ((Date.now() - rec.first) >= LOGIN_WINDOW_MS) loginAttempts.delete(loginKey(req));
  return 0;
}
function recordLoginFail(req) {
  const k = loginKey(req);
  const rec = loginAttempts.get(k);
  if (!rec || (Date.now() - rec.first) >= LOGIN_WINDOW_MS) loginAttempts.set(k, { fails: 1, first: Date.now() });
  else rec.fails += 1;
}

app.post('/api/login', ah(async (req, res) => {
  const blocked = loginBlockedFor(req);
  if (blocked > 0) return res.status(429).json({ error: `Too many failed attempts. Try again in ${blocked} min.` });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const rows = await q('SELECT * FROM users WHERE username = $1', [String(username).trim()]);
  const user = rows[0];
  if (!user || !user.active || !bcrypt.compareSync(String(password), user.password_hash)) {
    recordLoginFail(req);
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  loginAttempts.delete(loginKey(req));
  req.session.userId = user.id;
  res.json({ user: {
    id: user.id, username: user.username, full_name: user.full_name, role: user.role,
    department: user.department, position: user.position, purposes: await computePurposes(user)
  } });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', ah(async (req, res) => {
  const u = await loadUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: { ...u, purposes: await computePurposes(u) } });
}));

// Self-service profile: a user may edit their own bank / payout details (but
// not role, department, approvers, etc.).
app.put('/api/me', requireAuth, ah(async (req, res) => {
  const { bank_name, recipient_name, bank_account_no } = req.body || {};
  await q('UPDATE users SET bank_name = $1, recipient_name = $2, bank_account_no = $3 WHERE id = $4', [
    String(bank_name || '').trim(), String(recipient_name || '').trim(),
    String(bank_account_no || '').trim(), req.user.id]);
  const u = await loadUser(req);
  res.json({ user: { ...u, purposes: await computePurposes(u) } });
}));

app.post('/api/me/password', requireAuth, ah(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const rows = await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!bcrypt.compareSync(String(current_password || ''), rows[0].password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(new_password), 10), req.user.id]);
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
    where.push(`(claim_no ILIKE ${p} OR claimant_name ILIKE ${p} OR recipient_name ILIKE ${p} OR expense_type ILIKE ${p})`);
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

async function insertClaim(req, b, cents, approverIds) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextClaimNo();
    try {
      const rows = await q(
        `INSERT INTO claims
          (claim_no, employee_id, claimant_name, expense_date, department, db_no, bank_name,
           recipient_name, bank_account_no, expense_type, amount_cents, currency, description,
           status, approver_ids, current_step)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14::int[],$15) RETURNING id`,
        [claimNo, req.user.id, String(req.user.full_name || '').trim(), String(b.expense_date).trim(),
         String(req.user.department || '').trim(), String(b.db_no || '').trim(),
         String(req.user.bank_name || '').trim(),
         String(req.user.recipient_name || '').trim(), String(req.user.bank_account_no || '').trim(),
         String(b.expense_type).trim(), cents,
         String(b.currency || 'IDR').trim().slice(0, 8), String(b.description || '').trim(),
         intArrayLiteral(approverIds), approverIds.length ? 1 : 0]);
      return rows[0].id;
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
      const claimId = await insertClaim(req, b, cents, asIntArray(req.user.approver_ids));
      for (const u of uploaded) {
        await q(`INSERT INTO attachments (claim_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
                 VALUES ($1,$2,$3,$4,$5,$6)`, [claimId, u.url, u.pathname, u.original_name, u.mime, u.size]);
      }
      await logHistory(claimId, req.user, 'submitted', null, 'submitted', '');
      const rows = await q('SELECT * FROM claims WHERE id = $1', [claimId]);
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
    const approverIds = asIntArray(emp.approver_ids);
    await q(
      `UPDATE claims SET claimant_name=$1, expense_date=$2, department=$3, db_no=$4, bank_name=$5,
         recipient_name=$6, bank_account_no=$7, expense_type=$8, amount_cents=$9, currency=$10,
         description=$11, status='submitted', manager_comment='', manager_id=NULL,
         decided_at=NULL, approver_ids=$12::int[], current_step=$13, updated_at=now() WHERE id=$14`,
      [String(emp.full_name || '').trim(), String(b.expense_date).trim(), String(emp.department || '').trim(),
       String(b.db_no || '').trim(), String(emp.bank_name || '').trim(), String(emp.recipient_name || '').trim(),
       String(emp.bank_account_no || '').trim(),
       String(b.expense_type).trim(), cents, String(b.currency || row.currency).trim().slice(0, 8),
       String(b.description || '').trim(), intArrayLiteral(approverIds), approverIds.length ? 1 : 0, row.id]);
    for (const u of uploaded) {
      await q(`INSERT INTO attachments (claim_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
               VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, u.url, u.pathname, u.original_name, u.mime, u.size]);
    }
    await logHistory(row.id, req.user, 'resubmitted', 'rejected', 'submitted', String(b.resubmit_note || '').trim());
    const rows = await q('SELECT * FROM claims WHERE id = $1', [row.id]);
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
  res.json({ claim: await serializeOne(rows[0]) });
}));

app.post('/api/claims/:id/mark-paid', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved claims can be marked as paid' });
  await q(`UPDATE claims SET status='paid', paid_by=$1, paid_at=now(), updated_at=now() WHERE id=$2`, [req.user.id, row.id]);
  await logHistory(row.id, req.user, 'marked paid', 'approved', 'paid', String((req.body && req.body.comment) || '').trim());
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
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  res.send(Buffer.from(await r.arrayBuffer()));
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
    where.push(`(claim_no ILIKE ${p} OR claimant_name ILIKE ${p})`);
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

async function insertMealClaim(req, lines, totalCents, approverIds) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextMealClaimNo();
    try {
      const rows = await q(
        `INSERT INTO meal_claims
          (claim_no, employee_id, claimant_name, department, bank_name, recipient_name,
           bank_account_no, total_cents, currency, status, approver_ids, current_step)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10::int[],$11) RETURNING id`,
        [claimNo, req.user.id, String(req.user.full_name || '').trim(), String(req.user.department || '').trim(),
         String(req.user.bank_name || '').trim(), String(req.user.recipient_name || '').trim(),
         String(req.user.bank_account_no || '').trim(), totalCents, 'IDR',
         intArrayLiteral(approverIds), approverIds.length ? 1 : 0]);
      return rows[0].id;
    } catch (e) {
      const msg = String(e.message || '');
      if (e.code === '23505' || msg.includes('claim_no') || msg.includes('duplicate')) continue;
      throw e;
    }
  }
  throw new Error('Could not allocate a claim number — please try again');
}
async function insertMealLines(claimId, lines) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await q(
      `INSERT INTO meal_claim_lines (meal_claim_id, sort_order, line_date, site, job_category, amount_cents, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [claimId, i, l.line_date, l.site, l.job_category, l.amount_cents, l.description]);
  }
}

app.post('/api/meal-claims', requireAuth, ah(async (req, res) => {
  const parsed = normaliseMealLines((req.body || {}).lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const approverIds = asIntArray(req.user.approver_ids);
  const claimId = await insertMealClaim(req, parsed.lines, parsed.totalCents, approverIds);
  await insertMealLines(claimId, parsed.lines);
  await logMealHistory(claimId, req.user, 'submitted', null, 'submitted', '');
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [claimId]);
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
  const approverIds = asIntArray(emp.approver_ids);
  await q(
    `UPDATE meal_claims SET total_cents=$1, department=$2, bank_name=$3, recipient_name=$4,
       bank_account_no=$5, status='submitted', manager_comment='', manager_id=NULL, decided_at=NULL,
       approver_ids=$6::int[], current_step=$7, updated_at=now() WHERE id=$8`,
    [parsed.totalCents, String(emp.department || '').trim(), String(emp.bank_name || '').trim(),
     String(emp.recipient_name || '').trim(), String(emp.bank_account_no || '').trim(),
     intArrayLiteral(approverIds), approverIds.length ? 1 : 0, row.id]);
  await q('DELETE FROM meal_claim_lines WHERE meal_claim_id = $1', [row.id]);
  await insertMealLines(row.id, parsed.lines);
  await logMealHistory(row.id, req.user, 'resubmitted', 'rejected', 'submitted', String((req.body && req.body.resubmit_note) || '').trim());
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [row.id]);
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
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

app.post('/api/meal-claims/:id/mark-paid', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved meal claims can be marked as paid' });
  await q(`UPDATE meal_claims SET status='paid', paid_by=$1, paid_at=now(), updated_at=now() WHERE id=$2`, [req.user.id, row.id]);
  await logMealHistory(row.id, req.user, 'marked paid', 'approved', 'paid', String((req.body && req.body.comment) || '').trim());
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

// ---------------------------------------------------------------------------
// Export CSV (finance)
// ---------------------------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const EXPORT_STATUSES = ['submitted', 'approved', 'rejected', 'paid'];
// Export both reimbursement claims and meal allowance claims in one CSV.
// Filters: `status` (comma-separated, any of the four), `from`/`to` (inclusive,
// applied to each row's expense/meal date), and `types` (comma-separated:
// reimbursement, meal \u2014 defaults to both). Reimbursement claims export one row
// each; meal allowances export one row per line item (per day), so finance sees
// the full daily breakdown. A shared column set carries both.
app.get('/api/export.csv', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
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
const ROLES = ['superadmin', 'user'];
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

app.get('/api/users', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const users = await q('SELECT id, username, full_name, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids, active, created_at FROM users ORDER BY id');
  res.json({ users: users.map(u => ({ ...u, approver_ids: asIntArray(u.approver_ids), created_at: iso(u.created_at) })) });
}));
app.post('/api/users', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const { username, password, full_name, role, department, position,
    bank_name, recipient_name, bank_account_no, approver_ids } = req.body || {};
  if (!username || !password || !full_name || !role) return res.status(400).json({ error: 'username, password, full_name and role are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const exists = await q('SELECT 1 FROM users WHERE username = $1', [String(username).trim()]);
  if (exists[0]) return res.status(409).json({ error: 'Username already exists' });
  const rows = await q(
    `INSERT INTO users (username, password_hash, full_name, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::int[]) RETURNING id`,
    [String(username).trim(), bcrypt.hashSync(String(password), 10), String(full_name).trim(), role,
     String(department || '').trim(), String(position || '').trim(),
     String(bank_name || '').trim(), String(recipient_name || '').trim(),
     String(bank_account_no || '').trim(), intArrayLiteral(sanitizeApproverIds(approver_ids))]);
  res.status(201).json({ id: rows[0].id });
}));
app.put('/api/users/:id', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const rows = await q('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { username, full_name, role, department, position, active, password,
    bank_name, recipient_name, bank_account_no, approver_ids } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // Username can be changed, but must stay unique.
  let nextUsername = u.username;
  if (username != null && String(username).trim() && String(username).trim() !== u.username) {
    nextUsername = String(username).trim();
    const dupe = await q('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [nextUsername, u.id]);
    if (dupe[0]) return res.status(409).json({ error: 'Username already exists' });
  }
  const nextApprovers = approver_ids !== undefined
    ? sanitizeApproverIds(approver_ids, u.id) : asIntArray(u.approver_ids);
  await q(`UPDATE users SET username=$1, full_name=$2, role=$3, department=$4, position=$5, active=$6,
             bank_name=$7, recipient_name=$8, bank_account_no=$9, approver_ids=$10::int[] WHERE id=$11`, [
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
    u.id
  ]);
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(String(password), 10), u.id]);
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Settings: simple lookups (departments, job positions, expense types)
// ---------------------------------------------------------------------------
// Table names and flag column names are hard-coded (never user input), so
// interpolation is safe. `flags` lists extra BOOLEAN columns (e.g. the purpose
// gates allow_claim / allow_meal) that admins can toggle per row.
function lookupRoutes(pathName, table, flags = []) {
  // List — any signed-in user may read (the claim form needs departments and
  // expense types). Non-admins receive only the active entries.
  app.get(`/api/${pathName}`, requireAuth, ah(async (req, res) => {
    const onlyActive = req.user.role !== 'superadmin';
    const cols = ['id', 'name', 'active', ...flags, 'created_at'].join(', ');
    const items = await q(
      `SELECT ${cols} FROM ${table}
       ${onlyActive ? 'WHERE active = TRUE' : ''} ORDER BY name`);
    res.json({ items: items.map(i => ({ ...i, created_at: iso(i.created_at) })) });
  }));

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
lookupRoutes('positions', 'job_positions', ['allow_claim', 'allow_meal']);
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
