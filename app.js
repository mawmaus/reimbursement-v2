'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { q, qq, transaction } = require('./db');
const { uploadReceipt, deleteReceipt, presignReceiptUpload, statReceipt, RECEIPT_MAX_BYTES, BLOB_URL_RE } = require('./lib/blob');
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
// Attachments are limited to PDFs and images so they can be embedded cleanly in
// the generated claim PDF. Receipts are uploaded straight from the browser to
// Blob storage (see /api/uploads/presign) — the serverless function caps request
// bodies at ~4.5 MB, so routing large files through it was the source of 413s.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'
]);
const MAX_FILES = 8;

// Validate the receipts a claim references. The browser uploads each file
// directly to Blob, then sends back only { url, original_name }. We never trust
// that metadata: every URL must belong to our store, and we HEAD each blob to
// read its authoritative size and content type before linking it to a claim.
// Returns { items } on success or { error } on the first problem.
async function verifyAttachments(list) {
  if (list == null) return { items: [] };
  if (!Array.isArray(list)) return { error: 'Invalid receipts' };
  if (list.length > MAX_FILES) return { error: `Maximum ${MAX_FILES} files` };
  const items = [];
  for (const a of list) {
    const url = String((a && a.url) || '');
    if (!BLOB_URL_RE.test(url)) return { error: 'A receipt reference is invalid — please re-attach it' };
    let info;
    try { info = await statReceipt(url); }
    catch { return { error: 'A receipt upload could not be verified — please re-attach it and retry' }; }
    if (info.size > RECEIPT_MAX_BYTES) return { error: 'A receipt exceeds the size limit' };
    const mime = String(info.contentType || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return { error: `File type not allowed: ${info.contentType || 'unknown'}` };
    items.push({
      url,
      pathname: info.pathname,
      original_name: String((a && a.original_name) || info.pathname.split('/').pop() || 'file').slice(0, 200),
      mime,
      size: info.size
    });
  }
  return { items };
}

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

// Supported UI languages. A user's chosen language becomes their default and is
// stored on the account; anything unknown falls back to English.
const SUPPORTED_LANGS = ['en', 'id', 'th', 'vi', 'km', 'fil'];
const normLang = (v) => SUPPORTED_LANGS.includes(String(v || '')) ? String(v) : 'en';

// --- Regions (data-access scoping) ------------------------------------------
// An account belongs to one region (a regions.name value) or the sentinel '*'
// = All regions. Data is hidden outside the account's region; super admins and
// '*' accounts see everything. Regions are a managed lookup (Settings).
const ALL_REGIONS = '*';
function seesAllRegions(user) {
  return !!user && (user.role === 'superadmin' || user.region === ALL_REGIONS);
}
// Resolve a requested region to its canonical stored value: '*' stays '*'; a
// known active region name is returned with the lookup's casing; '' stays '';
// anything else -> null (invalid). Used when assigning a region to an account
// or an All-regions submitter's claim.
async function normRegion(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === ALL_REGIONS) return ALL_REGIONS;
  if (!s) return '';
  const rows = await q('SELECT name FROM regions WHERE lower(name) = lower($1) AND active = TRUE', [s]);
  return rows[0] ? rows[0].name : null;
}

// --- App-wide settings (key/value store) -----------------------------------
async function loadAppSettings() {
  const rows = await q('SELECT key, value FROM app_settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function setAppSetting(key, value) {
  await q(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value == null ? '' : value)]);
}

// --- Per-region defaults: currency + time zone ------------------------------
// Each region has a default currency (stamped onto new claims when the client
// doesn't specify one) and a default time zone (governs what counts as "today"
// for a claim's date and the claim-window floor). Stored as JSON in
// app_settings under `region_prefs_by_region`: { [regionName]: { currency, timezone } }.
// Regions without an entry — and All-regions/blank accounts — use the globals.
const DEFAULT_CURRENCY = 'IDR';
const DEFAULT_TIMEZONE = 'Asia/Jakarta';
// The currencies an admin may choose from (ISO 4217 codes for the countries the
// portal serves). The order is the display order in the settings dropdown.
const AVAILABLE_CURRENCIES = ['IDR', 'USD', 'THB', 'VND', 'KHR', 'MYR', 'KRW'];
const CURRENCY_SET = new Set(AVAILABLE_CURRENCIES);
// The time zones an admin may choose from. Kept to the regions the portal serves
// (plus USD/global) so the list stays short and every option is a valid IANA id.
const AVAILABLE_TIMEZONES = [
  'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Bangkok',
  'Asia/Ho_Chi_Minh', 'Asia/Manila', 'Asia/Phnom_Penh', 'Asia/Kuala_Lumpur',
  'Asia/Seoul', 'UTC'
];
const TIMEZONE_SET = new Set(AVAILABLE_TIMEZONES);
// Is `tz` a time zone the runtime accepts? (Defence in depth beyond the fixed
// list — an unknown id would throw when we format dates with it.)
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; }
  catch { return false; }
}
// Parse the stored region-prefs map (tolerant of malformed JSON).
function regionPrefsMap(settings) {
  try { return settings.region_prefs_by_region ? JSON.parse(settings.region_prefs_by_region) : {}; }
  catch { return {}; }
}
// The effective { currency, timezone } for a region, falling back to the global
// defaults. '*'/blank (All-regions accounts) always use the defaults.
function regionPrefs(settings, region) {
  const r = region && region !== ALL_REGIONS ? regionPrefsMap(settings)[region] : null;
  const currency = r && CURRENCY_SET.has(r.currency) ? r.currency : DEFAULT_CURRENCY;
  const timezone = r && isValidTimezone(r.timezone) ? r.timezone : DEFAULT_TIMEZONE;
  return { currency, timezone };
}
// Convenience: load settings and resolve a region's prefs in one call.
async function regionPrefsFor(region) {
  return regionPrefs(await loadAppSettings(), region);
}

// --- Role permissions (editable capability matrix) --------------------------
// Beyond the fixed role (superadmin/admin/user), a super admin can grant each
// role extra capabilities. These are ADDITIVE: they only widen what a user may
// do on top of what their job position / department / flags already allow. The
// matrix is stored as JSON in app_settings under `role_permissions`; superadmin
// is always all-true and never stored. Defaults reproduce the pre-matrix
// behaviour (admins could export CSV; everyone else nothing extra).
const CAPABILITIES = [
  { key: 'view_all_claims',   label: 'View all claims',            desc: 'See every claim in the system, not only their own or ones they approve.' },
  { key: 'mark_paid',         label: 'Mark claims as paid',        desc: 'Record and revert payments on approved claims.' },
  { key: 'delete_claims',     label: 'Delete claims',              desc: 'Permanently delete reimbursement or meal allowance claims.' },
  { key: 'export_csv',        label: 'Export claims to CSV',       desc: 'Download reimbursement, meal and realized cash-advance claims as a CSV file.' },
  { key: 'create_accounts',   label: 'Create accounts',            desc: 'Add new user accounts.' },
  { key: 'manage_accounts',   label: 'Manage accounts',            desc: 'Reset passwords and enable or disable accounts.' },
  { key: 'manage_settings',   label: 'Manage settings',            desc: 'Edit departments, job positions, expense types and the claim date limit.' },
  { key: 'view_insights_all', label: 'View company-wide insights', desc: 'Open expense insights across every department.' }
];
const CAPABILITY_KEYS = new Set(CAPABILITIES.map(c => c.key));
// Editable roles shown as rows in the region matrix (superadmin is implicit/all
// -on and never shown). Ordered senior → junior to match the workspace UI.
const EDITABLE_ROLES = ['admin', 'manager', 'lowmgmt', 'finance', 'employee'];
// Super Admins may configure Country Manager / Managing Director, Mid
// Management, Low Management, and Finance permissions for each region. The
// Employee baseline stays locked.
const REGION_EDITABLE_ROLES = ['admin', 'manager', 'lowmgmt', 'finance'];
// A CM/MD (admin) may also open the region matrix, but only for the rows below
// their own — Mid/Low/Finance — never the admin row (self-escalation) or the
// locked Employee baseline. Which rows an actor may toggle depends on their role.
const CMMD_EDITABLE_ROLES = ['manager', 'lowmgmt', 'finance'];
function editableRolesFor(user) {
  if (!user) return [];
  if (user.role === 'superadmin') return REGION_EDITABLE_ROLES;
  if (user.role === 'admin') return CMMD_EDITABLE_ROLES;
  return [];
}
// Only capabilities set true here are granted by default; everything else false.
// New roles start with nothing — configure them per region in the matrix.
const ROLE_DEFAULTS = { admin: { export_csv: true }, manager: {}, lowmgmt: {}, finance: {}, employee: {} };

// Fill a raw stored matrix into a complete { role: { cap: bool } }, taking each
// missing entry from `fallback` (another filled matrix) or, failing that, from
// ROLE_DEFAULTS. Lets a region matrix inherit from the global defaults.
function fillMatrix(stored, fallback) {
  const out = {};
  for (const role of EDITABLE_ROLES) {
    out[role] = {};
    const s = (stored && stored[role]) || {};
    const fb = (fallback && fallback[role]) || null;
    for (const c of CAPABILITIES) {
      out[role][c.key] = Object.prototype.hasOwnProperty.call(s, c.key) ? !!s[c.key]
        : fb ? !!fb[c.key]
        : !!ROLE_DEFAULTS[role][c.key];
    }
  }
  return out;
}
// The global default matrix (app_settings.role_permissions), normalised. Serves
// as the fallback for any region without its own overrides.
function loadGlobalRolePerms(settings) {
  let stored = {};
  try { stored = settings.role_permissions ? JSON.parse(settings.role_permissions) : {}; }
  catch { stored = {}; }
  return fillMatrix(stored, null);
}
// The effective matrix for one region: that region's stored overrides layered on
// top of the global defaults. '*'/blank (All-regions accounts) use the globals.
async function loadRolePermsForRegion(region, settings) {
  settings = settings || await loadAppSettings();
  const global = loadGlobalRolePerms(settings);
  if (!region || region === ALL_REGIONS) return global;
  let byRegion = {};
  try { byRegion = settings.role_permissions_by_region ? JSON.parse(settings.role_permissions_by_region) : {}; }
  catch { byRegion = {}; }
  return fillMatrix(byRegion[region], global);
}
// Flatten the matrix into this user's own capability map. Superadmins get all.
function capsFor(user, perms) {
  const isSuper = user && user.role === 'superadmin';
  const out = {};
  for (const c of CAPABILITIES) out[c.key] = isSuper ? true : !!(perms[user.role] && perms[user.role][c.key]);
  return out;
}
// Attach the computed capability map to a user object so the sync helpers below
// and the client payload can read it; returns the map. Caps come from the
// account's own region matrix (falling back to the global defaults).
async function attachCaps(user) {
  if (!user) return {};
  user.caps = capsFor(user, await loadRolePermsForRegion(user.region));
  return user.caps;
}
// Does this user hold a capability? Relies on caps being attached (attachCaps /
// requireAuth). Superadmin always passes even if caps were not attached.
function userCan(user, cap) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  return !!(user.caps && user.caps[cap]);
}

