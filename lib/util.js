'use strict';

// Small shared helpers: async route wrapper, date/time formatting, arrays,
// emails, languages, money formatting, hashing.

const crypto = require('crypto');
const { appUrl } = require('./email');
const { DEFAULT_TIMEZONE } = require('./settings');

// async route wrapper
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const iso = (v) => (v instanceof Date ? v.toISOString() : v);

// A time zone's current UTC offset as "GMT+7", for column labels. Mirrors the
// client's tzOffsetLabel(); returns '' if the runtime can't produce a short
// offset so callers can simply omit the label.
function tzOffsetLabel(tz) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz || DEFAULT_TIMEZONE, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find(x => x.type === 'timeZoneName');
    return part ? part.value : '';
  } catch { return ''; }
}
// Render a stored (UTC) timestamp as "YYYY-MM-DD HH:MM:SS" in `tz`, so exported
// dates read as the same wall-clock time the portal shows on screen instead of
// the raw UTC instant. Mirrors the client's fmtDateTime() minus the zone suffix:
// that goes in the CSV header once, which keeps each cell parseable as a date by
// Excel. Falls back to the raw ISO string if the zone can't be formatted.
function tsInZone(v, tz) {
  const s = iso(v);
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch { return s; }
}

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

// --- Claim date policy ------------------------------------------------------
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function groupBy(rows, key) {
  const m = {};
  for (const r of rows) (m[r[key]] = m[r[key]] || []).push(r);
  return m;
}

// A calendar date (YYYY-MM-DD) — the payment date picked when marking a claim
// as paid.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // 1 hour
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------
const isActive = (v) => v === true || v === 1 || v === '1' || v === 'true';

// A "contains" pattern for ILIKE from what someone typed: % and _ (and the
// escape character itself) match literally, so "50%" finds "50%", not "50…".
const likeContains = (s) => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';

module.exports = {
  likeContains, isISODate, iso, ah, isActive, asIntArray, groupBy, intArrayLiteral, normLang,
  normEmail, EMAIL_RE, sha256, baseUrl, escHtml, DATE_RE, tzOffsetLabel,
  tsInZone
};
