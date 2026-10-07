'use strict';

// Meal-allowance claims: list, summary, detail, submit, edit, approve,
// reject, pay, revert and delete.

const express = require('express');
const { q, qq, transaction } = require('../db');
const { notifyPendingApprover, notifyClaimantRejected, notifyClaimantDecision } = require('../lib/notify');
const { requireAuth, requireCap, refuseOutOfRegion } = require('../lib/auth');
const { ah, asIntArray, intArrayLiteral, DATE_RE, likeContains } = require('../lib/util');
const { userCan } = require('../lib/permissions');
const { viewRegionFilter, seesAllRegions } = require('../lib/settings');
const {
  applyListStatusFilter, applyLedgerWindow, OPEN_CLAIM_SQL,
  claimantApprover1Choices, heldByUnrealizedAdvance, resolveSubmitApprovers,
  currentApproverId, mealNotify, userCanApprove, canMarkPaid, planRevert,
  resolveRevertApprover1, undoneApprovalStep, revertSet, moveDocument, STALE_DOCUMENT
} = require('../lib/workflow');
const {
  serializeManyMeal, loadMealClaimOr404, serializeOneMeal, normaliseMealLines,
  createMealClaim, mealLineQuery
} = require('../lib/meals');
const {
  releaseCarriedQueries, resolveLineSource, freezeRejectionsQuery,
  planLineRejections, applyLineRejections, restoreStepRejections
} = require('../lib/lines');
const { claimDateViolation, carriedLineDates } = require('../lib/claim-window');
const { liveDateChange, dateChangeGranted, consumeDateChange } = require('../lib/date-changes');
const { approvalLimitError } = require('../lib/money');
const { logMealHistory } = require('../lib/documents');

const router = express.Router();

router.get('/api/meal-claims', requireAuth, ah(async (req, res) => {
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
  applyLedgerWindow(req, search, OPEN_CLAIM_SQL, where, params);
  if (search) {
    params.push(likeContains(search));
    const p = `$${params.length}`;
    // Meal claims carry the DB number per line (meal_claim_lines.site), so search
    // it via EXISTS in addition to the header fields.
    where.push(`(claim_no ILIKE ${p} OR claimant_name ILIKE ${p} OR EXISTS (SELECT 1 FROM meal_claim_lines l WHERE l.meal_claim_id = meal_claims.id AND l.site ILIKE ${p}))`);
  }
  const rows = await q(
    `SELECT * FROM meal_claims ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC`, params);
  res.json({ claims: await serializeManyMeal(rows, { listFor: req.user }) });
}));

router.get('/api/meal-claims/summary', requireAuth, ah(async (req, res) => {
  const where = [];
  const params = [];
  if (!userCan(req.user, 'view_all_claims')) {
    params.push(req.user.id);
    where.push(`(employee_id = $${params.length} OR $${params.length} = ANY(approver_ids))`);
  }
  const vr = await viewRegionFilter(req);
  if (vr !== null) { params.push(vr); where.push(`region = $${params.length}`); }
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

router.get('/api/meal-claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own meal claims' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own meal claims' });
  }
  const claim = await serializeOneMeal(row);
  // The claimant's Approver 1 candidates ride along on the detail read so the
  // drawer can offer a re-pick when a revert sends this back to step 1.
  claim.approver1_choices = await claimantApprover1Choices(row.employee_id);
  res.json({ claim });
}));

// Delete a meal allowance claim outright (super admin only) — removes its line
// items and history first. For clearing test data; no undo.
router.delete('/api/meal-claims/:id', requireAuth, requireCap('delete_claims'), ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  const claimId = Number(row.id);
  await transaction([
    qq('DELETE FROM meal_claim_lines WHERE meal_claim_id = $1', [claimId]),
    qq('DELETE FROM meal_claim_history WHERE meal_claim_id = $1', [claimId]),
    qq('DELETE FROM meal_claims WHERE id = $1', [claimId]),
    ...releaseCarriedQueries(['meal'], row.claim_no)
  ]);
  res.json({ ok: true });
}));

router.post('/api/meal-claims', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  // A re-claim of rejected lines isn't a new claim (see POST /api/claims).
  const src = await resolveLineSource(req, 'meal', b.source);
  if (src && src.error) return res.status(400).json({ error: src.error });
  if (!src && await heldByUnrealizedAdvance(req, res)) return;
  const parsed = normaliseMealLines(b.lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region,
    src ? src.carried : undefined, src ? src.windowFrom : undefined);
  if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  const built = await resolveSubmitApprovers(req.user.approver1_options, req.user.approver_ids, (req.body || {}).approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  const approverIds = built.ids;
  // Region is glued to the account — every claim inherits the submitter's.
  const claimRegion = String(req.user.region || '');
  const claimId = await createMealClaim(req, parsed.lines, parsed.totalCents, approverIds, claimRegion, src);
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [claimId]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, mealNotify(rows[0]));
  res.status(201).json({ claim: await serializeOneMeal(rows[0]) });
}));

