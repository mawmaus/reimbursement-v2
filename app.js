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

async function loadUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  const rows = await q('SELECT id, username, full_name, role, department, active FROM users WHERE id = $1', [id]);
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
function baseClaim(row, attachments, history) {
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
    expense_type: row.expense_type,
    amount: Number(row.amount_cents) / 100,
    currency: row.currency,
    description: row.description,
    status: row.status,
    manager_comment: row.manager_comment,
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
  return rows.map(r => baseClaim(r, a[r.id], h[r.id]));
}
async function serializeOne(row) {
  return (await serializeMany([row]))[0];
}
async function loadClaimOr404(req, res) {
  const rows = await q('SELECT * FROM claims WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Claim not found' }); return null; }
  return rows[0];
}

const REQUIRED_FIELDS = ['claimant_name', 'expense_date', 'department', 'bank_name',
  'recipient_name', 'bank_account_no', 'expense_type'];

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
  res.json({ user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, department: user.department } });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/me', ah(async (req, res) => {
  const u = await loadUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: u });
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

  if (req.user.role === 'employee') add('employee_id = $$', req.user.id);
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
  const scope = req.user.role === 'employee' ? 'WHERE employee_id = $1' : '';
  const params = req.user.role === 'employee' ? [req.user.id] : [];
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
  if (req.user.role === 'employee' && row.employee_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only view your own claims' });
  }
  res.json({ claim: await serializeOne(row) });
}));

async function insertClaim(req, b, cents) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextClaimNo();
    try {
      const rows = await q(
        `INSERT INTO claims
          (claim_no, employee_id, claimant_name, expense_date, department, bank_name,
           recipient_name, bank_account_no, expense_type, amount_cents, currency, description, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'submitted') RETURNING id`,
        [claimNo, req.user.id, String(b.claimant_name).trim(), String(b.expense_date).trim(),
         String(b.department).trim(), String(b.bank_name).trim(), String(b.recipient_name).trim(),
         String(b.bank_account_no).trim(), String(b.expense_type).trim(), cents,
         String(b.currency || 'IDR').trim().slice(0, 8), String(b.description || '').trim()]);
      return rows[0].id;
    } catch (e) {
      const msg = String(e.message || '');
      if (e.code === '23505' || msg.includes('claim_no') || msg.includes('duplicate')) continue;
      throw e;
    }
  }
  throw new Error('Could not allocate a claim number — please try again');
}

app.post('/api/claims', requireAuth, requireRole('employee', 'admin', 'manager', 'finance'),
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
      const claimId = await insertClaim(req, b, cents);
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
  if (row.employee_id !== req.user.id && req.user.role !== 'admin') {
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
    await q(
      `UPDATE claims SET claimant_name=$1, expense_date=$2, department=$3, bank_name=$4,
         recipient_name=$5, bank_account_no=$6, expense_type=$7, amount_cents=$8, currency=$9,
         description=$10, status='submitted', manager_comment='', manager_id=NULL,
         decided_at=NULL, updated_at=now() WHERE id=$11`,
      [String(b.claimant_name).trim(), String(b.expense_date).trim(), String(b.department).trim(),
       String(b.bank_name).trim(), String(b.recipient_name).trim(), String(b.bank_account_no).trim(),
       String(b.expense_type).trim(), cents, String(b.currency || row.currency).trim().slice(0, 8),
       String(b.description || '').trim(), row.id]);
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

app.post('/api/claims/:id/approve', requireAuth, requireRole('manager', 'admin'), ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot approve a claim that is "${row.status}"` });
  const comment = String((req.body && req.body.comment) || '').trim();
  await q(`UPDATE claims SET status='approved', manager_id=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
    [req.user.id, comment, row.id]);
  await logHistory(row.id, req.user, 'approved', 'submitted', 'approved', comment);
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  res.json({ claim: await serializeOne(rows[0]) });
}));

app.post('/api/claims/:id/reject', requireAuth, requireRole('manager', 'admin'), ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  const comment = String((req.body && req.body.comment) || '').trim();
  if (!comment) return res.status(400).json({ error: 'A reason is required when rejecting a claim' });
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot reject a claim that is "${row.status}"` });
  await q(`UPDATE claims SET status='rejected', manager_id=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
    [req.user.id, comment, row.id]);
  await logHistory(row.id, req.user, 'rejected', 'submitted', 'rejected', comment);
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  res.json({ claim: await serializeOne(rows[0]) });
}));

app.post('/api/claims/:id/mark-paid', requireAuth, requireRole('finance', 'admin'), ah(async (req, res) => {
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
  if (req.user.role === 'employee' && row.employee_id !== req.user.id) {
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
// Export CSV (finance)
// ---------------------------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
app.get('/api/export.csv', requireAuth, requireRole('finance', 'admin'), ah(async (req, res) => {
  const { status, department, from, to } = req.query;
  const where = [];
  const params = [];
  const add = (col, op, val) => { params.push(val); where.push(`c.${col} ${op} $${params.length}`); };
  if (status) add('status', '=', status);
  if (department) add('department', '=', department);
  if (from) add('expense_date', '>=', from);
  if (to) add('expense_date', '<=', to);
  const rows = await q(
    `SELECT c.*, u.username AS employee_username FROM claims c JOIN users u ON u.id = c.employee_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at`, params);

  const headers = ['Claim No', 'Submitted By', 'Claimant Name', 'Expense Date', 'Department',
    'Bank Name', 'Recipient Name', 'Bank Account No', 'Expense Type', 'Amount', 'Currency',
    'Description', 'Status', 'Manager Comment', 'Decided At', 'Paid At', 'Created At'];
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([r.claim_no, r.employee_username, r.claimant_name, r.expense_date, r.department,
      r.bank_name, r.recipient_name, r.bank_account_no, r.expense_type,
      (Number(r.amount_cents) / 100).toFixed(2), r.currency, r.description, r.status,
      r.manager_comment, r.decided_at, r.paid_at, r.created_at].map(csvCell).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reimbursements-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------
const isActive = (v) => v === true || v === 1 || v === '1' || v === 'true';

app.get('/api/users', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const users = await q('SELECT id, username, full_name, role, department, active, created_at FROM users ORDER BY id');
  res.json({ users: users.map(u => ({ ...u, created_at: iso(u.created_at) })) });
}));
app.post('/api/users', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const { username, password, full_name, role, department } = req.body || {};
  if (!username || !password || !full_name || !role) return res.status(400).json({ error: 'username, password, full_name and role are required' });
  if (!['employee', 'manager', 'finance', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const exists = await q('SELECT 1 FROM users WHERE username = $1', [String(username).trim()]);
  if (exists[0]) return res.status(409).json({ error: 'Username already exists' });
  const rows = await q(
    `INSERT INTO users (username, password_hash, full_name, role, department) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [String(username).trim(), bcrypt.hashSync(String(password), 10), String(full_name).trim(), role, String(department || '').trim()]);
  res.status(201).json({ id: rows[0].id });
}));
app.put('/api/users/:id', requireAuth, requireRole('admin'), ah(async (req, res) => {
  const rows = await q('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { full_name, role, department, active, password } = req.body || {};
  if (role && !['employee', 'manager', 'finance', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await q(`UPDATE users SET full_name=$1, role=$2, department=$3, active=$4 WHERE id=$5`, [
    full_name != null ? String(full_name).trim() : u.full_name,
    role || u.role,
    department != null ? String(department).trim() : u.department,
    active != null ? isActive(active) : u.active,
    u.id
  ]);
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(String(password), 10), u.id]);
  }
  res.json({ ok: true });
}));

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
