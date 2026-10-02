'use strict';

// Cash advances: request, approve, pay, realize, settle, revert, list,
// detail, receipts and delete.

const express = require('express');
const { q, qq, transaction } = require('../db');
const { deleteReceipt } = require('../lib/blob');
const { notifyPendingApprover, notifyClaimantRejected, notifyClaimantDecision } = require('../lib/notify');
const { requireAuth, requireCap } = require('../lib/auth');
const { ah, asIntArray, intArrayLiteral, DATE_RE } = require('../lib/util');
const {
  computePurposes, resolveSubmitApprovers, currentApproverId, userCanApprove,
  canMarkPaid, resolveRevertApprover1, undoneApprovalStep,
  applyListStatusFilter, applyLedgerWindow, OPEN_ADVANCE_SQL,
  unrealizedAdvanceCount, claimantApprover1Choices
} = require('../lib/workflow');
const {
  normaliseAdvanceRequest, advanceNotify, serializeOneAdvance,
  createCashAdvance, loadAdvanceOr404, ADV_LINE_SEQ, settlementFor,
  planAdvanceRevert, serializeManyAdvance
} = require('../lib/advances');
const { verifyAttachments, MAX_FILES } = require('../lib/uploads');
const { regionPrefsFor, viewRegionFilter, seesAllRegions } = require('../lib/settings');
const { logAdvanceHistory } = require('../lib/documents');
const {
  planLineRejections, applyLineRejections, freezeRejectionsQuery,
  deleteReceiptIfUnused, restoreStepRejections
} = require('../lib/lines');
const { approvalLimitError, fmtMoney } = require('../lib/money');
const { normaliseClaimLines } = require('../lib/claims');
const { liveDateChange, dateChangeGranted, consumeDateChange } = require('../lib/date-changes');
const { carriedLineDates, claimDateViolation, firstRealizedAt } = require('../lib/claim-window');
const { userCan } = require('../lib/permissions');

const router = express.Router();