router.put('/api/meal-claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  if (row.employee_id !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You can only edit your own meal claims' });
  }
  if (row.status !== 'rejected') {
    return res.status(409).json({ error: 'Only rejected meal claims can be edited and resubmitted' });
  }
  const parsed = normaliseMealLines((req.body || {}).lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // Same rule as reimbursement claims: judged by the window it was first
  // submitted into, and a granted date-change request lifts the window outright.
  const grant = await liveDateChange('meal', row.id);
  if (!dateChangeGranted(grant)) {
    const carried = await carriedLineDates('SELECT line_date FROM meal_claim_lines WHERE meal_claim_id = $1', row.id);
    const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region, carried, row.window_from || row.created_at);
    if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  }
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
    // Lines an approver rejected stay as history; only the live ones are rebuilt.
    qq('DELETE FROM meal_claim_lines WHERE meal_claim_id = $1 AND rejected_at IS NULL', [claimId]),
    freezeRejectionsQuery('meal', claimId)];
  parsed.lines.forEach((l, i) => queries.push(mealLineQuery(claimId, l, i)));
  queries.push(qq(
    `INSERT INTO meal_claim_history (meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,'resubmitted','rejected','submitted',$4)`,
    [claimId, req.user.id, String(req.user.full_name || '').trim(), String((req.body && req.body.resubmit_note) || '').trim()]));
  await transaction(queries);
  if (dateChangeGranted(grant)) await consumeDateChange('meal', row.id);
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [row.id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, mealNotify(rows[0]));
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

router.post('/api/meal-claims/:id/approve', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot approve a meal claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) return res.status(403).json({ error: 'You are not the approver for this step' });
  const plan = await planLineRejections('meal', row, req.body && req.body.rejected_lines);
  if (plan.error) return res.status(400).json({ error: plan.error });
  const le = approvalLimitError(req.user, plan.remainingCents, row.currency);
  if (le) return res.status(403).json({ error: le });
  const comment = String((req.body && req.body.comment) || '').trim();
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  const finalise = req.user.role === 'superadmin' || !ids.length || step >= ids.length;
  const moved = finalise
    ? await moveDocument('meal_claims', row, `status='approved', manager_id=$1, manager_comment=$2, decided_at=now()`, [req.user.id, comment])
    : await moveDocument('meal_claims', row, 'current_step=$1', [step + 1]);
  if (!moved) return res.status(409).json({ error: STALE_DOCUMENT });
  await applyLineRejections('meal', row, req.user, plan.picks);
  if (finalise) {
    await logMealHistory(row.id, req.user, ids.length ? `approved — step ${step} of ${ids.length}` : 'approved', 'submitted', 'approved', comment);
  } else {
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

router.post('/api/meal-claims/:id/reject', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  const comment = String((req.body && req.body.comment) || '').trim();
  if (!comment) return res.status(400).json({ error: 'A reason is required when rejecting a claim' });
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot reject a meal claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) return res.status(403).json({ error: 'You are not the approver for this claim' });
  if (!await moveDocument('meal_claims', row, `status='rejected', manager_id=$1, manager_comment=$2, decided_at=now()`, [req.user.id, comment])) {
    return res.status(409).json({ error: STALE_DOCUMENT });
  }
  await logMealHistory(row.id, req.user, 'rejected', 'submitted', 'rejected', comment);
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  await notifyClaimantRejected(rows[0].employee_id, { ...mealNotify(rows[0]), reason: comment });
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

router.post('/api/meal-claims/:id/mark-paid', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to mark claims as paid' });
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved meal claims can be marked as paid' });
  const paymentDate = String((req.body && req.body.payment_date) || '').trim();
  if (!DATE_RE.test(paymentDate)) return res.status(400).json({ error: 'A payment date is required to mark a claim as paid' });
  if (!await moveDocument('meal_claims', row, `status='paid', paid_by=$1, paid_at=$2`, [req.user.id, paymentDate])) {
    return res.status(409).json({ error: STALE_DOCUMENT });
  }
  await logMealHistory(row.id, req.user, `marked paid — ${paymentDate}`, 'approved', 'paid', String((req.body && req.body.comment) || '').trim());
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  await notifyClaimantDecision(rows[0].employee_id, mealNotify(rows[0]), 'paid');
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

// Revert a meal allowance claim one step back (see planRevert).
router.post('/api/meal-claims/:id/revert', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  const plan = planRevert(row, req.user);
  if (plan.error) return res.status(plan.code).json({ error: plan.error });
  const reroute = await resolveRevertApprover1(row, plan.kind, (req.body || {}).approver1);
  if (reroute.error) return res.status(400).json({ error: reroute.error });
  const step = row.current_step || 0;
  const { set, params } = revertSet(plan, step);
  if (!await moveDocument('meal_claims', row, set, params)) return res.status(409).json({ error: STALE_DOCUMENT });
  if (reroute.ids) {
    await q(`UPDATE meal_claims SET approver_ids=$1::int[], updated_at=now() WHERE id=$2`, [intArrayLiteral(reroute.ids), row.id]);
  }
  await logMealHistory(row.id, req.user, plan.action, plan.from, plan.to,
    reroute.ids ? `Approver 1 changed to ${reroute.name}` : (plan.comment || ''));
  await restoreStepRejections('meal', { ...row, status: plan.to }, req.user, undoneApprovalStep(plan.kind, step));
  const rows = await q('SELECT * FROM meal_claims WHERE id=$1', [row.id]);
  if (reroute.ids) await notifyPendingApprover(reroute.chosen, mealNotify(rows[0]));
  res.json({ claim: await serializeOneMeal(rows[0]) });
}));

module.exports = router;
