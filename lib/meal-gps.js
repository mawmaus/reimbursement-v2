'use strict';

// GPS meal allowance (effective 2026-11-01): the rules, the per-region on/off
// switch, account bases, and line validation. A GPS meal claim is an ordinary
// meal_claims row with scheme = 'gps', so the approval chain, payment, ledger
// and exports all carry on unchanged; only what a line holds differs.
//
// One line is one day:
//   in town  (dalam kota)  — under MIN_KM from the base: not claimable;
//                            MIN_KM or more: one amount, capped per day.
//   out of town (luar kota) — up to MAX_MEALS meals, capped per day in total.
// Every line names the customer site the claimant went to (Settings → Customer
// sites: by DB number, or the customer picked when there is no DB) and carries
// at least one receipt. The distance is measured here, from the base on the
// account to that site's pin — never taken from the browser. (Days submitted
// before 2026-11-01 carried the phone's GPS reading instead; gps_* keeps those.)

const { q } = require('../db');
const { parseAmountToCents, fmtMoney } = require('./money');
const { isISODate, asIntArray } = require('./util');
const { loadAppSettings, ALL_REGIONS } = require('./settings');

const RULES = {
  effectiveFrom: '2026-11-01',
  minKm: 30,
  inTownCapCents: 35000 * 100,
  outOfTownCapCents: 120000 * 100,
  maxMeals: 3
};
const TRIP_TYPES = ['in_town', 'out_of_town'];
const SCHEME = 'gps';

// --- Per-region switch ----------------------------------------------------------
// app_settings `meal_gps_by_region`: { [region]: { enabled } }. Off until a
// settings manager turns it on for their region.
function mealGpsMap(settings) {
  try { return settings.meal_gps_by_region ? JSON.parse(settings.meal_gps_by_region) || {} : {}; }
  catch { return {}; }
}
function mealGpsEnabled(settings, region) {
  if (!region || region === ALL_REGIONS) return false;
  const r = mealGpsMap(settings)[region];
  return !!(r && r.enabled === true);
}
// Who may open a new GPS meal claim: the same department + position gate as the
// standard meal allowance, in a region that has the GPS form switched on. Super
// admins always may (they test new forms before switching them on).
function mayRaiseGps(user, purposes, settings) {
  if (user.role === 'superadmin') return true;
  return !!(purposes && purposes.meal) && mealGpsEnabled(settings, user.region);
}

// --- Account base ------------------------------------------------------------------
const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const validLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;
// Read coordinates out of what an admin pastes: "-6.2, 106.81", or a Google Maps
// link (…/@-6.2,106.81,15z, ?q=-6.2,106.81, ll=, or the !3d…!4d… pair).
// Returns { lat, lng } or null.
function parseCoords(input) {
  const s = decodeURIComponentSafe(String(input == null ? '' : input).trim());
  if (!s) return null;
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`@${num},\\s*${num}`),
    new RegExp(`[?&](?:q|query|ll|center|destination)=${num},\\s*${num}`),
    new RegExp(`^${num}\\s*[,;\\s]\\s*${num}$`)
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (validLat(lat) && validLng(lng)) return { lat, lng };
  }
  return null;
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
// The base fields of a users row as the client sees them, or null when unset.
function baseView(u) {
  if (!u || u.base_lat == null || u.base_lng == null) return null;
  return { name: u.base_name || '', lat: Number(u.base_lat), lng: Number(u.base_lng) };
}
// Validate the base fields riding on an account save. `name` + `coords` (any
// form parseCoords reads); both blank clears the base. Returns
// { base: {name, lat, lng} | null } or { error }.
function parseBaseInput(name, coords) {
  const n = String(name == null ? '' : name).trim().slice(0, 120);
  const c = String(coords == null ? '' : coords).trim();
  if (!n && !c) return { base: null };
  const ll = parseCoords(c);
  if (!ll) return { error: 'Base location: paste coordinates like "-6.2088, 106.8456" or a Google Maps link' };
  if (!n) return { error: 'Give the base a name (e.g. "Jakarta office")' };
  return { base: { name: n, lat: ll.lat, lng: ll.lng } };
}