router.post('/api/cash-advances', requireAuth, ah(async (req, res) => {
  // The grant lives on the account and is enforced here, not merely hidden in the
  // UI. Only CREATION is gated: an account whose grant is revoked mid-flight can
  // still realize and settle advances it was already paid, so no money strands.
  if (!(await computePurposes(req.user)).advance) {
    return res.status(403).json({ error: 'You do not have permission to request a cash advance' });
  }
  const parsed = normaliseAdvanceRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const built = await resolveSubmitApprovers(req.user.approver1_options, req.user.approver_ids, (req.body || {}).approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  // Supporting documents were uploaded straight to Blob by the browser; verify
  // them here and roll them back if the insert fails, exactly as claims do.
  const checked = await verifyAttachments((req.body || {}).attachments);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const region = String(req.user.region || '');
  const currency = parsed.currency || (await regionPrefsFor(region)).currency;
  let id;
  try {
    id = await createCashAdvance(req, parsed.purpose, parsed.amountCents, currency, built.ids, region, checked.items);
  } catch (e) {
    for (const u of checked.items) await deleteReceipt(u.url);
    throw e;
  }
  const rows = await q('SELECT * FROM cash_advances WHERE id = $1', [id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, advanceNotify(rows[0]));
  res.status(201).json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Edit + resubmit a rejected cash-advance request (phase 1 only).
router.put('/api/cash-advances/:id', requireAuth, ah(async (req, res) => {
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
  // Supporting documents: whatever the form sends back as kept survives, the
  // rest is dropped (blob and all) and any fresh upload is verified and linked.
  const checked = await verifyAttachments((req.body || {}).attachments);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const existingDocs = await q('SELECT id, blob_url FROM attachments WHERE advance_id = $1', [row.id]);
  const keepIds = new Set(asIntArray((req.body || {}).keep_attachment_ids));
  const droppedDocs = existingDocs.filter(a => !keepIds.has(Number(a.id)));
  if (existingDocs.length - droppedDocs.length + checked.items.length > MAX_FILES) {
    for (const u of checked.items) await deleteReceipt(u.url);
    return res.status(400).json({ error: `Maximum ${MAX_FILES} files` });
  }
  const currency = parsed.currency || row.currency || (await regionPrefsFor(row.region)).currency;
  try {
    const queries = [qq(
      `UPDATE cash_advances SET claimant_name=$1, department=$2, bank_name=$3, recipient_name=$4,
         bank_account_no=$5, purpose=$6, amount_cents=$7, currency=$8, status='submitted',
         manager_comment='', manager_id=NULL, decided_at=NULL, approver_ids=$9::int[], current_step=$10, updated_at=now()
       WHERE id=$11`,
      [String(emp.full_name || '').trim(), String(emp.department || '').trim(), String(emp.bank_name || '').trim(),
       String(emp.recipient_name || '').trim(), String(emp.bank_account_no || '').trim(),
       parsed.purpose, parsed.amountCents, currency, intArrayLiteral(built.ids),
       built.ids.length ? 1 : 0, row.id])];
    for (const a of droppedDocs) queries.push(qq('DELETE FROM attachments WHERE id = $1', [a.id]));
    for (const d of checked.items) {
      queries.push(qq(
        `INSERT INTO attachments (advance_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
         VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, d.url, d.pathname, d.original_name, d.mime, d.size]));
    }
    await transaction(queries);
  } catch (e) {
    for (const u of checked.items) await deleteReceipt(u.url);
    throw e;
  }
  for (const a of droppedDocs) { try { await deleteReceipt(a.blob_url); } catch { /* ignore */ } }
  await logAdvanceHistory(row.id, req.user, 'resubmitted', 'rejected', 'submitted', String((req.body || {}).resubmit_note || '').trim());
  const rows = await q('SELECT * FROM cash_advances WHERE id = $1', [row.id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, advanceNotify(rows[0]));
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

// Approve — phase-aware: advances the request chain (submitted → approved) or the
// realization chain (realize_submitted → realize_approved).
router.post('/api/cash-advances/:id/approve', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  const realizing = row.status === 'realize_submitted';
  if (row.status !== 'submitted' && !realizing) {
    return res.status(409).json({ error: `Cannot approve a cash advance that is "${row.status}"` });
  }
  if (!userCanApprove(req.user, row)) return res.status(403).json({ error: 'You are not the approver for this step' });
  // Only a realization has lines to reject; the request is a single amount.
  const rejectedLines = req.body && req.body.rejected_lines;
  if (!realizing && Array.isArray(rejectedLines) && rejectedLines.length) {
    return res.status(400).json({ error: 'Lines can only be rejected on a realization' });
  }
  const plan = realizing ? await planLineRejections('advance', row, rejectedLines) : { picks: [] };
  if (plan.error) return res.status(400).json({ error: plan.error });
  const amountForLimit = realizing ? plan.remainingCents : row.amount_cents;
  const le = approvalLimitError(req.user, amountForLimit, row.currency);
  if (le) return res.status(403).json({ error: le });
  await applyLineRejections('advance', row, req.user, plan.picks);
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
router.post('/api/cash-advances/:id/reject', requireAuth, ah(async (req, res) => {
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
router.post('/api/cash-advances/:id/mark-paid', requireAuth, ah(async (req, res) => {
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
  // Only a rejected realization carries its dates through and is judged by the
  // window its realization first went into; a first realization (from 'paid') is
  // a fresh submit and faces today's window. A granted date-change request lifts
  // the window for one resubmit either way.
  const grant = await liveDateChange('advance', row.id);
  if (!dateChangeGranted(grant)) {
    const again = row.status === 'rejected_realize';
    const carried = again
      ? await carriedLineDates('SELECT line_date FROM cash_advance_lines WHERE advance_id = $1', row.id)
      : null;
    const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), row.region, carried,
      again ? await firstRealizedAt(row.id) : null);
    if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  }
  // Approver chain is re-resolved from the claimant's account, like a fresh submit.
  const emp = (await q(
    'SELECT approver_ids, approver1_options FROM users WHERE id = $1', [row.employee_id]))[0] || {};
  const built = await resolveSubmitApprovers(emp.approver1_options, emp.approver_ids, b.approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  // Existing realization receipts (keyed by id) so kept ones survive an edit.
  // Lines an approver rejected aren't part of the edit — they stay as history.
  const existingAtts = await q(
    `SELECT a.id, a.blob_url, a.blob_pathname, a.original_name, a.mime_type, a.size_bytes
       FROM attachments a JOIN cash_advance_lines l ON a.advance_line_id = l.id
      WHERE l.advance_id = $1 AND l.rejected_at IS NULL`, [row.id]);
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
      qq(`DELETE FROM attachments WHERE advance_line_id IN
            (SELECT id FROM cash_advance_lines WHERE advance_id = $1 AND rejected_at IS NULL)`, [advanceId]),
      qq('DELETE FROM cash_advance_lines WHERE advance_id = $1 AND rejected_at IS NULL', [advanceId]),
      freezeRejectionsQuery('advance', advanceId)
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
    for (const a of dropped) await deleteReceiptIfUnused(a.blob_url);
    if (dateChangeGranted(grant)) await consumeDateChange('advance', advanceId);
    const rows = await q('SELECT * FROM cash_advances WHERE id = $1', [advanceId]);
    const first = currentApproverId(rows[0]);
    if (first) await notifyPendingApprover(first, advanceNotify(rows[0]));
    res.json({ claim: await serializeOneAdvance(rows[0]) });
  } catch (e) {
    for (const u of allUploaded) await deleteReceipt(u.url);
    throw e;
  }
}

router.post('/api/cash-advances/:id/realize', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.status !== 'paid') return res.status(409).json({ error: 'The advance must be paid before it can be realized' });
  return submitRealization(req, res, row);
}));

router.put('/api/cash-advances/:id/realize', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.status !== 'rejected_realize') return res.status(409).json({ error: 'Only a rejected realization can be edited and resubmitted' });
  return submitRealization(req, res, row);
}));

// Settle a fully-approved realization (phase 2 → settled), recording the
// direction from settlementFor. Same permission as marking paid.
router.post('/api/cash-advances/:id/settle', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to settle cash advances' });
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  if (row.status !== 'realize_approved') return res.status(409).json({ error: 'Only an approved realization can be settled' });
  const { direction, cents } = settlementFor(row);
  const note = String((req.body && req.body.note) || '').trim();
  await q(`UPDATE cash_advances SET status='settled', settlement_cents=$1, settlement_direction=$2,
            settlement_note=$3, settled_by=$4, settled_at=now(), updated_at=now() WHERE id=$5`,
    [cents, direction, note, req.user.id, row.id]);
  const label = direction === 'topup' ? `settled — top-up ${fmtMoney(cents, row.currency)} to employee`
    : direction === 'return' ? `settled — ${fmtMoney(cents, row.currency)} returned by employee`
    : 'settled — balanced';
  await logAdvanceHistory(row.id, req.user, label, 'realize_approved', 'settled', note);
  const rows = await q('SELECT * FROM cash_advances WHERE id=$1', [row.id]);
  await notifyClaimantDecision(rows[0].employee_id, advanceNotify(rows[0]), 'paid');
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

router.post('/api/cash-advances/:id/revert', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  const step = row.current_step || 0;
  const plan = planAdvanceRevert(row, req.user);
  if (plan.error) return res.status(plan.code).json({ error: plan.error });
  // A revert that lands back on step 1 may re-pick Approver 1 (see
  // resolveRevertApprover1) — resolved before anything moves.
  const reroute = await resolveRevertApprover1(row, plan.kind, (req.body || {}).approver1);
  if (reroute.error) return res.status(400).json({ error: reroute.error });
  await q(`UPDATE cash_advances SET ${plan.sql}, updated_at=now() WHERE id=$1`, [row.id]);
  if (reroute.ids) {
    await q(`UPDATE cash_advances SET approver_ids=$1::int[], updated_at=now() WHERE id=$2`, [intArrayLiteral(reroute.ids), row.id]);
  }
  await logAdvanceHistory(row.id, req.user, plan.action, plan.from, plan.to,
    reroute.ids ? `Approver 1 changed to ${reroute.name}` : (plan.comment || ''));
  // Realization approvals carry line rejections; undoing one restores them.
  if (plan.from === 'realize_approved' || plan.from === 'realize_submitted') {
    await restoreStepRejections('advance', { ...row, status: plan.to }, req.user, undoneApprovalStep(plan.kind, step));
  }
  const rows = await q('SELECT * FROM cash_advances WHERE id=$1', [row.id]);
  if (reroute.ids) await notifyPendingApprover(reroute.chosen, advanceNotify(rows[0]));
  res.json({ claim: await serializeOneAdvance(rows[0]) });
}));

router.get('/api/cash-advances', requireAuth, ah(async (req, res) => {
  const { status, department, q: search } = req.query;
  const where = [];
  const params = [];
  const add = (clause, val) => { params.push(val); where.push(clause.replace('$$', `$${params.length}`)); };
  if (!userCan(req.user, 'view_all_claims')) {
    params.push(req.user.id);
    const p = `$${params.length}`;
    where.push(`(employee_id = ${p} OR ${p} = ANY(approver_ids))`);
  }
  const vr = await viewRegionFilter(req);
  if (vr !== null) { params.push(vr); where.push(`region = $${params.length}`); }
  applyListStatusFilter(status, where, add);
  if (department) add('department = $$', department);
  applyLedgerWindow(req, search, OPEN_ADVANCE_SQL, where, params);
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(advance_no ILIKE ${p} OR claimant_name ILIKE ${p} OR purpose ILIKE ${p})`);
  }
  const rows = await q(
    `SELECT * FROM cash_advances ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC`, params);
  // my_unrealized rides along deliberately unfiltered: the client refreshes the
  // hold from it on every ledger load, and a status/department/search filter on
  // this list must not be able to make the hold look lifted.
  res.json({
    claims: await serializeManyAdvance(rows),
    my_unrealized: await unrealizedAdvanceCount(req.user.id)
  });
}));

router.get('/api/cash-advances/:id', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  // GET /api/cash-advances region-scopes the list via viewRegionFilter; without
  // the same check here a direct id read reached advances from other regions.
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own cash advances' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own cash advances' });
  }
  const claim = await serializeOneAdvance(row);
  // The claimant's Approver 1 candidates ride along on the detail read so the
  // drawer can offer a re-pick when a revert sends this back to step 1.
  claim.approver1_choices = await claimantApprover1Choices(row.employee_id);
  res.json({ claim });
}));

// Download a cash-advance file — either a phase-1 supporting document (linked to
// the advance) or a realization receipt (linked to one of its lines).
// Auth-scoped, streamed from Blob.
router.get('/api/cash-advances/:id/attachments/:attId', requireAuth, ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  // Mirrors GET /api/cash-advances/:id (see the region note there).
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  const rows = await q(
    `SELECT a.* FROM attachments a
      WHERE a.id = $1
        AND (a.advance_id = $2
             OR a.advance_line_id IN (SELECT id FROM cash_advance_lines WHERE advance_id = $2))`,
    [req.params.attId, row.id]);
  const att = rows[0];
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const r = await fetch(att.blob_url);
  if (!r.ok) return res.status(502).json({ error: 'Could not fetch file from storage' });
  const inlineOk = att.mime_type === 'application/pdf' || att.mime_type.startsWith('image/');
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.original_name)}"`);
  res.send(Buffer.from(await r.arrayBuffer()));
}));

