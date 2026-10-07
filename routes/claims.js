'use strict';

// Reimbursement claims: list, summary, detail, submit, edit, approve, reject,
// pay, revert, receipts and delete.

const express = require('express');
const { q, qq, transaction } = require('../db');
const { deleteReceipt, sendReceipt } = require('../lib/blob');
const { notifyPendingApprover, notifyClaimantRejected, notifyClaimantDecision } = require('../lib/notify');
const { requireAuth, requireCap, refuseOutOfRegion } = require('../lib/auth');
const { ah, asIntArray, intArrayLiteral, DATE_RE, likeContains } = require('../lib/util');
const { userCan } = require('../lib/permissions');
const { viewRegionFilter, seesAllRegions } = require('../lib/settings');
const {
  applyListStatusFilter, applyLedgerWindow, OPEN_CLAIM_SQL,
  claimantApprover1Choices, heldByUnrealizedAdvance, resolveSubmitApprovers,
  currentApproverId, reimbNotify, userCanApprove, canMarkPaid, planRevert,
  resolveRevertApprover1, undoneApprovalStep, revertSet, moveDocument, STALE_DOCUMENT,
  stillAsRead, isStaleAbort
} = require('../lib/workflow');
const {
  serializeMany, loadClaimOr404, serializeOne, normaliseClaimLines,
  createClaim, LINE_SEQ
} = require('../lib/claims');
const {
  resolveLineSource, freezeRejectionsQuery, deleteReceiptIfUnused,
  planLineRejections, applyLineRejections, restoreStepRejections,
  releaseCarriedQueries
} = require('../lib/lines');
const { claimDateViolation, carriedLineDates } = require('../lib/claim-window');
const { verifyAttachments } = require('../lib/uploads');
const { liveDateChange, dateChangeGranted, consumeDateChange } = require('../lib/date-changes');
const { claimHeaderFromLines, logHistory } = require('../lib/documents');
const { approvalLimitError } = require('../lib/money');

const router = express.Router();

router.get('/api/claims', requireAuth, ah(async (req, res) => {
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
    where.push(`(claim_no ILIKE ${p} OR claimant_name ILIKE ${p} OR recipient_name ILIKE ${p} OR expense_type ILIKE ${p} OR db_no ILIKE ${p})`);
  }
  const rows = await q(
    `SELECT * FROM claims ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC`, params);
  res.json({ claims: await serializeMany(rows, { listFor: req.user }) });
}));

router.get('/api/claims/summary', requireAuth, ah(async (req, res) => {
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
    `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS total
     FROM claims ${scope} GROUP BY status`, params);
  const summary = { submitted: 0, approved: 0, rejected: 0, paid: 0, total_amount: 0 };
  for (const r of rows) {
    summary[r.status] = Number(r.n);
    summary.total_amount += Number(r.total) / 100;
  }
  res.json({ summary });
}));

router.get('/api/claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own claims' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own claims' });
  }
  const claim = await serializeOne(row);
  // The claimant's Approver 1 candidates ride along on the detail read so the
  // drawer can offer a re-pick when a revert sends this back to step 1.
  claim.approver1_choices = await claimantApprover1Choices(row.employee_id);
  res.json({ claim });
}));

router.post('/api/claims', requireAuth, ah(async (req, res) => {
    const b = req.body || {};
    // Re-claiming another document's rejected lines corrects an expense already
    // submitted, so it isn't held back by an unrealized advance the way a brand
    // new claim is. Both checks run before any parsing or receipt verification —
    // no point doing that work for a doomed submission.
    const src = await resolveLineSource(req, 'claim', b.source);
    if (src && src.error) return res.status(400).json({ error: src.error });
    if (!src && await heldByUnrealizedAdvance(req, res)) return;
    const parsed = normaliseClaimLines(b.lines);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    // Enforce the claim-date policy across every line's date. A re-claim keeps
    // its source lines' dates and is judged by the window the source was first
    // submitted into.
    const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region,
      src ? src.carried : undefined, src ? src.windowFrom : undefined);
    if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
    // Receipts carried over from the source lines, re-linked rather than re-uploaded.
    const srcAtts = new Map(((src && src.atts) || []).map(a => [Number(a.id), a]));
    const keptByLine = parsed.lines.map(l => l.keepIds.filter(id => srcAtts.has(id)).map(id => srcAtts.get(id)));
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
    let claimId;
    try {
      claimId = await createClaim(req, b, parsed.lines, verifiedByLine, parsed.totalCents, built.ids, claimRegion, src, keptByLine);
    } catch (e) {
      for (const u of allUploaded) await deleteReceipt(u.url);
      throw e;
    }
    // Committed: the receipts belong to the claim now, so a failure from here
    // on must not reach the clean-up above.
    const rows = await q('SELECT * FROM claims WHERE id = $1', [claimId]);
    const first = currentApproverId(rows[0]);
    if (first) await notifyPendingApprover(first, reimbNotify(rows[0]));
    res.status(201).json({ claim: await serializeOne(rows[0]) });
  }));