// --- Distance ------------------------------------------------------------------------
// Great-circle distance in metres (haversine). "Radius from the base" is this
// straight-line distance, not the road distance.
function distanceMeters(a, b) {
  const R = 6371008.8;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const kmText = (m) => `${(m / 1000).toFixed(1)} km`;

// --- Lines -----------------------------------------------------------------------------
const dbDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
// Validate + normalise the submitted day lines against the claimant's base.
// `sites` are the claim region's customer sites: a day is measured to the site
// its DB number is pinned as, or — with no DB — the customer picked (site_id).
// Fully blank rows are dropped. Receipt references (new uploads + kept ids) ride
// along for the route to verify. Returns { lines, totalCents } or { error }.
function normaliseGpsLines(input, base, currency, { sites = [] } = {}) {
  if (!base) return { error: 'Your account has no base location yet — ask your administrator to set it before claiming' };
  if (!Array.isArray(input)) return { error: 'Lines must be a list' };
  const money = (c) => fmtMoney(c, currency);
  const siteOf = (r) => {
    const db = dbDigits(r.site);
    if (db) return sites.find(s => s.db_no === db) || null;
    const id = Number(r.site_id);
    return (id && sites.find(s => Number(s.id) === id)) || null;
  };
  const lines = [];
  const seen = new Set();
  let totalCents = 0;
  for (const raw of input) {
    const r = raw || {};
    const date = String(r.date || r.line_date || '').trim();
    const trip = String(r.trip_type || '').trim();
    const site = String(r.site || '').trim().slice(0, 120);
    const category = String(r.category || r.job_category || '').trim().slice(0, 200);
    const description = String(r.desc || r.description || '').trim().slice(0, 1000);
    const rawAttachments = Array.isArray(r.attachments) ? r.attachments : [];
    const keepIds = asIntArray(r.keep_attachment_ids);
    const amounts = trip === 'out_of_town'
      ? (Array.isArray(r.meals) ? r.meals : []).map(parseAmountToCents).filter(c => c !== null && c > 0)
      : [parseAmountToCents(r.amount)].filter(c => c !== null && c > 0);
    const blank = !date && !trip && !site && !category && !description && !amounts.length
      && !rawAttachments.length && !keepIds.length && !r.site_id;
    if (blank) continue;
    const n = lines.length + 1;
    const tag = `Line ${n}${date ? ` (${date})` : ''}`;
    if (!isISODate(date)) return { error: `${tag}: choose the date` };
    if (date < RULES.effectiveFrom) return { error: `${tag}: the GPS meal allowance starts on ${RULES.effectiveFrom}` };
    if (seen.has(date)) return { error: `${tag}: one line per day — ${date} is already on this claim` };
    seen.add(date);
    if (!TRIP_TYPES.includes(trip)) return { error: `${tag}: choose in town or out of town` };
    const where = siteOf(r);
    if (!where) {
      const db = dbDigits(site);
      return { error: db
        ? `${tag}: DB${db} isn't registered as a customer site yet — ask your manager to register it (Settings → Customer sites)`
        : `${tag}: choose the customer — if they aren't listed, ask your manager to register them (Settings → Customer sites)` };
    }
    const distance = Math.round(distanceMeters(base, where));
    let amountCents;
    let meals = '';
    if (trip === 'in_town') {
      if (distance < RULES.minKm * 1000) {
        return { error: `${tag}: the customer site is ${kmText(distance)} RADIUS (straight line, not road distance) from ${base.name || 'your base'} — in-town meals within ${RULES.minKm} km can't be claimed` };
      }
      if (amounts.length !== 1) return { error: `${tag}: enter the meal amount` };
      amountCents = amounts[0];
      if (amountCents > RULES.inTownCapCents) {
        return { error: `${tag}: in town is capped at ${money(RULES.inTownCapCents)} a day (entered ${money(amountCents)})` };
      }
    } else {
      if (!amounts.length) return { error: `${tag}: enter at least one meal amount` };
      if (amounts.length > RULES.maxMeals) return { error: `${tag}: at most ${RULES.maxMeals} meals a day out of town` };
      amountCents = amounts.reduce((s, c) => s + c, 0);
      if (amountCents > RULES.outOfTownCapCents) {
        return { error: `${tag}: out of town is capped at ${money(RULES.outOfTownCapCents)} a day for up to ${RULES.maxMeals} meals (entered ${money(amountCents)})` };
      }
      meals = JSON.stringify(amounts);
    }
    if (!rawAttachments.length && !keepIds.length) return { error: `${tag}: attach the meal receipt` };
    totalCents += amountCents;
    lines.push({
      line_date: date, site, job_category: category, description, trip_type: trip, meals,
      amount_cents: amountCents, site_id: where.id, site_name: where.alias || where.name || '', site_lat: where.lat, site_lng: where.lng,
      base_name: base.name || '', base_lat: base.lat, base_lng: base.lng, distance_m: distance,
      rawAttachments, keepIds
    });
  }
  if (!lines.length) return { error: 'Add at least one day' };
  return { lines, totalCents };
}

// Dates already claimed on another live meal claim of the same employee (either
// form): a day is paid once. Rejected claims and rejected lines don't count —
// they are being fixed or re-claimed. Returns [{ line_date, claim_no }].
async function datesTakenElsewhere(employeeId, dates, exceptClaimId = 0) {
  const list = dates.filter(isISODate);
  if (!list.length) return [];
  return q(
    `SELECT l.line_date, c.claim_no FROM meal_claim_lines l JOIN meal_claims c ON c.id = l.meal_claim_id
      WHERE c.employee_id = $1 AND c.id <> $2 AND c.status <> 'rejected' AND l.rejected_at IS NULL
        AND l.line_date = ANY($3::text[])
      ORDER BY l.line_date`,
    [employeeId, exceptClaimId || 0, `{${list.join(',')}}`]);
}

// A region's customer sites, for normaliseGpsLines.
async function loadRegionSites(region) {
  const rows = await q('SELECT id, db_no, name, alias, lat, lng FROM customer_sites WHERE region = $1', [String(region || '')]);
  return rows.map(s => ({ id: Number(s.id), db_no: s.db_no, name: s.name, alias: s.alias || '', lat: Number(s.lat), lng: Number(s.lng) }));
}

// An account's base, read on its own (not on every request with the session
// user). Before the 2026-11-01 migration the columns don't exist yet (42703):
// that reads as "no base" rather than failing sign-in.
async function loadBase(userId) {
  try { return baseView((await q('SELECT base_name, base_lat, base_lng FROM users WHERE id = $1', [userId]))[0]); }
  catch (e) { if (e && e.code === '42703') return null; throw e; }
}
// What the client needs at sign-in: whether this account may open the GPS form,
// its base and the rules (for live hints — the server re-checks everything).
async function mealGpsSession(user, purposes) {
  const [settings, base] = await Promise.all([loadAppSettings(), loadBase(user.id)]);
  return { allowed: mayRaiseGps(user, purposes, settings), base, rules: RULES };
}

module.exports = {
  RULES, SCHEME, TRIP_TYPES, mealGpsMap, mealGpsEnabled, mayRaiseGps, parseCoords, baseView,
  parseBaseInput, distanceMeters, normaliseGpsLines, datesTakenElsewhere, mealGpsSession, loadBase, loadRegionSites
};