// Delete a cash advance outright (super admin only) — clears its supporting
// documents and realization receipts (blobs), lines and history first.
router.delete('/api/cash-advances/:id', requireAuth, requireCap('delete_claims'), ah(async (req, res) => {
  const row = await loadAdvanceOr404(req, res);
  if (!row) return;
  const atts = await q(
    `SELECT a.blob_url FROM attachments a
      WHERE a.advance_id = $1
         OR a.advance_line_id IN (SELECT id FROM cash_advance_lines WHERE advance_id = $1)`, [row.id]);
  const advanceId = Number(row.id);
  await transaction([
    qq(`DELETE FROM attachments WHERE advance_id = $1
          OR advance_line_id IN (SELECT id FROM cash_advance_lines WHERE advance_id = $1)`, [advanceId]),
    qq('DELETE FROM cash_advance_lines WHERE advance_id = $1', [advanceId]),
    qq('DELETE FROM cash_advance_history WHERE advance_id = $1', [advanceId]),
    qq('DELETE FROM cash_advances WHERE id = $1', [advanceId])
  ]);
  // A realization receipt re-linked onto a re-claim keeps its blob for that claim.
  for (const a of atts) await deleteReceiptIfUnused(a.blob_url);
  res.json({ ok: true });
}));

module.exports = router;