router.put('/api/claims/:id', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  if (row.employee_id !== req.user.id && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'You can only edit your own claims' });
  }
  if (row.status !== 'rejected') {
    return res.status(409).json({ error: 'Only rejected claims can be edited and resubmitted' });
  }
  const b = req.body || {};
  const parsed = normaliseClaimLines(b.lines);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // A rejected claim may keep the dates it already had, and may be re-dated to
  // anything that was inside the claim window when it was first submitted. A
  // granted date-change request lifts the window entirely for this one resubmit.
  const grant = await liveDateChange('claim', row.id);
  if (!dateChangeGranted(grant)) {
    const carried = await carriedLineDates('SELECT line_date FROM claim_lines WHERE claim_id = $1', row.id);
    const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region, carried, row.window_from || row.created_at);
    if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  }

  // Existing receipts, keyed by id, so kept ones can be re-linked (to the same
  // blob) onto the new lines. Each line carries keep_attachment_ids + new uploads.
  // Lines an approver rejected aren't part of the edit: they stay on the claim as
  // history (re-claimed on a new claim instead), receipts and all.
  const existingAtts = await q(
    `SELECT id, blob_url, blob_pathname, original_name, mime_type, size_bytes FROM attachments
      WHERE claim_id = $1 AND (line_id IS NULL OR line_id NOT IN
        (SELECT id FROM claim_lines WHERE claim_id = $1 AND rejected_at IS NOT NULL))`, [row.id]);
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
      stillAsRead('claims', row),
      qq(`UPDATE claims SET claimant_name=$1, expense_date=$2, department=$3, db_no=$4, bank_name=$5,
            recipient_name=$6, bank_account_no=$7, expense_type=$8, amount_cents=$9, currency=$10,
            description=$11, status='submitted', manager_comment='', manager_id=NULL,
            decided_at=NULL, approver_ids=$12::int[], current_step=$13, updated_at=now() WHERE id=$14`,
        [String(emp.full_name || '').trim(), h.expense_date, String(emp.department || '').trim(),
         h.db_no, String(emp.bank_name || '').trim(), String(emp.recipient_name || '').trim(),
         String(emp.bank_account_no || '').trim(),
         h.expense_type, parsed.totalCents, String(b.currency || row.currency).trim().slice(0, 8),
         h.description, intArrayLiteral(built.ids), built.ids.length ? 1 : 0, claimId]),
      qq(`DELETE FROM attachments WHERE claim_id = $1 AND (line_id IS NULL OR line_id NOT IN
            (SELECT id FROM claim_lines WHERE claim_id = $1 AND rejected_at IS NOT NULL))`, [claimId]),
      qq('DELETE FROM claim_lines WHERE claim_id = $1 AND rejected_at IS NULL', [claimId]),
      freezeRejectionsQuery('claim', claimId)
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
  } catch (e) {
    for (const u of allUploaded) await deleteReceipt(u.url);
    if (isStaleAbort(e)) return res.status(409).json({ error: STALE_DOCUMENT });
    throw e;
  }
  // Committed: the new receipts are the claim's now, so nothing below may bin
  // them. Only now do we bin the blobs of the removed receipts (a blob delete
  // can't be rolled back).
  for (const a of dropped) await deleteReceiptIfUnused(a.blob_url);
  // The grant covered this one resubmit; spend it so the next round re-locks.
  if (dateChangeGranted(grant)) await consumeDateChange('claim', row.id);
  const rows = await q('SELECT * FROM claims WHERE id = $1', [row.id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, reimbNotify(rows[0]));
  res.json({ claim: await serializeOne(rows[0]) });
}));

router.post('/api/claims/:id/approve', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot approve a claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) {
    return res.status(403).json({ error: 'You are not the approver for this step' });
  }
  // Lines this approver rejects drop out first; the limit applies to what's left.
  const plan = await planLineRejections('claim', row, req.body && req.body.rejected_lines);
  if (plan.error) return res.status(400).json({ error: plan.error });
  const le = approvalLimitError(req.user, plan.remainingCents, row.currency);
  if (le) return res.status(403).json({ error: le });
  const comment = String((req.body && req.body.comment) || '').trim();
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  // A superadmin override finalises immediately; otherwise advance one step and
  // only mark fully approved once the last approver has signed off.
  const finalise = req.user.role === 'superadmin' || !ids.length || step >= ids.length;
  const moved = finalise
    ? await moveDocument('claims', row, `status='approved', manager_id=$1, manager_comment=$2, decided_at=now()`, [req.user.id, comment])
    : await moveDocument('claims', row, 'current_step=$1', [step + 1]);
  if (!moved) return res.status(409).json({ error: STALE_DOCUMENT });
  await applyLineRejections('claim', row, req.user, plan.picks);
  if (finalise) {
    await logHistory(row.id, req.user, ids.length ? `approved — step ${step} of ${ids.length}` : 'approved', 'submitted', 'approved', comment);
  } else {
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

router.post('/api/claims/:id/reject', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  const comment = String((req.body && req.body.comment) || '').trim();
  if (!comment) return res.status(400).json({ error: 'A reason is required when rejecting a claim' });
  if (row.status !== 'submitted') return res.status(409).json({ error: `Cannot reject a claim that is "${row.status}"` });
  if (!userCanApprove(req.user, row)) {
    return res.status(403).json({ error: 'You are not the approver for this claim' });
  }
  if (!await moveDocument('claims', row, `status='rejected', manager_id=$1, manager_comment=$2, decided_at=now()`, [req.user.id, comment])) {
    return res.status(409).json({ error: STALE_DOCUMENT });
  }
  await logHistory(row.id, req.user, 'rejected', 'submitted', 'rejected', comment);
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  await notifyClaimantRejected(rows[0].employee_id, { ...reimbNotify(rows[0]), reason: comment });
  res.json({ claim: await serializeOne(rows[0]) });
}));