// --- Claim date policy ------------------------------------------------------
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
// Today's date (YYYY-MM-DD) in a given time zone — matches the client's
// todayWIB() so a late-evening submission doesn't roll to "tomorrow" via UTC.
// Defaults to the global time zone; a region's own zone is passed in when known.
function todayInZone(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
// Subtract n whole days from a YYYY-MM-DD string (date-only arithmetic in UTC).
function subDaysISO(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
// The claim-date policy for a region: its saved window if any, else the global
// claim_max_age_days / claim_earliest_date defaults. Returns the two raw setting
// values so the helpers below can treat region and global policy identically.
function claimWindowSettings(settings, region) {
  let byRegion = {};
  try { byRegion = settings.claim_window_by_region ? JSON.parse(settings.claim_window_by_region) : {}; }
  catch { byRegion = {}; }
  const r = region && region !== ALL_REGIONS ? byRegion[region] : null;
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  return {
    claim_max_age_days: has(r, 'max_age_days') ? r.max_age_days : settings.claim_max_age_days,
    claim_earliest_date: has(r, 'earliest_date') ? r.earliest_date : settings.claim_earliest_date,
    // "Today" for the rolling window is measured in the region's own time zone.
    timezone: regionPrefs(settings, region).timezone
  };
}
// The earliest expense date a claim may carry under a resolved policy, or null
// when unrestricted. A rolling window (N days back from today) and an absolute
// cutoff can both be set; the effective floor is the later (max) of the two.
function claimEarliestFrom(cw) {
  const bounds = [];
  const days = parseInt(cw.claim_max_age_days, 10);
  if (Number.isFinite(days) && days > 0) bounds.push(subDaysISO(todayInZone(cw.timezone), days));
  if (isISODate(cw.claim_earliest_date)) bounds.push(cw.claim_earliest_date);
  if (!bounds.length) return null;
  return bounds.reduce((a, b) => (a > b ? a : b));
}
// Reject a set of expense/line dates if any falls before the policy floor for the
// submitter's `region`. Returns { earliest, error } on violation, or null when
// all dates are allowed.
async function claimDateViolation(dates, region) {
  const cw = claimWindowSettings(await loadAppSettings(), region);
  const earliest = claimEarliestFrom(cw);
  if (!earliest) return null;
  const bad = dates.some(d => isISODate(d) && d < earliest);
  return bad ? { earliest, error: `Expenses dated before ${earliest} can no longer be claimed.` } : null;
}
// Response shape for the claim-date policy (shared by GET/PUT /api/claim-window),
// for a given region.
function claimWindowView(settings, region) {
  const cw = claimWindowSettings(settings, region);
  const days = parseInt(cw.claim_max_age_days, 10);
  return {
    max_age_days: Number.isFinite(days) && days > 0 ? days : null,
    earliest_date: isISODate(cw.claim_earliest_date) ? cw.claim_earliest_date : null,
    earliest: claimEarliestFrom(cw)
  };
}

async function loadUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  const rows = await q('SELECT id, username, full_name, email, role, department, position, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid, approval_limit_cents, language, region, active FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}
const requireAuth = ah(async (req, res, next) => {
  const u = await loadUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  await attachCaps(u);
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
// Like requireRole, but gates on an editable capability from the role matrix.
// Must run after requireAuth (which attaches req.user.caps).
function requireCap(cap) {
  return (req, res, next) => {
    if (!userCan(req.user, cap)) {
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
// Format a cents amount for a human-readable message, optionally prefixed with a
// currency code. Whole numbers show no decimals; others up to two.
function fmtMoney(cents, currency) {
  const s = (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}
// Resolve an account's approval limit from a request body into cents, where null
// means unlimited. `approval_unlimited` truthy — or a blank/absent amount —
// means unlimited (so callers that omit the fields keep the any-amount default);
// otherwise the `approval_limit` amount must be a valid non-negative number.
// Returns { cents } (cents may be null) or { error }.
function parseApprovalLimit(body) {
  if (isActive(body.approval_unlimited)) return { cents: null };
  if (body.approval_limit == null || String(body.approval_limit).trim() === '') return { cents: null };
  const cents = parseAmountToCents(body.approval_limit);
  if (cents === null) return { error: 'Approval limit must be a non-negative amount' };
  return { cents };
}
// Block an approver from acting on a claim above their approval limit. Super
// admins are exempt (they override the chain anyway); a null limit is unlimited.
// Returns an error string, or null when the approval is allowed.
function approvalLimitError(user, amountCents, currency) {
  if (!user || user.role === 'superadmin') return null;
  const limit = user.approval_limit_cents;
  if (limit == null) return null;
  if (Number(amountCents) > Number(limit)) {
    return `This claim (${fmtMoney(amountCents, currency)}) is above your approval limit of ${fmtMoney(limit, currency)}.`;
  }
  return null;
}
async function nextClaimNo() {
  const year = new Date().getFullYear();
  // Derive from the highest existing suffix, not COUNT(*): a deleted claim
  // would otherwise make the count point at an already-used number, colliding
  // on every retry (see the createClaim retry loop).
  const rows = await q(
    `SELECT COALESCE(MAX(SUBSTRING(claim_no FROM '[0-9]+$')::int), 0) AS n
       FROM claims WHERE claim_no LIKE $1`,
    [`RC-${year}-%`]);
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
function baseClaim(row, attachments, lines, attByLine, history, nameMap) {
  const attView = (a) => ({
    id: a.id, original_name: a.original_name, mime_type: a.mime_type,
    size_bytes: a.size_bytes, uploaded_at: iso(a.uploaded_at)
  });
  return {
    id: row.id,
    claim_no: row.claim_no,
    employee_id: row.employee_id,
    claimant_name: row.claimant_name,
    expense_date: row.expense_date,
    department: row.department,
    region: row.region || '',
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
    // Flat list of every receipt on the claim (kept for anything reading the
    // whole set, e.g. counts); per-line receipts live under `lines`.
    attachments: (attachments || []).map(attView),
    lines: (lines || []).map(l => ({
      id: l.id, line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: Number(l.amount_cents) / 100, description: l.description,
      attachments: ((attByLine && attByLine[l.id]) || []).map(attView)
    })),
    history: (history || []).map(h => ({
      actor_id: h.actor_id == null ? null : Number(h.actor_id),
      actor_name: h.actor_name, action: h.action, from_status: h.from_status,
      to_status: h.to_status, comment: h.comment, created_at: iso(h.created_at)
    }))
  };
}
// Batch-load lines, attachments + history for many claims.
async function serializeMany(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const atts = await q(
    `SELECT id, claim_id, line_id, original_name, mime_type, size_bytes, uploaded_at
     FROM attachments WHERE claim_id IN (${ph}) ORDER BY id`, ids);
  const lines = await q(
    `SELECT id, claim_id, sort_order, line_date, db_no, expense_type, amount_cents, description
     FROM claim_lines WHERE claim_id IN (${ph}) ORDER BY sort_order, id`, ids);
  const hist = await q(
    `SELECT claim_id, actor_id, actor_name, action, from_status, to_status, comment, created_at
     FROM claim_history WHERE claim_id IN (${ph}) ORDER BY id`, ids);
  const a = groupBy(atts, 'claim_id');
  const attByLine = groupBy(atts, 'line_id');
  const l = groupBy(lines, 'claim_id');
  const h = groupBy(hist, 'claim_id');

  // Batch-load the names for every distinct approver referenced across claims.
  const approverIds = [...new Set(rows.flatMap(r => asIntArray(r.approver_ids)))];
  const nameMap = {};
  if (approverIds.length) {
    const aph = approverIds.map((_, i) => `$${i + 1}`).join(',');
    const us = await q(`SELECT id, full_name FROM users WHERE id IN (${aph})`, approverIds);
    for (const u of us) nameMap[u.id] = u.full_name;
  }
  return rows.map(r => baseClaim(r, a[r.id], l[r.id], attByLine, h[r.id], nameMap));
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
  return user.role === 'superadmin' || user.can_mark_paid === true || userCan(user, 'mark_paid');
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

// Build the ordered, still-active approver id list for a claim being submitted or
// resubmitted. `optionsRaw` is the account's chooseable-Approver-1 candidate pool
// and `baseRaw` its fixed chain. Behaviour keys off how many candidates are still
// active:
//   • none   → the chain is just the fixed list (legacy behaviour).
//   • one    → that candidate is Approver 1 automatically (no choice needed).
//   • two+   → the submitter must have picked one (`chosenRaw`) as Approver 1.
// The resulting Approver 1 is prepended to the fixed chain (de-duplicated).
// Returns { ids } on success or { error } when a required choice is missing or
// invalid — the caller maps that to a 400. Async because it filters out
// deactivated accounts (which could never act on the claim).
async function resolveSubmitApprovers(optionsRaw, baseRaw, chosenRaw) {
  const [activeOpts, base] = await Promise.all([
    activeApproverIds(optionsRaw),
    activeApproverIds(baseRaw),
  ]);
  if (!activeOpts.length) return { ids: base };
  let first;
  if (activeOpts.length === 1) {
    first = activeOpts[0];
  } else {
    const chosen = Number(chosenRaw);
    if (!Number.isInteger(chosen) || !activeOpts.includes(chosen)) {
      return { error: 'Please choose an Approver 1 for this claim' };
    }
    first = chosen;
  }
  return { ids: [first, ...base.filter(id => id !== first)] };
}

// How many still-open (submitted) claims — reimbursement + meal — have this user
// as the approver whose turn it currently is. Postgres arrays are 1-based, and
// current_step is 1-based, so approver_ids[current_step] is the pending approver.
async function openClaimsAwaitingApprover(userId) {
  const [reimb, meal, adv] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM claims
       WHERE status = 'submitted' AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId]),
    q(`SELECT COUNT(*)::int AS n FROM meal_claims
       WHERE status = 'submitted' AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId]),
    q(`SELECT COUNT(*)::int AS n FROM cash_advances
       WHERE status IN ('submitted','realize_submitted') AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId])
  ]);
  return Number(reimb[0].n) + Number(meal[0].n) + Number(adv[0].n);
}

// --- Front-page purposes ----------------------------------------------------
// Which "purpose" buttons (New Claim / New Meal Allowance) a user may see. A
// purpose is visible only when it is enabled on BOTH the user's department and
// their job position (AND). Unknown/blank department or position => nothing.
async function computePurposes(user) {
  const empty = { claim: false, meal: false, advance: false };
  // Superadmins can do everything: always show all three purpose buttons,
  // regardless of their own department/position/region flags.
  if (user.role === 'superadmin') return { claim: true, meal: true, advance: true };
  const dept = String(user.department || '').trim();
  const pos = String(user.position || '').trim();
  if (!dept || !pos) return empty;
  // Match the lookups in the user's own region; All-regions/blank accounts fall
  // back to matching any region's row.
  const region = String(user.region || '');
  const concrete = region && region !== ALL_REGIONS;
  const [drows, prows] = await Promise.all([
    concrete
      ? q('SELECT allow_claim, allow_meal, allow_advance FROM departments   WHERE lower(name) = lower($1) AND region = $2 AND active = TRUE', [dept, region])
      : q('SELECT allow_claim, allow_meal, allow_advance FROM departments   WHERE lower(name) = lower($1) AND active = TRUE', [dept]),
    concrete
      ? q('SELECT allow_claim, allow_meal, allow_advance FROM job_positions WHERE lower(name) = lower($1) AND region = $2 AND active = TRUE', [pos, region])
      : q('SELECT allow_claim, allow_meal, allow_advance FROM job_positions WHERE lower(name) = lower($1) AND active = TRUE', [pos])
  ]);
  const d = drows[0], p = prows[0];
  if (!d || !p) return empty;
  return {
    claim: !!(d.allow_claim && p.allow_claim),
    meal: !!(d.allow_meal && p.allow_meal),
    advance: !!(d.allow_advance && p.allow_advance)
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
async function loadPositions(region) {
  // Ranks are per region now: load the ladder for a concrete region, or every
  // row (All-regions / unspecified — names collide, last wins) otherwise.
  const concrete = region && region !== ALL_REGIONS;
  const rows = concrete
    ? await q('SELECT name, rank, can_manage FROM job_positions WHERE region = $1', [region])
    : await q('SELECT name, rank, can_manage FROM job_positions');
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
  if (userCan(user, 'manage_accounts')) return true;
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
// junior Supervisor whether that Supervisor is an employee or an admin), while
// still protecting superadmins and anyone at or above the actor's own rank.
// (Account *creation* is gated by the create_accounts capability — see POST.)
function canManageAccount(actor, target, pos) {
  if (actor.role === 'superadmin') return true;
  if (!hasDelegation(actor, pos)) return false;
  if (target.role === 'superadmin') return false;
  // Region isolation: a region-scoped actor manages only same-region accounts.
  if (!seesAllRegions(actor) && String(target.region || '') !== String(actor.region || '')) return false;
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
const SUPERVISOR_FALLBACK_RANK = 10;
const isFinanceDept = (dept) => /financ/i.test(String(dept || ''));
// True when `user`'s position ranks at or above `posName` (or the given fallback
// rank if that position isn't on the ladder). rank 1 is the most senior, so
// "at or above" means a rank number <= the threshold.
function rankAtLeast(user, pos, posName, fallbackRank) {
  const t = positionRank(posName, pos);
  const threshold = t === Infinity ? fallbackRank : t;
  const r = positionRank(user.position, pos);
  return r !== Infinity && r <= threshold;
}
// Who may open the Insights view at all: super admins, anyone in a Finance
// department (any position), and any position ranked Supervisor or above.
function insightsCanView(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (userCan(user, 'view_insights_all')) return true;
  if (isFinanceDept(user.department)) return true;
  return rankAtLeast(user, pos, 'supervisor', SUPERVISOR_FALLBACK_RANK);
}
// Of those who can view, who sees company-wide data vs. only their own
// department: super admins, Finance, and any position ranked General Manager or
// above. Everyone else (Supervisor .. below-GM) is scoped to their department.
function insightsSeeAll(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (userCan(user, 'view_insights_all')) return true;
  if (isFinanceDept(user.department)) return true;
  return rankAtLeast(user, pos, 'general manager', GM_FALLBACK_RANK);
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
  const pos = await loadPositions(user.region);
  await attachCaps(user);
  res.json({ user: {
    id: user.id, username: user.username, full_name: user.full_name, role: user.role, email: user.email,
    department: user.department, position: user.position, can_mark_paid: !!user.can_mark_paid,
    language: normLang(user.language), region: user.region || '',
    ...(await regionPrefsFor(user.region)),
    purposes: await computePurposes(user), creatable_positions: creatablePositions(user, pos),
    approver1_choices: await approver1Choices(user.approver1_options),
    can_manage_accounts: hasDelegation(user, pos), can_view_insights: insightsCanView(user, pos),
    caps: user.caps
  } });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

// Resolve an account's chooseable-Approver-1 candidate pool to [{id, name}],
// keeping only still-active accounts (an inactive one could never approve) and
// preserving the configured order. Empty for accounts without the feature.
async function approver1Choices(optionsRaw) {
  const ids = asIntArray(optionsRaw);
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rows = await q(
    `SELECT id, full_name, username FROM users WHERE id IN (${ph}) AND active = TRUE`, ids);
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  return ids.filter(id => byId.has(id)).map(id => {
    const r = byId.get(id);
    return { id, name: r.full_name || r.username || `User #${id}` };
  });
}

app.get('/api/me', ah(async (req, res) => {
  const u = await loadUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'Not signed in' });
  const pos = await loadPositions(u.region);
  await attachCaps(u);
  res.json({ user: { ...u, language: normLang(u.language), ...(await regionPrefsFor(u.region)), purposes: await computePurposes(u), creatable_positions: creatablePositions(u, pos),
    approver1_choices: await approver1Choices(u.approver1_options),
    can_manage_accounts: hasDelegation(u, pos), can_view_insights: insightsCanView(u, pos), caps: u.caps } });
}));

// Self-service profile: a user may edit their own bank / payout details (but
// not role, department, approvers, etc.).
app.put('/api/me', requireAuth, ah(async (req, res) => {
  const body = req.body || {};
  // Language-only updates (from the language switcher) skip the bank/email fields
  // so switching language never touches or requires the rest of the profile.
  if (Object.prototype.hasOwnProperty.call(body, 'language') && Object.keys(body).length === 1) {
    await q('UPDATE users SET language = $1 WHERE id = $2', [normLang(body.language), req.user.id]);
    const u = await loadUser(req);
    const pos = await loadPositions(u.region);
    await attachCaps(u);
    return res.json({ user: { ...u, language: normLang(u.language), ...(await regionPrefsFor(u.region)), purposes: await computePurposes(u),
      creatable_positions: creatablePositions(u, pos), approver1_choices: await approver1Choices(u.approver1_options),
      can_manage_accounts: hasDelegation(u, pos), can_view_insights: insightsCanView(u, pos), caps: u.caps } });
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
  const pos = await loadPositions(u.region);
  await attachCaps(u);
  res.json({ user: { ...u, language: normLang(u.language), ...(await regionPrefsFor(u.region)), purposes: await computePurposes(u), creatable_positions: creatablePositions(u, pos),
    approver1_choices: await approver1Choices(u.approver1_options),
    can_manage_accounts: hasDelegation(u, pos), can_view_insights: insightsCanView(u, pos), caps: u.caps } });
}));

// Claim-date policy: how far back an expense may be dated and still be claimable.
// Scoped per region: a submitter reads their own region's policy (the claim form
// needs it to validate); a super admin reads/edits any region via ?region /
// body.region. Only accounts that can manage settings change it, and region
// -scoped managers only for their own region.
app.get('/api/claim-window', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  res.json(claimWindowView(await loadAppSettings(), region));
}));

app.put('/api/claim-window', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  // Rolling window in days: a positive integer, or blank/0 to disable.
  let days = '';
  if (b.max_age_days != null && String(b.max_age_days).trim() !== '') {
    const n = parseInt(b.max_age_days, 10);
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      return res.status(400).json({ error: 'Maximum age must be a whole number of days between 0 and 3650' });
    }
    days = n > 0 ? String(n) : '';
  }
  // Absolute earliest date (YYYY-MM-DD), or blank to disable.
  let earliest = '';
  if (b.earliest_date != null && String(b.earliest_date).trim() !== '') {
    if (!isISODate(String(b.earliest_date).trim())) {
      return res.status(400).json({ error: 'Earliest date must be a valid date' });
    }
    earliest = String(b.earliest_date).trim();
  }
  // Persist under the region's key, layered over the global defaults.
  const settings = await loadAppSettings();
  let byRegion = {};
  try { byRegion = settings.claim_window_by_region ? JSON.parse(settings.claim_window_by_region) : {}; }
  catch { byRegion = {}; }
  byRegion[region] = { max_age_days: days, earliest_date: earliest };
  await setAppSetting('claim_window_by_region', JSON.stringify(byRegion));
  res.json(claimWindowView({ ...settings, claim_window_by_region: JSON.stringify(byRegion) }, region));
}));

// Per-region default currency + time zone. Read by any signed-in user for their
// own region (the claim form needs the default currency); a super admin may read
// any region via ?region. Edited by Super Admins (any region) and Country
// Managers / Managing Directors (their own region only) — the same audience as
// the region role matrix.
function canManageRegionPrefs(user) {
  return !!user && (user.role === 'superadmin' || user.role === 'admin');
}
// The response shape shared by GET/PUT: the region's effective prefs plus the
// option lists the settings dropdowns render from.
function regionPrefsView(settings, region) {
  const prefs = regionPrefs(settings, region);
  return { region, ...prefs, currencies: AVAILABLE_CURRENCIES, timezones: AVAILABLE_TIMEZONES };
}

app.get('/api/region-prefs', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  res.json(regionPrefsView(await loadAppSettings(), region));
}));

app.put('/api/region-prefs', requireAuth, ah(async (req, res) => {
  if (!canManageRegionPrefs(req.user)) return res.status(403).json({ error: 'You do not have permission for this action' });
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  const currency = String(b.currency || '').trim();
  if (!CURRENCY_SET.has(currency)) return res.status(400).json({ error: 'Choose a valid currency' });
  const timezone = String(b.timezone || '').trim();
  if (!TIMEZONE_SET.has(timezone) || !isValidTimezone(timezone)) return res.status(400).json({ error: 'Choose a valid time zone' });
  const settings = await loadAppSettings();
  const byRegion = regionPrefsMap(settings);
  byRegion[region] = { currency, timezone };
  await setAppSetting('region_prefs_by_region', JSON.stringify(byRegion));
  res.json(regionPrefsView({ ...settings, region_prefs_by_region: JSON.stringify(byRegion) }, region));
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

  if (!userCan(req.user, 'view_all_claims')) {
    params.push(req.user.id);
    const p = `$${params.length}`;
    where.push(`(employee_id = ${p} OR ${p} = ANY(approver_ids))`);
  }
  if (!seesAllRegions(req.user)) {
    params.push(req.user.region || '');
    where.push(`region = $${params.length}`);
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
  const where = [];
  const params = [];
  if (!userCan(req.user, 'view_all_claims')) {
    params.push(req.user.id);
    where.push(`(employee_id = $${params.length} OR $${params.length} = ANY(approver_ids))`);
  }
  if (!seesAllRegions(req.user)) {
    params.push(req.user.region || '');
    where.push(`region = $${params.length}`);
  }
  const scope = where.length ? 'WHERE ' + where.join(' AND ') : '';
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
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own claims' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own claims' });
  }
  res.json({ claim: await serializeOne(row) });
}));

// Sequences backing claims.id / claim_lines.id, so later inserts in the same
// transaction can reference the just-created rows via currval().
const CLAIM_SEQ = "pg_get_serial_sequence('claims','id')";
const LINE_SEQ = "pg_get_serial_sequence('claim_lines','id')";

// Validate the itemised lines of a reimbursement claim. Each filled row needs a
// date, an expense type and a positive amount; DB no + description are optional.
// Blank rows are skipped. Attachment references (new uploads + kept ids) ride
// along untouched for the caller to verify. Returns { lines, totalCents } or
// { error }.
function normaliseClaimLines(input) {
  if (!Array.isArray(input)) return { error: 'Add at least one expense line' };
  const lines = [];
  let totalCents = 0;
  for (const raw of input) {
    const r = raw || {};
    const date = String(r.line_date || r.expense_date || r.date || '').trim();
    const db_no = String(r.db_no || '').trim();
    const expense_type = String(r.expense_type || '').trim();
    const description = String(r.description || r.desc || '').trim();
    const cents = parseAmountToCents(r.amount);
    const rawAttachments = Array.isArray(r.attachments) ? r.attachments : [];
    const keepIds = asIntArray(r.keep_attachment_ids);
    const blank = !date && !db_no && !expense_type && !description
      && (cents === null || cents === 0) && !rawAttachments.length && !keepIds.length;
    if (blank) continue;
    if (!date) return { error: 'Every filled row needs a date' };
    if (!expense_type) return { error: 'Every filled row needs an expense type' };
    if (cents === null || cents <= 0) return { error: 'Every filled row needs a positive amount' };
    totalCents += cents;
    lines.push({ line_date: date, db_no, expense_type, amount_cents: cents, description, rawAttachments, keepIds });
  }
  if (!lines.length) return { error: 'Add at least one expense line with a date, type and amount' };
  return { lines, totalCents };
}
// Aggregate header fields kept on the claims row so the list, CSV and search
// keep working off the header: earliest date, the type ("Multiple" for >1 line),
// the first DB no, and — only for a single-line claim — its description.
function claimHeaderFromLines(lines) {
  const dates = lines.map(l => l.line_date).filter(Boolean).sort();
  return {
    expense_date: dates[0] || '',
    expense_type: lines.length === 1 ? lines[0].expense_type : 'Multiple',
    db_no: lines[0].db_no || '',
    description: lines.length === 1 ? lines[0].description : ''
  };
}

// Create an itemised claim — header, its lines, each line's receipts and the
// initial history row — as one atomic transaction. `verifiedByLine[i]` is the
// verified upload list for line i. Retries on a claim_no collision.
async function createClaim(req, header, lines, verifiedByLine, totalCents, approverIds, region) {
  const h = claimHeaderFromLines(lines);
  // Default the currency to the region's configured default when the client
  // doesn't send one.
  const defaultCurrency = (await regionPrefsFor(region)).currency;
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextClaimNo();
    const queries = [qq(
      `INSERT INTO claims
        (claim_no, employee_id, claimant_name, expense_date, department, db_no, bank_name,
         recipient_name, bank_account_no, expense_type, amount_cents, currency, description,
         status, approver_ids, current_step, region)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14::int[],$15,$16)`,
      [claimNo, req.user.id, String(req.user.full_name || '').trim(), h.expense_date,
       String(req.user.department || '').trim(), h.db_no,
       String(req.user.bank_name || '').trim(),
       String(req.user.recipient_name || '').trim(), String(req.user.bank_account_no || '').trim(),
       h.expense_type, totalCents,
       String(header.currency || defaultCurrency).trim().slice(0, 8), h.description,
       intArrayLiteral(approverIds), approverIds.length ? 1 : 0, String(region || '')])];
    lines.forEach((l, i) => {
      queries.push(qq(
        `INSERT INTO claim_lines (claim_id, sort_order, line_date, db_no, expense_type, amount_cents, description)
         VALUES (currval(${CLAIM_SEQ}),$1,$2,$3,$4,$5,$6)`,
        [i, l.line_date, l.db_no, l.expense_type, l.amount_cents, l.description]));
      for (const u of (verifiedByLine[i] || [])) {
        queries.push(qq(
          `INSERT INTO attachments (claim_id, line_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
           VALUES (currval(${CLAIM_SEQ}), currval(${LINE_SEQ}),$1,$2,$3,$4,$5)`,
          [u.url, u.pathname, u.original_name, u.mime, u.size]));
      }
    });
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

// Issue presigned upload URLs so the browser can upload receipts directly to
// Blob storage, bypassing the serverless function's ~4.5 MB request-body limit.
// Returns one URL per requested file, in the same order.
app.post('/api/uploads/presign', requireAuth, ah(async (req, res) => {
  const files = Array.isArray(req.body && req.body.files) ? req.body.files : null;
  if (!files || !files.length) return res.status(400).json({ error: 'No files to upload' });
  if (files.length > MAX_FILES) return res.status(400).json({ error: `Maximum ${MAX_FILES} files` });
  const allowed = [...ALLOWED_MIME];
  const uploads = [];
  for (const f of files) {
    const type = String((f && f.type) || '').toLowerCase();
    if (!ALLOWED_MIME.has(type)) return res.status(400).json({ error: `File type not allowed: ${type || 'unknown'}` });
    if ((Number(f && f.size) || 0) > RECEIPT_MAX_BYTES) {
      return res.status(413).json({ error: `${(f && f.name) || 'A file'} exceeds the size limit` });
    }
    uploads.push(await presignReceiptUpload(f && f.name, type, allowed));
  }
  res.json({ uploads });
}));

// Same-origin upload path: the browser POSTs the raw file bytes to our own
// domain and we forward them to Blob. This is the reliable default for files
// that fit under the function's ~4.5 MB body limit — some networks (and iOS
// setups) can reach *.vercel.app but not the vercel.com host the presigned
// direct-upload URLs point at, so routing through our origin avoids that.
app.post('/api/uploads/direct', requireAuth,
  express.raw({ type: () => true, limit: '4400kb' }), ah(async (req, res) => {
    const name = String(req.query.name || 'file');
    const type = String(req.query.type || '').toLowerCase();
    if (!ALLOWED_MIME.has(type)) return res.status(400).json({ error: `File type not allowed: ${type || 'unknown'}` });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: 'Empty upload' });
    const r = await uploadReceipt(buf, name, type);
    res.json({ url: r.url, pathname: r.pathname, size: buf.length, contentType: type });
  }));

