'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const cookieSession = require('cookie-session');
const { errorHandler } = require('./lib/errors');
const {
  parseAmountToCents, fmtMoney, parseApprovalLimit, approvalLimitError
} = require('./lib/money');
const { normaliseClaimLines } = require('./lib/claims');
const { claimHeaderFromLines, slimForList } = require('./lib/documents');
const { normaliseMealLines } = require('./lib/meals');
const { normaliseAdvanceRequest, settlementFor, planAdvanceRevert } = require('./lib/advances');
const {
  subDaysISO, dateInZone, todayInZone, claimWindowSettings, claimEarliestFrom,
  resubmitEarliest, dateFloorFor
} = require('./lib/claim-window');
const {
  currentApproverId, userCanApprove, canMarkPaid, planRevert,
  undoneApprovalStep, revertLandsOnApprover1, applyListStatusFilter,
  applyLedgerWindow, OPEN_CLAIM_SQL, OPEN_ADVANCE_SQL
} = require('./lib/workflow');
const {
  fillMatrix, capsFor, userCan, editableRolesFor, hasDelegation,
  creatablePositions, canManageAccount, insightsCanView, insightsSeeAll,
  accountsSeeAllDepts, CAPABILITIES
} = require('./lib/permissions');

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
// clapac-internalportal.vercel.app is the single primary address (the clid-
// domain is redirected to it in the Vercel domain settings).
const CANONICAL_HOST = process.env.CANONICAL_HOST || 'clapac-internalportal.vercel.app';
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
// On Vercel the pages are served by the CDN, not this function, so the same
// headers are repeated in vercel.json — keep the two in step.
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
  // API answers are per-user; nothing in between may keep a copy. (A route can
  // still override this, e.g. for a receipt download.)
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
// Compress responses here, not just at the CDN: Vercel caps what a function may
// return at 4.5 MB, and that cap counts the bytes the function sends. The claim
// ledger is JSON that compresses ~10x, so this is what keeps it well clear.
app.use(compression());
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

// ---------------------------------------------------------------------------
// Routes — one router per area (routes/*.js), mounted in the order their
// routes have always been registered. Shared logic lives in lib/*.js.
// ---------------------------------------------------------------------------
app.use(require('./routes/auth'));
app.use(require('./routes/settings'));
app.use(require('./routes/date-changes'));
app.use(require('./routes/claims'));
app.use(require('./routes/uploads'));
app.use(require('./routes/meals'));
app.use(require('./routes/advances'));
app.use(require('./routes/bulk-payments'));
app.use(require('./routes/cron'));
app.use(require('./routes/reports'));
app.use(require('./routes/users'));
app.use(require('./routes/lookups'));

// ---------------------------------------------------------------------------
// Static frontend + error handling
// ---------------------------------------------------------------------------
// Local dev only: on Vercel public/ is served straight from the CDN (see
// vercel.json, which also versions the asset URLs) and never reaches here.
app.use(express.static(path.join(__dirname, 'public'), {
  // The client bundles (app.js / i18n.js) and the app shell change on every
  // deploy but keep the same filenames. `no-cache` lets the browser keep a copy
  // but forces it to revalidate against the server (a cheap 304 when unchanged)
  // before using it, so a stale i18n.js can't linger after a release and show
  // yesterday's strings. Other assets (logo, fonts) keep the default caching.
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Thrown errors: deliberate 4xx keep their message; anything else is a logged
// 500 with a generic message (see lib/errors.js).
app.use(errorHandler);

module.exports = app;
// The pure business rules (money, dates, approval chain, permissions), exposed
// for the unit tests in tests/ (`npm test`). None of these touch the database.
module.exports.rules = {
  parseAmountToCents, fmtMoney, parseApprovalLimit, approvalLimitError,
  normaliseClaimLines, claimHeaderFromLines, normaliseMealLines, normaliseAdvanceRequest,
  settlementFor, subDaysISO, dateInZone, todayInZone, claimWindowSettings, claimEarliestFrom,
  resubmitEarliest, dateFloorFor, currentApproverId, userCanApprove, canMarkPaid,
  planRevert, planAdvanceRevert, undoneApprovalStep, revertLandsOnApprover1,
  fillMatrix, capsFor, userCan, editableRolesFor, hasDelegation, creatablePositions,
  canManageAccount, insightsCanView, insightsSeeAll, accountsSeeAllDepts,
  applyListStatusFilter, applyLedgerWindow, slimForList,
  OPEN_CLAIM_SQL, OPEN_ADVANCE_SQL, CAPABILITIES
};