router.post('/api/claims/:id/mark-paid', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to mark claims as paid' });
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  if (row.status !== 'approved') return res.status(409).json({ error: 'Only approved claims can be marked as paid' });
  const paymentDate = String((req.body && req.body.payment_date) || '').trim();
  if (!DATE_RE.test(paymentDate)) return res.status(400).json({ error: 'A payment date is required to mark a claim as paid' });
  if (!await moveDocument('claims', row, `status='paid', paid_by=$1, paid_at=$2`, [req.user.id, paymentDate])) {
    return res.status(409).json({ error: STALE_DOCUMENT });
  }
  await logHistory(row.id, req.user, `marked paid — ${paymentDate}`, 'approved', 'paid', String((req.body && req.body.comment) || '').trim());
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  await notifyClaimantDecision(rows[0].employee_id, reimbNotify(rows[0]), 'paid');
  res.json({ claim: await serializeOne(rows[0]) });
}));

// Revert a reimbursement claim one step back (see planRevert).
router.post('/api/claims/:id/revert', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  const plan = planRevert(row, req.user);
  if (plan.error) return res.status(plan.code).json({ error: plan.error });
  // A revert that lands back on step 1 may re-pick Approver 1 (see
  // resolveRevertApprover1). Resolved before anything moves, so a bad choice
  // fails cleanly instead of half-applying the revert.
  const reroute = await resolveRevertApprover1(row, plan.kind, (req.body || {}).approver1);
  if (reroute.error) return res.status(400).json({ error: reroute.error });
  const step = row.current_step || 0;
  const { set, params } = revertSet(plan, step);
  if (!await moveDocument('claims', row, set, params)) return res.status(409).json({ error: STALE_DOCUMENT });
  if (reroute.ids) {
    await q(`UPDATE claims SET approver_ids=$1::int[], updated_at=now() WHERE id=$2`, [intArrayLiteral(reroute.ids), row.id]);
  }
  await logHistory(row.id, req.user, plan.action, plan.from, plan.to,
    reroute.ids ? `Approver 1 changed to ${reroute.name}` : (plan.comment || ''));
  await restoreStepRejections('claim', { ...row, status: plan.to }, req.user, undoneApprovalStep(plan.kind, step));
  const rows = await q('SELECT * FROM claims WHERE id=$1', [row.id]);
  // A revert is silent, but a re-route hands the claim to someone who has no
  // other way of knowing it is now theirs.
  if (reroute.ids) await notifyPendingApprover(reroute.chosen, reimbNotify(rows[0]));
  res.json({ claim: await serializeOne(rows[0]) });
}));

// Download an attachment — auth-scoped, streamed from Blob (URL never exposed).
router.get('/api/claims/:id/attachments/:attId', requireAuth, ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  // Mirrors GET /api/claims/:id exactly — region first, then ownership. Anyone
  // who can open the claim must be able to fetch its receipts, or PDF export
  // silently drops them; anyone who can't must not reach them out of region.
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  const rows = await q('SELECT * FROM attachments WHERE id=$1 AND claim_id=$2', [req.params.attId, row.id]);
  const att = rows[0];
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  await sendReceipt(res, att);
}));

// Delete a reimbursement claim outright (super admin only) — clears its
// attachments (and their blobs) and history first. Meant for tidying up test
// data; there is no undo.
router.delete('/api/claims/:id', requireAuth, requireCap('delete_claims'), ah(async (req, res) => {
  const row = await loadClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  const atts = await q('SELECT blob_url FROM attachments WHERE claim_id = $1', [row.id]);
  // Remove the database rows atomically first; only once that commits do we
  // delete the blobs (which can't be rolled back). If the transaction fails the
  // blobs are untouched, so we never orphan a claim that points at missing files.
  // Rejected lines that had been re-claimed on this claim become re-claimable.
  const claimId = Number(row.id);
  await transaction([
    qq('DELETE FROM attachments WHERE claim_id = $1', [claimId]),
    qq('DELETE FROM claim_history WHERE claim_id = $1', [claimId]),
    qq('DELETE FROM claims WHERE id = $1', [claimId]),
    ...releaseCarriedQueries(['claim', 'advance'], row.claim_no)
  ]);
  // A receipt re-linked from (or onto) a re-claim shares its blob — keep it
  // while the other claim still uses it.
  for (const a of atts) await deleteReceiptIfUnused(a.blob_url);
  res.json({ ok: true });
}));

module.exports = router;