app.post('/api/claims', requireAuth, ah(async (req, res) => {
    const b = req.body || {};
    const parsed = normaliseClaimLines(b.lines);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    // Enforce the claim-date policy across every line's date.
    const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region);
    if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
    // Resolve the approver chain (validating the chosen Approver 1) before we
    // link any receipts, so a bad/missing choice fails cleanly.
    const built = await resolveSubmitApprovers(req.user.approver1_options, req.user.approver_ids, b.approver1);
    if (built.error) return res.status(400).json({ error: built.error });

    // Receipts were uploaded straight to Blob by the browser; verify each line's
    // set, then roll them all back if the claim insert fails.
    const verifiedByLine = [];
    const allUploaded = [];
    for (const line of parsed.lines) {
      const checked = await verifyAttachments(line.rawAttachments);
      if (checked.error) { for (const u of allUploaded) await deleteReceipt(u.url); return res.status(400).json({ error: checked.error }); }
      verifiedByLine.push(checked.items);
      allUploaded.push(...checked.items);
    }
    // Region is glued to the account — every claim inherits the submitter's.
    const claimRegion = String(req.user.region || '');
    try {
      const claimId = await createClaim(req, b, parsed.lines, verifiedByLine, parsed.totalCents, built.ids, claimRegion);
      const rows = await q('SELECT * FROM claims WHERE id = $1', [claimId]);
      const first = currentApproverId(rows[0]);
      if (first) await notifyPendingApprover(first, reimbNotify(rows[0]));
      res.status(201).json({ claim: await serializeOne(rows[0]) });
    } catch (e) {
      for (const u of allUploaded) await deleteReceipt(u.url);
      throw e;
    }
  }));

