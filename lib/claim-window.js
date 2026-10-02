'use strict';

// The claim-date window (rolling days / absolute cutoff, per region and time
// zone) and the resubmit rule.

const { q } = require('../db');
const { DEFAULT_TIMEZONE, ALL_REGIONS, regionPrefs, loadAppSettings } = require('./settings');
const { isISODate } = require('./util');

// Today's date (YYYY-MM-DD) in a given time zone — matches the client's
// todayWIB() so a late-evening submission doesn't roll to "tomorrow" via UTC.
// Defaults to the global time zone; a region's own zone is passed in when known.
function todayInZone(tz) { return dateInZone(tz, new Date()); }
// The calendar date (YYYY-MM-DD) a moment fell on in a given time zone.
function dateInZone(tz, when) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(when));
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
// when unrestricted. A rolling window (N days back from today — or from `asOf`,
// to ask what the window was on an earlier day) and an absolute cutoff can both
// be set; the effective floor is the later (max) of the two.
function claimEarliestFrom(cw, asOf) {
  const bounds = [];
  const days = parseInt(cw.claim_max_age_days, 10);
  if (Number.isFinite(days) && days > 0) bounds.push(subDaysISO(asOf || todayInZone(cw.timezone), days));
  if (isISODate(cw.claim_earliest_date)) bounds.push(cw.claim_earliest_date);
  if (!bounds.length) return null;
  return bounds.reduce((a, b) => (a > b ? a : b));
}
// The floor a resubmitted claim's dates are held to. A claim is judged by the
// window it was first submitted into, not the one it comes back to: any date
// that was claimable on the day it first went in stays claimable now, however
// long the claim sat in review. Whichever of the two floors is earlier wins, so
// a date inside today's window always passes too. `firstSubmittedAt` is null for
// a fresh submit, which just faces today's window.
function resubmitEarliest(cw, firstSubmittedAt) {
  const now = claimEarliestFrom(cw);
  if (!now || !firstSubmittedAt) return now;
  const then = claimEarliestFrom(cw, dateInZone(cw.timezone, firstSubmittedAt));
  return then && then < now ? then : now;
}
// Reject a set of expense/line dates if any falls before the policy floor for the
// submitter's `region`. On a resubmit, `firstSubmittedAt` relaxes that floor to
// the window the claim was first submitted into (see resubmitEarliest), and dates
// in `carried` are exempt outright: a rejected claim may always keep the dates it
// already had. Returns { earliest, error } on violation, or null when all dates
// are allowed.
async function claimDateViolation(dates, region, carried, firstSubmittedAt) {
  const cw = claimWindowSettings(await loadAppSettings(), region);
  const kept = carried || new Set();
  // An expense that hasn't happened yet can never be claimed, so today in the
  // region's own time zone is a hard ceiling — unlike the floor below, no policy
  // setting and no granted date change lifts it. Carried dates stay exempt for
  // the same reason they are exempt from the floor.
  const latest = todayInZone(cw.timezone);
  if (dates.some(d => isISODate(d) && d > latest && !kept.has(d))) {
    return { latest, error: 'Expenses cannot be dated in the future.' };
  }
  const earliest = resubmitEarliest(cw, firstSubmittedAt);
  if (!earliest) return null;
  const bad = dates.some(d => isISODate(d) && d < earliest && !kept.has(d));
  if (!bad) return null;
  return {
    earliest,
    error: firstSubmittedAt
      ? `Dates on this claim must be ${earliest} or later — the claim window when it was first submitted.`
      : `Expenses dated before ${earliest} can no longer be claimed.`
  };
}
// When a cash advance's realization first went in — the moment its dates are
// judged by on a resubmit. The advance row's created_at is the request itself.
async function firstRealizedAt(advanceId) {
  const rows = await q(
    `SELECT MIN(created_at) AS at FROM cash_advance_history
      WHERE advance_id = $1 AND action = 'realization submitted'`, [advanceId]);
  return (rows[0] && rows[0].at) || null;
}
// The date floor a returned claim's edit form should use, shipped in the claim
// payload so the client applies exactly the server's rule. Null when no window
// is set.
function dateFloorFor(settings, region, firstSubmittedAt) {
  return resubmitEarliest(claimWindowSettings(settings, region), firstSubmittedAt);
}
// The line dates a claim already carries, for the exemption above.
async function carriedLineDates(sql, id) {
  const rows = await q(sql, [id]);
  return new Set(rows.map(r => String(r.line_date || '')).filter(isISODate));
}
// Response shape for the claim-date policy (shared by GET/PUT /api/claim-window),
// for a given region.
function claimWindowView(settings, region) {
  const cw = claimWindowSettings(settings, region);
  const days = parseInt(cw.claim_max_age_days, 10);
  return {
    max_age_days: Number.isFinite(days) && days > 0 ? days : null,
    earliest_date: isISODate(cw.claim_earliest_date) ? cw.claim_earliest_date : null,
    earliest: claimEarliestFrom(cw),
    // The ceiling every claim shares: no expense may be dated after today.
    latest: todayInZone(cw.timezone)
  };
}

module.exports = {
  dateFloorFor, claimWindowView, claimDateViolation, carriedLineDates,
  firstRealizedAt, todayInZone, subDaysISO, dateInZone, claimWindowSettings,
  claimEarliestFrom, resubmitEarliest
};
