'use strict';

// Raising, listing and deciding date-change requests.

const express = require('express');
const { q } = require('../db');
const { notifyDateChangeRequested, notifyDateChangeDecided } = require('../lib/notify');
const {
  DCR_TYPES, liveDateChange, dateChangeGrantors, dateChangeView,
  canDecideDateChange, dcrQuery, requireSuperadmin
} = require('../lib/date-changes');
const { requireAuth } = require('../lib/auth');
const { ah } = require('../lib/util');
const { resolveLookupRegion } = require('../lib/settings');

const router = express.Router();

// --- Date-change requests: raise, list, decide ------------------------------
// The claimant asks for their locked dates to be unlocked; someone who can
// manage settings grants or declines it. A grant lifts the claim window for
// exactly one resubmit of that claim.

// Load the claim a request is about, checking the caller owns it and that it is
// actually sitting in an editable (rejected) state. Returns { row, spec } or
// sends the error itself and returns null.
async function loadDcrTarget(req, res, type, claimId) {
  const spec = DCR_TYPES[type];
  if (!spec) { res.status(400).json({ error: 'Unknown claim type' }); return null; }
  const id = Number(claimId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Unknown claim' }); return null; }
  const rows = await q(`SELECT * FROM ${spec.table} WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Claim not found' }); return null; }
  if (Number(row.employee_id) !== req.user.id && req.user.role !== 'superadmin') {
    res.status(403).json({ error: 'You can only request a date change on your own claim' }); return null;
  }
  if (!spec.editable.includes(row.status)) {
    res.status(409).json({ error: 'Only a returned claim you are about to resubmit can have its dates unlocked' });
    return null;
  }
  return { row, spec };
}

router.post('/api/date-change-requests', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const type = String(b.claim_type || '');
  const target = await loadDcrTarget(req, res, type, b.claim_id);
  if (!target) return;
  const reason = String(b.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Tell the approver why the dates need to change' });
  if (reason.length > 500) return res.status(400).json({ error: 'Keep the reason under 500 characters' });
  const existing = await liveDateChange(type, target.row.id);
  if (existing) {
    return res.status(409).json({
      error: existing.status === 'granted'
        ? 'The dates on this claim are already unlocked'
        : 'A date change has already been requested for this claim',
      date_change: dateChangeView(existing)
    });
  }
  const region = String(target.row.region || '');
  const inserted = await q(
    `INSERT INTO date_change_requests (claim_type, claim_id, region, employee_id, claim_no, reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [type, Number(target.row.id), region, Number(target.row.employee_id), String(target.row.claim_no || target.row.advance_no || ''), reason]);
  const payload = {
    claimNo: inserted[0].claim_no, typeLabel: target.spec.label,
    claimantName: target.row.claimant_name || req.user.full_name, reason
  };
  await notifyDateChangeRequested(await dateChangeGrantors(), payload);
  res.status(201).json({ date_change: dateChangeView(inserted[0]) });
}));

// One list, two audiences: a super admin gets the whole queue to decide on
// (optionally scoped to a region), and everyone else gets their own requests so
// the Date changes page can show them where each one stands. `can_decide` tells
// the client which of the two it is holding.
router.get('/api/date-change-requests', requireAuth, ah(async (req, res) => {
  const decider = canDecideDateChange(req.user);
  const where = ["(r.status = 'pending' OR r.decided_at > now() - INTERVAL '90 days')"];
  const params = [];
  if (decider) {
    const region = await resolveLookupRegion(req.user, req.query.region);
    if (region === null) return res.status(400).json({ error: 'Invalid region' });
    if (region) { params.push(region); where.push(`r.region = $${params.length}`); }
  } else {
    params.push(req.user.id);
    where.push(`r.employee_id = $${params.length}`);
  }
  const rows = await dcrQuery(
    `SELECT r.*, u.full_name AS employee_name
       FROM date_change_requests r JOIN users u ON u.id = r.employee_id
      WHERE ${where.join(' AND ')}
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`, params);
  res.json({
    can_decide: decider,
    requests: rows.map(r => ({
      ...dateChangeView(r),
      claim_type: r.claim_type, claim_id: Number(r.claim_id), claim_no: r.claim_no,
      region: r.region, employee_name: r.employee_name,
      type_label: (DCR_TYPES[r.claim_type] || {}).label || r.claim_type
    }))
  });
}));

router.post('/api/date-change-requests/:id/decide', requireAuth, requireSuperadmin, ah(async (req, res) => {
  const b = req.body || {};
  const rows = await q('SELECT * FROM date_change_requests WHERE id = $1', [req.params.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.status !== 'pending') return res.status(409).json({ error: 'This request has already been decided' });
  const grant = b.grant === true || b.grant === 'true';
  const note = String(b.note || '').trim().slice(0, 500);
  const updated = await q(
    `UPDATE date_change_requests
        SET status = $1, decided_by = $2, decided_name = $3, decided_note = $4, decided_at = now()
      WHERE id = $5 AND status = 'pending' RETURNING *`,
    [grant ? 'granted' : 'declined', req.user.id, req.user.full_name, note, row.id]);
  if (!updated[0]) return res.status(409).json({ error: 'This request has already been decided' });
  await notifyDateChangeDecided(Number(row.employee_id), {
    claimNo: row.claim_no, typeLabel: (DCR_TYPES[row.claim_type] || {}).label || row.claim_type,
    granted: grant, deciderName: req.user.full_name, note
  });
  res.json({ request: dateChangeView(updated[0]) });
}));

module.exports = router;