app.put('/api/claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (row.employee_id !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You can only edit your own claims' });
  }
  if (row.status !== 'rejected') {
    return res.status(409).json({ error: 'Only rejected claims can be edited and resubmitted' });
  }
  const b = req.body || {};
  const parsed = normaliseClaimLines(b.lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region);
  if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });

  // Existing receipts, keyed by id, so kept ones can be re-linked (to the same
  // blob) onto the new lines. Each line carries keep_attachment_ids + new uploads.
  const existingAtts = await q(
    'SELECT id, blob_url, blob_pathname, original_name, mime_type, size_bytes FROM attachments WHERE claim_id = $1', [row.id]);
  const byId = new Map(existingAtts.map(a => [Number(a.id), a]));
  const keptSet = new Set();
  const verifiedByLine = [];
  const allUploaded = [];
  for (const line of parsed.lines) {
    const checked = await verifyAttachments(line.rawAttachments);
    if (checked.error) { for (const u of allUploaded) await deleteReceipt(u.url); return res.status(400).json({ error: checked.error }); }
    verifiedByLine.push(checked.items);
    allUploaded.push(...checked.items);
    for (const id of line.keepIds) if (byId.has(id)) keptSet.add(id);
  }
  const dropped = existingAtts.filter(a => !keptSet.has(Number(a.id)));
  try {
    // Claimant name, department, bank details + approvers come from the account.
    const emp = (await q(
      'SELECT full_name, department, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options FROM users WHERE id = $1',
      [row.employee_id]))[0] || {};
    const built = await resolveSubmitApprovers(emp.approver1_options, emp.approver_ids, b.approver1);
    if (built.error) { for (const u of allUploaded) await deleteReceipt(u.url); return res.status(400).json({ error: built.error }); }
    const claimId = Number(row.id);
    const h = claimHeaderFromLines(parsed.lines);
    // Wipe the old lines + receipt rows, then rebuild both. Kept receipts are
    // re-inserted pointing at the SAME blob (only dropped blobs are deleted, after
    // commit). Attachments are cleared first so the claim_lines delete can't
    // cascade them away.
    const queries = [
      qq(`UPDATE claims SET claimant_name=$1, expense_date=$2, department=$3, db_no=$4, bank_name=$5,
            recipient_name=$6, bank_account_no=$7, expense_type=$8, amount_cents=$9, currency=$10,
            description=$11, status='submitted', manager_comment='', manager_id=NULL,
            decided_at=NULL, approver_ids=$12::int[], current_step=$13, updated_at=now() WHERE id=$14`,
        [String(emp.full_name || '').trim(), h.expense_date, String(emp.department || '').trim(),
         h.db_no, String(emp.bank_name || '').trim(), String(emp.recipient_name || '').trim(),
         String(emp.bank_account_no || '').trim(),
         h.expense_type, parsed.totalCents, String(b.currency || row.currency).trim().slice(0, 8),
         h.description, intArrayLiteral(built.ids), built.ids.length ? 1 : 0, claimId]),
      qq('DELETE FROM attachments WHERE claim_id = $1', [claimId]),
      qq('DELETE FROM claim_lines WHERE claim_id = $1', [claimId])
    ];
    parsed.lines.forEach((l, i) => {
      queries.push(qq(
        `INSERT INTO claim_lines (claim_id, sort_order, line_date, db_no, expense_type, amount_cents, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [claimId, i, l.line_date, l.db_no, l.expense_type, l.amount_cents, l.description]));
      const insertAtt = (url, pathname, name, mime, size) => queries.push(qq(
        `INSERT INTO attachments (claim_id, line_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
         VALUES ($1, currval(${LINE_SEQ}),$2,$3,$4,$5,$6)`, [claimId, url, pathname, name, mime, size]));
      for (const id of l.keepIds) {
        const a = byId.get(id);
        if (a && keptSet.has(id)) insertAtt(a.blob_url, a.blob_pathname, a.original_name, a.mime_type, a.size_bytes);
      }
      for (const u of verifiedByLine[i]) insertAtt(u.url, u.pathname, u.original_name, u.mime, u.size);
    });
    queries.push(qq(
      `INSERT INTO claim_history (claim_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES ($1,$2,$3,'resubmitted','rejected','submitted',$4)`,
      [claimId, req.user.id, String(req.user.full_name || '').trim(), String(b.resubmit_note || '').trim()]));
    await transaction(queries);
    // Only once committed do we bin the blobs of the removed receipts (a blob
    // delete can't be rolled back). A failure here must not reach the catch.
    for (const a of dropped) { try { await deleteReceipt(a.blob_url); } catch { /* ignore */ } }
    const rows = await q('SELECT * FROM claims WHERE id = $1', [row.id]);
    const first = currentApproverId(rows[0]);
    if (first) await notifyPendingApprover(first, reimbNotify(rows[0]));
    res.json({ claim: await serializeOne(rows[0]) });
  } catch (e) {
    for (const u of allUploaded) await deleteReceipt(u.url);
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
  const le = approvalLimitError(req.user, row.amount_cents, row.currency);
  if (le) return res.status(403).json({ error: le });
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
app.delete('/api/claims/:id', requireAuth, requireCap('delete_claims'), ah(async (req, res) => {
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
  // Highest existing suffix + 1, not COUNT(*) — same deletion-collision reason
  // as nextClaimNo.
  const rows = await q(
    `SELECT COALESCE(MAX(SUBSTRING(claim_no FROM '[0-9]+$')::int), 0) AS n
       FROM meal_claims WHERE claim_no LIKE $1`,
    [`MA-${year}-%`]);
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
    department: row.department, region: row.region || '', bank_name: row.bank_name,
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
      actor_id: h.actor_id == null ? null : Number(h.actor_id),
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
    `SELECT meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment, created_at
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
  if (!userCan(req.user, 'view_all_claims')) {
    params.push(req.user.id);
    const p = `$${params.length}`;
    where.push(`(employee_id = ${p} OR ${p} = ANY(approver_ids))`);
  }
  if (!seesAllRegions(req.user)) {
    params.push(req.user.region || '');
    where.push(`region = $${params.length}`);
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
  const where = [];
  const params = [];
  if (!userCan(req.user, 'view_all_claims')) {
    params.push(req.user.id);
    where.push(`(employee_id = $${params.length} OR $${params.length} = ANY(approver_ids))`);
  }
  if (!seesAllRegions(req.user)) {
    params.push(req.user.region || '');
    where.push(`region = $${params.length}`);
  }
  const scope = where.length ? 'WHERE ' + where.join(' AND ') : '';
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
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own meal claims' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own meal claims' });
  }
  res.json({ claim: await serializeOneMeal(row) });
}));

// Delete a meal allowance claim outright (super admin only) — removes its line
// items and history first. For clearing test data; no undo.
app.delete('/api/meal-claims/:id', requireAuth, requireCap('delete_claims'), ah(async (req, res) => {
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
async function createMealClaim(req, lines, totalCents, approverIds, region) {
  const currency = (await regionPrefsFor(region)).currency;
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextMealClaimNo();
    const queries = [qq(
      `INSERT INTO meal_claims
        (claim_no, employee_id, claimant_name, department, bank_name, recipient_name,
         bank_account_no, total_cents, currency, status, approver_ids, current_step, region)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10::int[],$11,$12)`,
      [claimNo, req.user.id, String(req.user.full_name || '').trim(), String(req.user.department || '').trim(),
       String(req.user.bank_name || '').trim(), String(req.user.recipient_name || '').trim(),
       String(req.user.bank_account_no || '').trim(), totalCents, currency,
       intArrayLiteral(approverIds), approverIds.length ? 1 : 0, String(region || '')])];
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
  const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region);
  if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  const built = await resolveSubmitApprovers(req.user.approver1_options, req.user.approver_ids, (req.body || {}).approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  const approverIds = built.ids;
  // Region is glued to the account — every claim inherits the submitter's.
  const claimRegion = String(req.user.region || '');
  const claimId = await createMealClaim(req, parsed.lines, parsed.totalCents, approverIds, claimRegion);
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
  const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region);
  if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  // Bank details + approvers come from the claimant's account.
  const emp = (await q(
    'SELECT full_name, department, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options FROM users WHERE id = $1',
    [row.employee_id]))[0] || {};
  const built = await resolveSubmitApprovers(emp.approver1_options, emp.approver_ids, (req.body || {}).approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  const approverIds = built.ids;
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
  const le = approvalLimitError(req.user, row.total_cents, row.currency);
  if (le) return res.status(403).json({ error: le });
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
// Cash advances
// A two-phase document (see schema.js). Phase 1 (request: purpose + amount) and
// phase 2 (realization: itemised actual transactions with receipts) each run the
// submitter's approver chain, reusing userCanApprove / currentApproverId. The
// approve/reject endpoints are phase-aware (they branch on the current status).
// ---------------------------------------------------------------------------
const ADV_SEQ = "pg_get_serial_sequence('cash_advances','id')";
const ADV_LINE_SEQ = "pg_get_serial_sequence('cash_advance_lines','id')";

async function nextAdvanceNo() {
  const year = new Date().getFullYear();
  const rows = await q(
    `SELECT COALESCE(MAX(SUBSTRING(advance_no FROM '[0-9]+$')::int), 0) AS n
       FROM cash_advances WHERE advance_no LIKE $1`,
    [`CA-${year}-%`]);
  return `CA-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}
async function logAdvanceHistory(advanceId, actor, action, fromStatus, toStatus, comment = '') {
  await q(
    `INSERT INTO cash_advance_history (advance_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [advanceId, actor.id, actor.full_name, action, fromStatus, toStatus, comment]);
}
function advanceNotify(row) {
  return { claimNo: row.advance_no, claimantName: row.claimant_name,
    typeLabel: 'cash advance', amount: Number(row.amount_cents) / 100, currency: row.currency };
}
function baseAdvance(row, lines, attByLine, history, nameMap) {
  const attView = (a) => ({
    id: a.id, original_name: a.original_name, mime_type: a.mime_type,
    size_bytes: a.size_bytes, uploaded_at: iso(a.uploaded_at)
  });
  return {
    id: row.id, type: 'advance',
    claim_no: row.advance_no, advance_no: row.advance_no,
    employee_id: row.employee_id, claimant_name: row.claimant_name,
    department: row.department, region: row.region || '',
    bank_name: row.bank_name, recipient_name: row.recipient_name, bank_account_no: row.bank_account_no,
    purpose: row.purpose,
    amount: Number(row.amount_cents) / 100,
    realized_total: Number(row.realized_total_cents) / 100,
    settlement: Number(row.settlement_cents) / 100,
    settlement_direction: row.settlement_direction || '',
    settlement_note: row.settlement_note || '',
    settled_by: row.settled_by == null ? null : Number(row.settled_by),
    settled_at: iso(row.settled_at),
    currency: row.currency, status: row.status,
    manager_comment: row.manager_comment,
    manager_id: row.manager_id == null ? null : Number(row.manager_id),
    paid_by: row.paid_by == null ? null : Number(row.paid_by),
    approvers: asIntArray(row.approver_ids).map(id => ({ id, name: (nameMap && nameMap[id]) || `User #${id}` })),
    current_step: row.current_step || 0,
    decided_at: iso(row.decided_at), paid_at: iso(row.paid_at),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    lines: (lines || []).map(l => ({
      id: l.id, line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: Number(l.amount_cents) / 100, description: l.description,
      attachments: ((attByLine && attByLine[l.id]) || []).map(attView)
    })),
    history: (history || []).map(h => ({
      actor_id: h.actor_id == null ? null : Number(h.actor_id),
      actor_name: h.actor_name, action: h.action, from_status: h.from_status,
      to_status: h.to_status, comment: h.comment, created_at: iso(h.created_at)
    }))
  };
}
async function serializeManyAdvance(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const lines = await q(
    `SELECT id, advance_id, sort_order, line_date, db_no, expense_type, amount_cents, description
     FROM cash_advance_lines WHERE advance_id IN (${ph}) ORDER BY sort_order, id`, ids);
  const lineIds = lines.map(l => l.id);
  let atts = [];
  if (lineIds.length) {
    const aph = lineIds.map((_, i) => `$${i + 1}`).join(',');
    atts = await q(
      `SELECT id, advance_line_id, original_name, mime_type, size_bytes, uploaded_at
       FROM attachments WHERE advance_line_id IN (${aph}) ORDER BY id`, lineIds);
  }
  const hist = await q(
    `SELECT advance_id, actor_id, actor_name, action, from_status, to_status, comment, created_at
     FROM cash_advance_history WHERE advance_id IN (${ph}) ORDER BY id`, ids);
  const l = groupBy(lines, 'advance_id');
  const attByLine = groupBy(atts, 'advance_line_id');
  const h = groupBy(hist, 'advance_id');
  const approverIds = [...new Set(rows.flatMap(r => asIntArray(r.approver_ids)))];
  const nameMap = {};
  if (approverIds.length) {
    const aph = approverIds.map((_, i) => `$${i + 1}`).join(',');
    const us = await q(`SELECT id, full_name FROM users WHERE id IN (${aph})`, approverIds);
    for (const u of us) nameMap[u.id] = u.full_name;
  }
  return rows.map(r => baseAdvance(r, l[r.id], attByLine, h[r.id], nameMap));
}
async function serializeOneAdvance(row) { return (await serializeManyAdvance([row]))[0]; }
async function loadAdvanceOr404(req, res) {
  const rows = await q('SELECT * FROM cash_advances WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Cash advance not found' }); return null; }
  return rows[0];
}

// Validate a cash-advance request: a non-empty purpose and a positive amount.
function normaliseAdvanceRequest(body) {
  const b = body || {};
  const purpose = String(b.purpose || '').trim();
  if (!purpose) return { error: 'A purpose for the cash advance is required' };
  const cents = parseAmountToCents(b.amount);
  if (cents === null || cents <= 0) return { error: 'Enter the advance amount' };
  // A blank currency means "use the region default"; the caller resolves it.
  return { purpose, amountCents: cents, currency: String(b.currency || '').trim().slice(0, 8) };
}

// Create a cash-advance request (phase 1). No lines yet; those arrive at
// realization. Retries on an advance_no collision (see createClaim).
async function createCashAdvance(req, purpose, amountCents, currency, approverIds, region) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const advanceNo = await nextAdvanceNo();
    const queries = [qq(
      `INSERT INTO cash_advances
        (advance_no, employee_id, claimant_name, department, region, bank_name, recipient_name,
         bank_account_no, purpose, amount_cents, currency, status, approver_ids, current_step)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'submitted',$12::int[],$13)`,
      [advanceNo, req.user.id, String(req.user.full_name || '').trim(), String(req.user.department || '').trim(),
       String(region || ''), String(req.user.bank_name || '').trim(), String(req.user.recipient_name || '').trim(),
       String(req.user.bank_account_no || '').trim(), purpose, amountCents, currency,
       intArrayLiteral(approverIds), approverIds.length ? 1 : 0])];
    queries.push(qq(
      `INSERT INTO cash_advance_history (advance_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES (currval(${ADV_SEQ}),$1,$2,'submitted',NULL,'submitted','')`,
      [req.user.id, String(req.user.full_name || '').trim()]));
    queries.push(qq(`SELECT currval(${ADV_SEQ})::int AS id`));
    try {
      const results = await transaction(queries);
      return results[results.length - 1][0].id;
    } catch (e) {
      const msg = String(e.message || '');
      if (e.code === '23505' || msg.includes('advance_no') || msg.includes('duplicate')) continue;
      throw e;
    }
  }
  throw new Error('Could not allocate an advance number — please try again');
}

app.post('/api/cash-advances', requireAuth, ah(async (req, res) => {
  const parsed = normaliseAdvanceRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const built = await resolveSubmitApprovers(req.user.approver1_options, req.user.approver_ids, (req.body || {}).approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  const region = String(req.user.region || '');
  const currency = parsed.currency || (await regionPrefsFor(region)).currency;
  const id = await createCashAdvance(req, parsed.purpose, parsed.amountCents, currency, built.ids, region);
  const rows = await q('SELECT * FROM cash_advances WHERE id = $1', [id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, advanceNotify(rows[0]));
  res.status(201).json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Edit + resubmit a rejected cash-advance request (phase 1 only).
app.put('/api/cash-advances/:id', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.employee_id !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You can only edit your own cash advances' });
  }
  if (row.status !== 'rejected') {
    return res.status(409).json({ error: 'Only rejected cash-advance requests can be edited and resubmitted' });
  }
  const parsed = normaliseAdvanceRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const emp = (await q(
    'SELECT full_name, department, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options FROM users WHERE id = $1',
    [row.employee_id]))[0] || {};
  const built = await resolveSubmitApprovers(emp.approver1_options, emp.approver_ids, (req.body || {}).approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  await q(
    `UPDATE cash_advances SET claimant_name=$1, department=$2, bank_name=$3, recipient_name=$4,
       bank_account_no=$5, purpose=$6, amount_cents=$7, currency=$8, status='submitted',
       manager_comment='', manager_id=NULL, decided_at=NULL, approver_ids=$9::int[], current_step=$10, updated_at=now()
     WHERE id=$11`,
    [String(emp.full_name || '').trim(), String(emp.department || '').trim(), String(emp.bank_name || '').trim(),
     String(emp.recipient_name || '').trim(), String(emp.bank_account_no || '').trim(),
     parsed.purpose, parsed.amountCents,
     parsed.currency || row.currency || (await regionPrefsFor(row.region)).currency, intArrayLiteral(built.ids),
     built.ids.length ? 1 : 0, row.id]);
  await logAdvanceHistory(row.id, req.user, 'resubmitted', 'rejected', 'submitted', String((req.body || {}).resubmit_note || '').trim());
  const rows = await q('SELECT * FROM cash_advances WHERE id = $1', [row.id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, advanceNotify(rows[0]));
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Approve — phase-aware: advances the request chain (submitted → approved) or the
// realization chain (realize_submitted → realize_approved).
app.post('/api/cash-advances/:id/approve', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  const realizing = row.status === 'realize_submitted';
  if (row.status !== 'submitted' && !realizing) {
    return res.status(409).json({ error: `Cannot approve a cash advance that is "${row.status}"` });
  }
  if (!userCanApprove(req.user, row)) return res.status(403).json({ error: 'You are not the approver for this step' });
  const amountForLimit = realizing ? row.realized_total_cents : row.amount_cents;
  const le = approvalLimitError(req.user, amountForLimit, row.currency);
  if (le) return res.status(403).json({ error: le });
  const comment = String((req.body && req.body.comment) || '').trim();
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  const finalise = req.user.role === 'superadmin' || !ids.length || step >= ids.length;
  const finalStatus = realizing ? 'realize_approved' : 'approved';
  const phase = realizing ? 'realization ' : '';
  if (finalise) {
    await q(`UPDATE cash_advances SET status=$1, manager_id=$2, manager_comment=$3, decided_at=now(), updated_at=now() WHERE id=$4`,
      [finalStatus, req.user.id, comment, row.id]);
    await logAdvanceHistory(row.id, req.user, ids.length ? `${phase}approved — step ${step} of ${ids.length}` : `${phase}approved`, row.status, finalStatus, comment);
  } else {
    await q(`UPDATE cash_advances SET current_step=$1, updated_at=now() WHERE id=$2`, [step + 1, row.id]);
    await logAdvanceHistory(row.id, req.user, `${phase}approved — step ${step} of ${ids.length}`, row.status, row.status, comment);
  }
  const rows = await q('SELECT * FROM cash_advances WHERE id=$1', [row.id]);
  if (finalise) await notifyClaimantDecision(rows[0].employee_id, advanceNotify(rows[0]), 'approved');
  else { const next = currentApproverId(rows[0]); if (next) await notifyPendingApprover(next, advanceNotify(rows[0])); }
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Reject — phase-aware: submitted → rejected, realize_submitted → rejected_realize.
app.post('/api/cash-advances/:id/reject', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  const comment = String((req.body && req.body.comment) || '').trim();
  if (!comment) return res.status(400).json({ error: 'A reason is required when rejecting a cash advance' });
  const realizing = row.status === 'realize_submitted';
  if (row.status !== 'submitted' && !realizing) {
    return res.status(409).json({ error: `Cannot reject a cash advance that is "${row.status}"` });
  }
  if (!userCanApprove(req.user, row)) return res.status(403).json({ error: 'You are not the approver for this cash advance' });
  const toStatus = realizing ? 'rejected_realize' : 'rejected';
  await q(`UPDATE cash_advances SET status=$1, manager_id=$2, manager_comment=$3, decided_at=now(), updated_at=now() WHERE id=$4`,
    [toStatus, req.user.id, comment, row.id]);
  await logAdvanceHistory(row.id, req.user, realizing ? 'realization rejected' : 'rejected', row.status, toStatus, comment);
  const rows = await q('SELECT * FROM cash_advances WHERE id=$1', [row.id]);
  await notifyClaimantRejected(rows[0].employee_id, { ...advanceNotify(rows[0]), reason: comment });
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Disburse the approved advance (phase 1 → paid). Unlocks realization.
app.post('/api/cash-advances/:id/mark-paid', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to mark cash advances as paid' });
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved cash advances can be marked as paid' });
  const paymentDate = String((req.body && req.body.payment_date) || '').trim();
  if (!DATE_RE.test(paymentDate)) return res.status(400).json({ error: 'A payment date is required to mark a cash advance as paid' });
  await q(`UPDATE cash_advances SET status='paid', paid_by=$1, paid_at=$2, updated_at=now() WHERE id=$3`, [req.user.id, paymentDate, row.id]);
  await logAdvanceHistory(row.id, req.user, `advance paid — ${paymentDate}`, 'approved', 'paid', String((req.body && req.body.comment) || '').trim());
  const rows = await q('SELECT * FROM cash_advances WHERE id=$1', [row.id]);
  await notifyClaimantDecision(rows[0].employee_id, advanceNotify(rows[0]), 'paid');
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Submit or resubmit the realization (phase 2): the itemised actual transactions
// with per-line receipts. Allowed from 'paid' (first realization) or
// 'rejected_realize' (edit after a rejected realization). Rebuilds the lines +
// receipts and re-enters the approver chain at step 1.
async function submitRealization(req, res, row) {
  if (row.employee_id !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You can only realize your own cash advances' });
  }
  const b = req.body || {};
  const parsed = normaliseClaimLines(b.lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), row.region);
  if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  // Approver chain is re-resolved from the claimant's account, like a fresh submit.
  const emp = (await q(
    'SELECT approver_ids, approver1_options FROM users WHERE id = $1', [row.employee_id]))[0] || {};
  const built = await resolveSubmitApprovers(emp.approver1_options, emp.approver_ids, b.approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  // Existing realization receipts (keyed by id) so kept ones survive an edit.
  const existingAtts = await q(
    `SELECT a.id, a.blob_url, a.blob_pathname, a.original_name, a.mime_type, a.size_bytes
       FROM attachments a JOIN cash_advance_lines l ON a.advance_line_id = l.id WHERE l.advance_id = $1`, [row.id]);
  const byId = new Map(existingAtts.map(a => [Number(a.id), a]));
  const keptSet = new Set();
  const verifiedByLine = [];
  const allUploaded = [];
  for (const line of parsed.lines) {
    const checked = await verifyAttachments(line.rawAttachments);
    if (checked.error) { for (const u of allUploaded) await deleteReceipt(u.url); return res.status(400).json({ error: checked.error }); }
    verifiedByLine.push(checked.items);
    allUploaded.push(...checked.items);
    for (const id of line.keepIds) if (byId.has(id)) keptSet.add(id);
  }
  const dropped = existingAtts.filter(a => !keptSet.has(Number(a.id)));
  const advanceId = Number(row.id);
  const resubmit = row.status === 'rejected_realize';
  try {
    const queries = [
      qq(`UPDATE cash_advances SET status='realize_submitted', realized_total_cents=$1,
            manager_comment='', manager_id=NULL, decided_at=NULL,
            approver_ids=$2::int[], current_step=$3, updated_at=now() WHERE id=$4`,
        [parsed.totalCents, intArrayLiteral(built.ids), built.ids.length ? 1 : 0, advanceId]),
      qq(`DELETE FROM attachments WHERE advance_line_id IN (SELECT id FROM cash_advance_lines WHERE advance_id = $1)`, [advanceId]),
      qq('DELETE FROM cash_advance_lines WHERE advance_id = $1', [advanceId])
    ];
    parsed.lines.forEach((l, i) => {
      queries.push(qq(
        `INSERT INTO cash_advance_lines (advance_id, sort_order, line_date, db_no, expense_type, amount_cents, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [advanceId, i, l.line_date, l.db_no, l.expense_type, l.amount_cents, l.description]));
      const insertAtt = (url, pathname, name, mime, size) => queries.push(qq(
        `INSERT INTO attachments (advance_line_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
         VALUES (currval(${ADV_LINE_SEQ}),$1,$2,$3,$4,$5)`, [url, pathname, name, mime, size]));
      for (const id of l.keepIds) {
        const a = byId.get(id);
        if (a && keptSet.has(id)) insertAtt(a.blob_url, a.blob_pathname, a.original_name, a.mime_type, a.size_bytes);
      }
      for (const u of verifiedByLine[i]) insertAtt(u.url, u.pathname, u.original_name, u.mime, u.size);
    });
    queries.push(qq(
      `INSERT INTO cash_advance_history (advance_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES ($1,$2,$3,$4,$5,'realize_submitted',$6)`,
      [advanceId, req.user.id, String(req.user.full_name || '').trim(),
       resubmit ? 'realization resubmitted' : 'realization submitted', row.status,
       String(b.resubmit_note || '').trim()]));
    await transaction(queries);
    for (const a of dropped) { try { await deleteReceipt(a.blob_url); } catch { /* ignore */ } }
    const rows = await q('SELECT * FROM cash_advances WHERE id = $1', [advanceId]);
    const first = currentApproverId(rows[0]);
    if (first) await notifyPendingApprover(first, advanceNotify(rows[0]));
    res.json({ claim: await serializeOneAdvance(rows[0]) });
  } catch (e) {
    for (const u of allUploaded) await deleteReceipt(u.url);
    throw e;
  }
}

app.post('/api/cash-advances/:id/realize', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.status !== 'paid') return res.status(409).json({ error: 'The advance must be paid before it can be realized' });
  return submitRealization(req, res, row);
}));

app.put('/api/cash-advances/:id/realize', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.status !== 'rejected_realize') return res.status(409).json({ error: 'Only a rejected realization can be edited and resubmitted' });
  return submitRealization(req, res, row);
}));

// Settle a fully-approved realization (phase 2 → settled). Records the direction:
// actual > advance → top-up owed to the employee; actual < advance → balance the
// employee returns; equal → even. Same permission as marking paid.
app.post('/api/cash-advances/:id/settle', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to settle cash advances' });
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.status !== 'realize_approved') return res.status(409).json({ error: 'Only an approved realization can be settled' });
  const diff = Number(row.realized_total_cents) - Number(row.amount_cents);
  const direction = diff > 0 ? 'topup' : diff < 0 ? 'return' : 'even';
  const note = String((req.body && req.body.note) || '').trim();
  await q(`UPDATE cash_advances SET status='settled', settlement_cents=$1, settlement_direction=$2,
            settlement_note=$3, settled_by=$4, settled_at=now(), updated_at=now() WHERE id=$5`,
    [Math.abs(diff), direction, note, req.user.id, row.id]);
  const label = direction === 'topup' ? `settled — top-up ${fmtMoney(Math.abs(diff), row.currency)} to employee`
    : direction === 'return' ? `settled — ${fmtMoney(Math.abs(diff), row.currency)} returned by employee`
    : 'settled — balanced';
  await logAdvanceHistory(row.id, req.user, label, 'realize_approved', 'settled', note);
  const rows = await q('SELECT * FROM cash_advances WHERE id=$1', [row.id]);
  await notifyClaimantDecision(rows[0].employee_id, advanceNotify(rows[0]), 'paid');
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Revert one step of a cash advance's lifecycle (mirrors planRevert, doubled for
// the realization phase). Only the actor who owns a node may undo it.
app.post('/api/cash-advances/:id/revert', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  const isSuper = req.user.role === 'superadmin';
  const u = req.user;
  let plan = null;
  if (row.status === 'settled') {
    if (!canMarkPaid(u)) return res.status(403).json({ error: 'You do not have permission to revert a settlement' });
    plan = { sql: `status='realize_approved', settlement_cents=0, settlement_direction='', settlement_note='', settled_by=NULL, settled_at=NULL`,
      action: 'reverted settlement', from: 'settled', to: 'realize_approved' };
  } else if (row.status === 'realize_approved') {
    if (!isSuper && Number(row.manager_id) !== u.id) return res.status(403).json({ error: 'Only the approver who approved this realization can revert it' });
    plan = { sql: `status='realize_submitted', manager_id=NULL, manager_comment='', decided_at=NULL`, action: 'reverted realization approval', from: 'realize_approved', to: 'realize_submitted' };
  } else if (row.status === 'realize_submitted') {
    if (step > 1) {
      if (!isSuper && ids[step - 2] !== u.id) return res.status(403).json({ error: 'Only the approver of the previous step can revert it' });
      plan = { sql: `current_step=${step - 1}`, action: 'reverted realization approval', from: 'realize_submitted', to: 'realize_submitted' };
    } else {
      if (!isSuper && Number(row.employee_id) !== u.id) return res.status(403).json({ error: 'Only the claimant can revert this realization' });
      plan = { sql: `status='rejected_realize', manager_id=NULL, decided_at=now()`, action: 'reverted — cancelled realization to edit', from: 'realize_submitted', to: 'rejected_realize', comment: 'Reverted by the claimant to make changes' };
    }
  } else if (row.status === 'paid') {
    if (!canMarkPaid(u)) return res.status(403).json({ error: 'You do not have permission to revert a payment' });
    plan = { sql: `status='approved', paid_by=NULL, paid_at=NULL`, action: 'reverted payment', from: 'paid', to: 'approved' };
  } else if (row.status === 'approved') {
    if (!isSuper && Number(row.manager_id) !== u.id) return res.status(403).json({ error: 'Only the approver who approved this advance can revert the approval' });
    plan = { sql: `status='submitted', manager_id=NULL, manager_comment='', decided_at=NULL`, action: 'reverted approval', from: 'approved', to: 'submitted' };
  } else if (row.status === 'submitted') {
    if (step > 1) {
      if (!isSuper && ids[step - 2] !== u.id) return res.status(403).json({ error: 'Only the approver of the previous step can revert it' });
      plan = { sql: `current_step=${step - 1}`, action: 'reverted approval', from: 'submitted', to: 'submitted' };
    } else {
      if (!isSuper && Number(row.employee_id) !== u.id) return res.status(403).json({ error: 'Only the claimant can revert this submission' });
      plan = { sql: `status='rejected', manager_id=NULL, decided_at=now()`, action: 'reverted — cancelled to edit', from: 'submitted', to: 'rejected', comment: 'Reverted by the claimant to make changes' };
    }
  } else {
    return res.status(409).json({ error: `A ${row.status} cash advance cannot be reverted` });
  }
  await q(`UPDATE cash_advances SET ${plan.sql}, updated_at=now() WHERE id=$1`, [row.id]);
  await logAdvanceHistory(row.id, req.user, plan.action, plan.from, plan.to, plan.comment || '');
  const rows = await q('SELECT * FROM cash_advances WHERE id=$1', [row.id]);
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

app.get('/api/cash-advances', requireAuth, ah(async (req, res) => {
  const { status, department, q: search } = req.query;
  const where = [];
  const params = [];
  const add = (clause, val) => { params.push(val); where.push(clause.replace('$$', `$${params.length}`)); };
  if (!userCan(req.user, 'view_all_claims')) {
    params.push(req.user.id);
    const p = `$${params.length}`;
    where.push(`(employee_id = ${p} OR ${p} = ANY(approver_ids))`);
  }
  if (!seesAllRegions(req.user)) {
    params.push(req.user.region || '');
    where.push(`region = $${params.length}`);
  }
  if (status) add('status = $$', status);
  if (department) add('department = $$', department);
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(advance_no ILIKE ${p} OR claimant_name ILIKE ${p} OR purpose ILIKE ${p})`);
  }
  const rows = await q(
    `SELECT * FROM cash_advances ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC`, params);
  res.json({ claims: await serializeManyAdvance(rows) });
}));

app.get('/api/cash-advances/:id', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (req.user.role !== 'superadmin' && !userCan(req.user, 'view_all_claims')
      && row.employee_id !== req.user.id && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own cash advances' });
  }
  res.json({ claim: await serializeOneAdvance(row) });
}));

// Download a realization receipt — auth-scoped, streamed from Blob.
app.get('/api/cash-advances/:id/attachments/:attId', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (req.user.role !== 'superadmin' && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  const rows = await q(
    `SELECT a.* FROM attachments a JOIN cash_advance_lines l ON a.advance_line_id = l.id
      WHERE a.id = $1 AND l.advance_id = $2`, [req.params.attId, row.id]);
  const att = rows[0];
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const r = await fetch(att.blob_url);
  if (!r.ok) return res.status(502).json({ error: 'Could not fetch file from storage' });
  const inlineOk = att.mime_type === 'application/pdf' || att.mime_type.startsWith('image/');
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.original_name)}"`);
  res.send(Buffer.from(await r.arrayBuffer()));
}));

// Delete a cash advance outright (super admin only) — clears its realization
// receipts (blobs), lines and history first.
app.delete('/api/cash-advances/:id', requireAuth, requireCap('delete_claims'), ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  const atts = await q(
    `SELECT a.blob_url FROM attachments a JOIN cash_advance_lines l ON a.advance_line_id = l.id WHERE l.advance_id = $1`, [row.id]);
  const advanceId = Number(row.id);
  await transaction([
    qq(`DELETE FROM attachments WHERE advance_line_id IN (SELECT id FROM cash_advance_lines WHERE advance_id = $1)`, [advanceId]),
    qq('DELETE FROM cash_advance_lines WHERE advance_id = $1', [advanceId]),
    qq('DELETE FROM cash_advance_history WHERE advance_id = $1', [advanceId]),
    qq('DELETE FROM cash_advances WHERE id = $1', [advanceId])
  ]);
  for (const a of atts) await deleteReceipt(a.blob_url);
  res.json({ ok: true });
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
  const adv = await q(
    `SELECT advance_no, claimant_name, amount_cents, currency, approver_ids, current_step
     FROM cash_advances WHERE status IN ('submitted','realize_submitted')`);
  for (const r of adv) push(currentApproverId(r), advanceNotify(r));

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
// expense date). Everything is grouped by expense date.
//
// Scope depends on the viewer (see insightsSeeAll / insightsCanView):
//   • super admins, Finance (any position), and General Manager and above see
//     ALL transactions company-wide;
//   • everyone else who may view (below GM, above Assistant Supervisor) sees only
//     the claims they approve — i.e. claims on which they are one of the
//     approvers, across whatever departments those claims belong to.
// Filters: `year`, `department` (narrows within the viewer's scope), `db`
// (DB-number substring — DB lives on claims.db_no and, for meals, on each line's
// `site`), and `status` (comma-separated; defaults to approved + paid).
const INSIGHT_STATUSES = ['submitted', 'approved', 'rejected', 'paid'];
app.get('/api/insights', requireAuth, ah(async (req, res) => {
  const pos = await loadPositions(req.user.region);
  if (!insightsCanView(req.user, pos)) {
    return res.status(403).json({ error: 'You do not have access to insights' });
  }
  const seeAll = insightsSeeAll(req.user, pos);
  const mode = seeAll ? 'all' : 'approver';

  let statuses = String(req.query.status || '').split(',').map(s => s.trim())
    .filter(s => INSIGHT_STATUSES.includes(s));
  if (!statuses.length) statuses = ['approved', 'paid'];

  const deptFilter = String(req.query.department || '').trim();
  const db = String(req.query.db || '').trim();
  const nameFilter = String(req.query.name || '').trim();

  const params = [];
  const where = [];
  const ph = statuses.map(s => { params.push(s); return `$${params.length}`; }).join(',');
  where.push(`status IN (${ph})`);
  where.push(`d ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`);
  // Approver-scoped viewers only see claims they approve; see-all viewers have no
  // such restriction. (`appr` is the claim's approver_ids array; Postgres arrays
  // are surfaced through the UNION below.)
  if (mode === 'approver') { params.push(req.user.id); where.push(`$${params.length} = ANY(appr)`); }
  if (deptFilter) { params.push(deptFilter); where.push(`lower(department) = lower($${params.length})`); }
  if (db) { params.push(`%${db}%`); where.push(`db ILIKE $${params.length}`); }
  // Employee-name substring filter (matches the claimant on each document).
  if (nameFilter) { params.push(`%${nameFilter}%`); where.push(`claimant ILIKE $${params.length}`); }
  // Region isolation: unless the viewer sees all regions, restrict to their own.
  if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`region = $${params.length}`); }

  // Reimbursement rows come from each claim's LINES (claim_lines), not the claim
  // header, so every expense keeps its own real type instead of the header's
  // "Multiple" summary. `no`/`claimant` carry the source document number and the
  // claimant name so the client can drill into a type and search by employee.
  const rows = await q(
    `SELECT category, substring(d,1,4) AS yr, substring(d,6,2) AS mo, d,
            cents::bigint AS cents, cid, db, no, claimant
       FROM (
         SELECT l.expense_type AS category, c.department, l.line_date AS d,
                l.amount_cents AS cents, c.status, COALESCE(l.db_no,'') AS db, 'c' || c.id AS cid,
                c.approver_ids AS appr, c.region, c.claim_no AS no, c.claimant_name AS claimant
           FROM claim_lines l JOIN claims c ON c.id = l.claim_id
         UNION ALL
         SELECT 'Meal allowance' AS category, m.department, l.line_date AS d,
                l.amount_cents AS cents, m.status, COALESCE(l.site,'') AS db, 'm' || m.id AS cid,
                m.approver_ids AS appr, m.region AS region, m.claim_no AS no, m.claimant_name AS claimant
           FROM meal_claim_lines l JOIN meal_claims m ON m.id = l.meal_claim_id
         UNION ALL
         -- Cash advances contribute their realization lines (actual transactions),
         -- which only exist once the advance is realized. The realization approval
         -- phase is mapped onto the base statuses so the status filter treats them
         -- like any other claim (realize_approved -> approved, settled -> paid, …).
         SELECT COALESCE(l.expense_type,'') AS category, a.department, l.line_date AS d,
                l.amount_cents AS cents,
                CASE a.status WHEN 'realize_submitted' THEN 'submitted'
                              WHEN 'realize_approved'  THEN 'approved'
                              WHEN 'settled'           THEN 'paid'
                              WHEN 'rejected_realize'  THEN 'rejected'
                              ELSE a.status END AS status,
                COALESCE(l.db_no,'') AS db, 'a' || a.id AS cid,
                a.approver_ids AS appr, a.region AS region, a.advance_no AS no, a.claimant_name AS claimant
           FROM cash_advance_lines l JOIN cash_advances a ON a.id = l.advance_id
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

  // Line-level detail for the selected year, biggest first, so the client can
  // drill into any expense type (pivot-style) and show each underlying line.
  const details = inYear
    .map(r => ({ cid: r.cid || '', no: r.no || '', name: r.claimant || '', date: r.d, db: r.db || '', type: r.category, cents: Number(r.cents) }))
    .sort((a, b) => b.cents - a.cents);

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

  // Department options for the filter dropdown. See-all viewers get every
  // department; approver-scoped viewers get only the departments among the claims
  // they approve (e.g. an approver over Technician + After Sales sees both).
  const drows = seeAll
    ? await q(
        `SELECT DISTINCT department FROM (
           SELECT department FROM claims
           UNION SELECT department FROM meal_claims
           UNION SELECT department FROM cash_advances
         ) t WHERE COALESCE(TRIM(department), '') <> '' ORDER BY department`)
    : await q(
        `SELECT DISTINCT department FROM (
           SELECT department FROM claims        WHERE $1 = ANY(approver_ids)
           UNION
           SELECT department FROM meal_claims   WHERE $1 = ANY(approver_ids)
           UNION
           SELECT department FROM cash_advances WHERE $1 = ANY(approver_ids)
         ) t WHERE COALESCE(TRIM(department), '') <> '' ORDER BY department`, [req.user.id]);
  const departments = drows.map(r => r.department);

  // Employee options for the searchable filter — distinct claimant names in the
  // viewer's scope (region + approver-mode), independent of the year/dept/status
  // filters so the list stays stable as you narrow. Mirrors the department list.
  const empConds = [`COALESCE(TRIM(claimant_name), '') <> ''`];
  const empParams = [];
  if (mode === 'approver') { empParams.push(req.user.id); empConds.push(`$${empParams.length} = ANY(approver_ids)`); }
  if (!seesAllRegions(req.user)) { empParams.push(req.user.region || ''); empConds.push(`region = $${empParams.length}`); }
  const erows = await q(
    `SELECT DISTINCT claimant_name FROM (
       SELECT claimant_name, approver_ids, region FROM claims
       UNION ALL SELECT claimant_name, approver_ids, region FROM meal_claims
       UNION ALL SELECT claimant_name, approver_ids, region FROM cash_advances
     ) t WHERE ${empConds.join(' AND ')} ORDER BY claimant_name`, empParams);
  const employees = erows.map(r => r.claimant_name);

  // DB-number options for the searchable filter — distinct DB numbers in scope.
  // DB lives per line: claim_lines.db_no, cash_advance_lines.db_no, and (for
  // meals) meal_claim_lines.site, matching the `db` column in the rows query.
  const dbConds = [`COALESCE(TRIM(db), '') <> ''`];
  const dbParams = [];
  if (mode === 'approver') { dbParams.push(req.user.id); dbConds.push(`$${dbParams.length} = ANY(approver_ids)`); }
  if (!seesAllRegions(req.user)) { dbParams.push(req.user.region || ''); dbConds.push(`region = $${dbParams.length}`); }
  const dbrows = await q(
    `SELECT DISTINCT db FROM (
       SELECT l.db_no AS db, c.approver_ids, c.region
         FROM claim_lines l JOIN claims c ON c.id = l.claim_id
       UNION ALL SELECT l.site AS db, m.approver_ids, m.region
         FROM meal_claim_lines l JOIN meal_claims m ON m.id = l.meal_claim_id
       UNION ALL SELECT l.db_no AS db, a.approver_ids, a.region
         FROM cash_advance_lines l JOIN cash_advances a ON a.id = l.advance_id
     ) t WHERE ${dbConds.join(' AND ')} ORDER BY db`, dbParams);
  const dbNos = dbrows.map(r => r.db);

  res.json({
    scope: { mode, department: deptFilter || null },
    // Region-scoped viewers see their region's currency; all-regions viewers see
    // the global default (their totals may span multiple currencies).
    currency: seesAllRegions(req.user) ? DEFAULT_CURRENCY : (await regionPrefsFor(req.user.region)).currency,
    year, years, status: statuses, db, name: nameFilter, departments, employees, dbNos,
    byType, byMonth, byYear, kpis, details
  });
}));

// Export both reimbursement claims and meal allowance claims in one CSV.
// Filters: `status` (comma-separated, any of the four), `from`/`to` (inclusive,
// applied to each row's expense/meal date), and `types` (comma-separated:
// reimbursement, meal \u2014 defaults to both). Reimbursement claims export one row
// each; meal allowances export one row per line item (per day), so finance sees
// the full daily breakdown. A shared column set carries both.
app.get('/api/export.csv', requireAuth, requireCap('export_csv'), ah(async (req, res) => {
  const { from, to } = req.query;
  const statuses = String(req.query.status || '').split(',').map(s => s.trim())
    .filter(s => EXPORT_STATUSES.includes(s));
  const types = String(req.query.types || 'reimbursement,meal,advance').split(',').map(s => s.trim());
  const wantReimb = types.includes('reimbursement');
  const wantMeal = types.includes('meal');
  const wantAdvance = types.includes('advance');
  // Optional whitelist of submitter (employee) ids to include. Filter to positive
  // ids: an absent/empty param must yield [] (no filter), not [0] — Number('') is
  // 0 and passes Number.isInteger, which would otherwise filter every row to
  // employee_id IN (0) and export nothing when "all users" is selected.
  const employees = String(req.query.employees || '').split(',')
    .map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);

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
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`c.region = $${params.length}`); }
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
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`m.region = $${params.length}`); }
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

  // Cash advances export one row per realization line — so only realized advances
  // appear (a request-stage advance has no lines). The status filter is applied to
  // the realization phase mapped onto the base statuses (see the CASE below); the
  // Status column shows the advance's real status.
  if (wantAdvance) {
    const where = [];
    const params = [];
    const mappedStatus = `CASE a.status WHEN 'realize_submitted' THEN 'submitted'
      WHEN 'realize_approved' THEN 'approved' WHEN 'settled' THEN 'paid'
      WHEN 'rejected_realize' THEN 'rejected' ELSE a.status END`;
    if (statuses.length) {
      const ph = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
      statuses.forEach(s => params.push(s));
      where.push(`${mappedStatus} IN (${ph})`);
    }
    if (employees.length) {
      const ph = employees.map((_, i) => `$${params.length + i + 1}`).join(',');
      employees.forEach(e => params.push(e));
      where.push(`a.employee_id IN (${ph})`);
    }
    if (from) { params.push(from); where.push(`l.line_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`l.line_date <= $${params.length}`); }
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`a.region = $${params.length}`); }
    const rows = await q(
      `SELECT a.advance_no, a.claimant_name, a.department, a.bank_name, a.recipient_name,
              a.bank_account_no, a.currency, a.status, a.purpose, a.manager_comment,
              a.decided_at, a.paid_at, a.created_at, u.username AS employee_username,
              l.line_date, l.db_no, l.expense_type, l.amount_cents, l.description, l.sort_order
       FROM cash_advance_lines l
       JOIN cash_advances a ON a.id = l.advance_id
       JOIN users u ON u.id = a.employee_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.created_at, l.sort_order`, params);
    for (const r of rows) {
      out.push({ key: iso(r.created_at) || '', cells: [
        'Cash advance', r.advance_no, r.employee_username, r.claimant_name, r.department,
        r.bank_name, r.recipient_name, r.bank_account_no, r.line_date, r.expense_type, r.db_no || '',
        (Number(r.amount_cents) / 100).toFixed(2), r.currency,
        r.description, r.status, r.manager_comment, iso(r.decided_at), iso(r.paid_at), iso(r.created_at)] });
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
const ROLES = ['superadmin', 'admin', 'manager', 'lowmgmt', 'finance', 'employee'];

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

app.get('/api/users', requireAuth, ah(async (req, res) => {
  const isSuper = req.user.role === 'superadmin';
  // Superadmins read every account; admins and delegated seniors read only their
  // own department's accounts (to populate Manage-accounts). Everyone else is
  // forbidden.
  if (!isSuper && !hasDelegation(req.user, await loadPositions(req.user.region))) {
    return res.status(403).json({ error: 'You do not have permission for this action' });
  }
  const cols = 'id, username, full_name, email, role, department, position, region, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid, approval_limit_cents, active, created_by, created_by_name, created_at';
  let users;
  if (isSuper) {
    users = await q(`SELECT ${cols} FROM users ORDER BY id`);
  } else {
    const where = ['lower(department) = lower($1)'];
    const params = [String(req.user.department || '').trim()];
    // Region isolation: a region-scoped manager sees only same-region accounts.
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`region = $${params.length}`); }
    users = await q(`SELECT ${cols} FROM users WHERE ${where.join(' AND ')} ORDER BY id`, params);
  }
  res.json({ users: users.map(u => ({ ...u, approver_ids: asIntArray(u.approver_ids), approver1_options: asIntArray(u.approver1_options), created_at: iso(u.created_at) })) });
}));
// Account creation is super-admin only. Everyone else — including admins and
// senior positions — can no longer create accounts (they may still reset /
// enable-disable their team; see canManageAccount).
app.post('/api/users', requireAuth, requireCap('create_accounts'), ah(async (req, res) => {
  const isSuper = req.user.role === 'superadmin';
  const { username, password, full_name, email,
    bank_name, recipient_name, bank_account_no } = req.body || {};
  let { role, department, position, approver_ids, approver1_options } = req.body || {};
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
  // Approval limit (cents; null = unlimited). Defaults to unlimited when the
  // caller omits both fields, preserving the historical any-amount behaviour.
  const limit = parseApprovalLimit(req.body || {});
  if (limit.error) return res.status(400).json({ error: limit.error });
  const rows = await q(
    `INSERT INTO users (username, password_hash, full_name, role, department, position, region, email, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid, approval_limit_cents, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::int[],$13::int[],$14,$15,$16,$17) RETURNING id`,
    [String(username).trim(), bcrypt.hashSync(String(password), 10), String(full_name).trim(), role,
     String(department || '').trim(), String(position || '').trim(), region, nextEmail,
     String(bank_name || '').trim(), String(recipient_name || '').trim(),
     String(bank_account_no || '').trim(), intArrayLiteral(apprIds),
     intArrayLiteral(appr1Ids), canMarkPaidFlag, limit.cents,
     req.user.id, req.user.full_name || req.user.username || '']);
  res.status(201).json({ id: rows[0].id });
}));
app.put('/api/users/:id', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const rows = await q('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { username, full_name, role, department, position, region, active, password, email,
    bank_name, recipient_name, bank_account_no, approver_ids, approver1_options, can_mark_paid } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
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
             can_mark_paid=$12, approver1_options=$14::int[], region=$15, approval_limit_cents=$16 WHERE id=$13`, [
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
    nextLimit
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
  const rows = await q('SELECT id, role, department, position, region FROM users WHERE id = $1', [req.params.id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!canManageAccount(req.user, target, await loadPositions(target.region))) {
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

// ---------------------------------------------------------------------------
// Settings: simple lookups (departments, job positions, expense types)
// ---------------------------------------------------------------------------
// Table names and flag column names are hard-coded (never user input), so
// interpolation is safe. `flags` lists extra BOOLEAN columns (e.g. the purpose
// gates allow_claim / allow_meal) that admins can toggle per row.
// Which region a lookup request targets. Region-scoped users are pinned to their
// own region; super admins / All-regions accounts may name any region (query for
// reads, body for writes). Returns a concrete region name, '' (no region named —
// on a read, means "every region"), or null when `requested` names an unknown
// region. '*' is never a lookup region of its own.
async function resolveLookupRegion(user, requested) {
  if (!seesAllRegions(user)) return String(user.region || '');
  const raw = requested == null ? '' : String(requested).trim();
  if (!raw) return '';
  const r = await normRegion(raw);
  return r === ALL_REGIONS ? '' : r;
}
// May this user edit a lookup row that belongs to `region`? Super admins / All
// -regions accounts may edit any; everyone else only their own region's rows.
function canEditLookupRegion(user, region) {
  if (seesAllRegions(user)) return true;
  return String(region || '') === String(user.region || '');
}

function lookupRoutes(pathName, table, flags = [], opts = {}) {
  // `opts.ranked` adds a `rank` column (a reorderable seniority ladder) — it is
  // selected, ordered by, and gets its own POST /reorder endpoint below.
  // `opts.regional` scopes the lookup to a region (see resolveLookupRegion).
  const ranked = !!opts.ranked;
  const regional = !!opts.regional;
  const orderBy = ranked ? 'rank, name' : 'name';
  const extraCols = [...(ranked ? ['rank'] : []), ...(regional ? ['region'] : [])];
  // List — any signed-in user may read (the claim form needs departments and
  // expense types). Non-admins receive only the active entries. Regional lookups
  // are filtered to the resolved region (a super admin with no ?region sees all).
  app.get(`/api/${pathName}`, requireAuth, ah(async (req, res) => {
    const onlyActive = req.user.role !== 'superadmin';
    const cols = ['id', 'name', 'active', ...flags, ...extraCols, 'created_at'].join(', ');
    const region = regional ? await resolveLookupRegion(req.user, req.query.region) : null;
    if (regional && region === null) return res.status(400).json({ error: 'Invalid region' });
    const wheres = [];
    const params = [];
    if (onlyActive) wheres.push('active = TRUE');
    if (regional && region) { params.push(region); wheres.push(`region = $${params.length}`); }
    const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const items = await q(`SELECT ${cols} FROM ${table} ${whereSql} ORDER BY ${orderBy}`, params);
    res.json({ items: items.map(i => ({ ...i, created_at: iso(i.created_at) })) });
  }));

  // Reorder one region's ladder: body { region, order: [id, …] } sets rank =
  // position + 1 for the listed ids, atomically. Only defined for ranked lookups.
  if (ranked) {
    app.post(`/api/${pathName}/reorder`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
      const order = (req.body && req.body.order) || [];
      if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of ids' });
      const ids = [];
      for (const v of order) { const n = Number(v); if (Number.isInteger(n) && n > 0) ids.push(n); }
      if (!ids.length) return res.status(400).json({ error: 'order must contain valid ids' });
      if (regional) {
        const region = await resolveLookupRegion(req.user, (req.body || {}).region);
        if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
        // Scope every update to the region so a stray cross-region id is a no-op.
        await transaction(ids.map((id, i) => qq(`UPDATE ${table} SET rank = $1 WHERE id = $2 AND region = $3`, [i + 1, id, region])));
      } else {
        await transaction(ids.map((id, i) => qq(`UPDATE ${table} SET rank = $1 WHERE id = $2`, [i + 1, id])));
      }
      res.json({ ok: true });
    }));
  }

  app.post(`/api/${pathName}`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    let region = '';
    if (regional) {
      region = await resolveLookupRegion(req.user, (req.body || {}).region);
      if (region === null) return res.status(400).json({ error: 'Invalid region' });
      if (!region) return res.status(400).json({ error: 'Choose a region' });
    }
    const exists = await q(
      `SELECT 1 FROM ${table} WHERE lower(name) = lower($1)${regional ? ' AND region = $2' : ''}`,
      regional ? [name, region] : [name]);
    if (exists[0]) return res.status(409).json({ error: 'That name already exists' });
    let rows;
    if (regional && ranked) {
      // New ranked rows drop to the bottom of that region's ladder.
      rows = await q(
        `INSERT INTO ${table} (name, region, rank)
           VALUES ($1, $2, (SELECT COALESCE(MAX(rank), 0) + 1 FROM ${table} WHERE region = $2)) RETURNING id`,
        [name, region]);
    } else if (regional) {
      rows = await q(`INSERT INTO ${table} (name, region) VALUES ($1, $2) RETURNING id`, [name, region]);
    } else {
      rows = await q(`INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [name]);
    }
    res.status(201).json({ id: rows[0].id });
  }));

  app.put(`/api/${pathName}/:id`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
    const rows = await q(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (regional && !canEditLookupRegion(req.user, item.region)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    const { name, active } = req.body || {};
    const newName = name != null ? String(name).trim() : item.name;
    if (!newName) return res.status(400).json({ error: 'Name is required' });
    if (newName.toLowerCase() !== item.name.toLowerCase()) {
      const dupe = await q(
        `SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND id <> $2${regional ? ' AND region = $3' : ''}`,
        regional ? [newName, item.id, item.region] : [newName, item.id]);
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

  app.delete(`/api/${pathName}/:id`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
    if (regional) {
      const rows = await q(`SELECT region FROM ${table} WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      if (!canEditLookupRegion(req.user, rows[0].region)) {
        return res.status(403).json({ error: 'You do not have permission for this action' });
      }
    }
    const rows = await q(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));
}
lookupRoutes('departments', 'departments', ['allow_claim', 'allow_meal', 'allow_advance'], { regional: true });
lookupRoutes('positions', 'job_positions', ['allow_claim', 'allow_meal', 'allow_advance', 'can_manage'], { ranked: true, regional: true });
lookupRoutes('expense-types', 'expense_types', [], { regional: true });
lookupRoutes('regions', 'regions');

// --- Role permissions matrix (region-scoped) --------------------------------
// The capability matrix is configured per region by Super Admins only. Super
// Admin is implicitly all-true and omitted from `matrix`; only Mid Management /
// Low Management / Finance rows are editable.
function canAccessRoleMatrix(user) {
  return !!user && (user.role === 'superadmin' || user.role === 'admin');
}
// Which region a request may act on. Non-superadmins are pinned to their own
// region whatever they ask for; super admins / All-regions accounts may target
// any region they name. Returns null for a named-but-unknown region.
async function resolveMatrixRegion(user, requested) {
  if (!seesAllRegions(user)) return String(user.region || '');
  return normRegion(requested);
}

// Read the editable capability matrix for a region (?region=Name).
app.get('/api/role-permissions', requireAuth, ah(async (req, res) => {
  if (!canAccessRoleMatrix(req.user)) return res.status(403).json({ error: 'You do not have permission for this action' });
  const region = await resolveMatrixRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  res.json({
    capabilities: CAPABILITIES,
    roles: EDITABLE_ROLES,
    editableRoles: editableRolesFor(req.user),
    region,
    matrix: await loadRolePermsForRegion(region),
    superadminLocked: true
  });
}));
// Toggle one capability for one editable role in one region. A CM/MD may only
// touch their own region and only the Mid/Low/Finance rows — never their own
// (admin) row or the Employee baseline — so they cannot self-escalate. Overrides
// are stored sparsely so unset capabilities keep tracking the global defaults.
app.put('/api/role-permissions', requireAuth, ah(async (req, res) => {
  if (!canAccessRoleMatrix(req.user)) return res.status(403).json({ error: 'You do not have permission for this action' });
  const { role, cap, value } = req.body || {};
  const region = await resolveMatrixRegion(req.user, (req.body || {}).region);
  if (!region || region === ALL_REGIONS) return res.status(400).json({ error: 'Choose a region' });
  if (!editableRolesFor(req.user).includes(role)) return res.status(400).json({ error: 'This role is not editable' });
  if (!CAPABILITY_KEYS.has(cap)) return res.status(400).json({ error: 'Invalid capability' });

  const settings = await loadAppSettings();
  let byRegion = {};
  try { byRegion = settings.role_permissions_by_region ? JSON.parse(settings.role_permissions_by_region) : {}; }
  catch { byRegion = {}; }
  const store = byRegion[region] || {};
  if (!store[role]) store[role] = {};
  store[role][cap] = isActive(value);
  byRegion[region] = store;
  await setAppSetting('role_permissions_by_region', JSON.stringify(byRegion));
  res.json({ ok: true, region, matrix: await loadRolePermsForRegion(region, { ...settings, role_permissions_by_region: JSON.stringify(byRegion) }) });
}));

// ---------------------------------------------------------------------------
// Static frontend + error handling
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || 'Request failed' });
  }
  next();
});

module.exports = app;
