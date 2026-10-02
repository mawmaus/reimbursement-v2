'use strict';

// Date-change requests: the live request per document, grants and who may
// decide them.

const { q } = require('../db');
const { iso } = require('./util');

// --- Date-change requests ---------------------------------------------------
// Carried dates are locked on a resubmit (see above). When a claimant genuinely
// needs to re-date a line, they raise a request; anyone with manage_settings
// grants it, and the grant lifts the claim window for that one resubmit.
// One row shape serves all three claim types; this table says how to reach each.
const DCR_TYPES = {
  claim:   { table: 'claims',        lineSql: 'SELECT line_date FROM claim_lines WHERE claim_id = $1',           label: 'reimbursement claim',  editable: ['rejected'] },
  meal:    { table: 'meal_claims',   lineSql: 'SELECT line_date FROM meal_claim_lines WHERE meal_claim_id = $1', label: 'meal allowance claim', editable: ['rejected'] },
  advance: { table: 'cash_advances', lineSql: 'SELECT line_date FROM cash_advance_lines WHERE advance_id = $1',  label: 'cash advance realization', editable: ['rejected_realize'] }
};
const LIVE_DCR = "status IN ('pending', 'granted')";
// Schema changes here are applied by hand (scripts/migrate.js), so a deploy can
// land before the table exists. The reads below sit on the claim-list path, and
// a missing table must not take the whole ledger down with it — 42P01 alone is
// swallowed (no requests can exist yet); every other error still throws.
async function dcrQuery(sql, params) {
  try { return await q(sql, params); }
  catch (e) {
    if (e && e.code === '42P01') {
      console.warn('[date-change] table missing — run scripts/migrate.js');
      return [];
    }
    throw e;
  }
}
// The live (pending or granted) request for one claim, or null.
async function liveDateChange(type, claimId) {
  const rows = await dcrQuery(
    `SELECT * FROM date_change_requests WHERE claim_type = $1 AND claim_id = $2 AND ${LIVE_DCR}`,
    [type, Number(claimId)]);
  return rows[0] || null;
}
// Live requests for many claims of one type, keyed by claim id — for the list
// serializers, which must not fire a query per claim.
async function liveDateChanges(type, ids) {
  if (!ids.length) return {};
  const ph = ids.map((_, i) => `$${i + 2}`).join(',');
  const rows = await dcrQuery(
    `SELECT * FROM date_change_requests WHERE claim_type = $1 AND claim_id IN (${ph}) AND ${LIVE_DCR}`,
    [type, ...ids]);
  const out = {};
  for (const r of rows) out[r.claim_id] = dateChangeView(r);
  return out;
}
// What the claim payload carries about its date lock: null when the dates are
// simply locked, otherwise the live request's state.
function dateChangeView(row) {
  if (!row) return null;
  return {
    id: Number(row.id), status: row.status, reason: row.reason || '',
    decided_name: row.decided_name || '', decided_note: row.decided_note || '',
    created_at: iso(row.created_at), decided_at: iso(row.decided_at)
  };
}
// Is this claim's date lock currently lifted?
const dateChangeGranted = (dc) => !!dc && dc.status === 'granted';
// Burn the grant once the resubmit it was issued for has landed.
async function consumeDateChange(type, claimId) {
  await q(
    `UPDATE date_change_requests SET status = 'used', used_at = now()
      WHERE claim_type = $1 AND claim_id = $2 AND status = 'granted'`,
    [type, Number(claimId)]);
}
// Unlocking a claim's dates is a super-admin decision — it overrides the claim
// window itself, so it does not follow the per-region capability matrix.
const canDecideDateChange = (user) => !!user && user.role === 'superadmin';
function requireSuperadmin(req, res, next) {
  if (!canDecideDateChange(req.user)) {
    return res.status(403).json({ error: 'Only a Super Admin can decide a date change' });
  }
  next();
}
// Who the request email goes to: every active super admin with an address.
async function dateChangeGrantors() {
  return await q(
    `SELECT id, full_name, email FROM users
      WHERE active = TRUE AND email <> '' AND role = 'superadmin'`);
}

module.exports = {
  liveDateChanges, DCR_TYPES, liveDateChange, dateChangeGrantors,
  dateChangeView, canDecideDateChange, dcrQuery, requireSuperadmin,
  dateChangeGranted, consumeDateChange
};
