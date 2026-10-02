'use strict';

// Cash advances: numbering, history, serialization, request validation,
// creation, settlement and the revert plan.

const { q, qq, transaction } = require('../db');
const { iso, asIntArray, groupBy, intArrayLiteral } = require('./util');
const { lineDecision, approverNames } = require('./documents');
const { liveDateChanges } = require('./date-changes');
const { loadAppSettings } = require('./settings');
const { dateFloorFor } = require('./claim-window');
const { parseAmountToCents } = require('./money');
const { canMarkPaid } = require('./workflow');

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
function advanceNotify(row) {
  return { claimNo: row.advance_no, claimantName: row.claimant_name,
    typeLabel: 'cash advance', amount: Number(row.amount_cents) / 100, currency: row.currency };
}
function baseAdvance(row, lines, attByLine, history, nameMap, docs) {
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
    // Phase-1 supporting documents, attached to the request itself. The
    // realization's receipts stay on their lines, below.
    attachments: (docs || []).map(attView),
    lines: (lines || []).map(l => ({
      id: l.id, line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: Number(l.amount_cents) / 100, description: l.description,
      attachments: ((attByLine && attByLine[l.id]) || []).map(attView),
      ...lineDecision(l)
    })),
    // Everything the realization listed, rejected lines included;
    // `realized_total` is what counts against the advance.
    claimed_realized_total: (lines || []).reduce((s, l) => s + Number(l.amount_cents), 0) / 100,
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
  const [lines, atts, docs, hist, nameMap, dc, settings] = await Promise.all([
    q(`SELECT * FROM cash_advance_lines WHERE advance_id IN (${ph}) ORDER BY sort_order, id`, ids),
    // Line receipts, reached through the lines in one query rather than a
    // second round-trip after the lines come back.
    q(`SELECT a.id, a.advance_line_id, a.original_name, a.mime_type, a.size_bytes, a.uploaded_at
       FROM attachments a JOIN cash_advance_lines cl ON cl.id = a.advance_line_id
       WHERE cl.advance_id IN (${ph}) ORDER BY a.id`, ids),
    // Phase-1 supporting documents hang off the advance, not a line.
    q(`SELECT id, advance_id, original_name, mime_type, size_bytes, uploaded_at
       FROM attachments WHERE advance_id IN (${ph}) ORDER BY id`, ids),
    q(`SELECT advance_id, actor_id, actor_name, action, from_status, to_status, comment, created_at
       FROM cash_advance_history WHERE advance_id IN (${ph}) ORDER BY id`, ids),
    approverNames(rows),
    liveDateChanges('advance', ids),
    loadAppSettings()
  ]);
  const l = groupBy(lines, 'advance_id');
  const attByLine = groupBy(atts, 'advance_line_id');
  const docsByAdvance = groupBy(docs, 'advance_id');
  const h = groupBy(hist, 'advance_id');
  // A returned realization is judged by when it first went in (see firstRealizedAt).
  const realizedAt = (id) => ((h[id] || []).find(x => x.action === 'realization submitted') || {}).created_at || null;
  return rows.map(r => ({ ...baseAdvance(r, l[r.id], attByLine, h[r.id], nameMap, docsByAdvance[r.id]), date_change: dc[r.id] || null,
    date_floor: r.status === 'rejected_realize' ? dateFloorFor(settings, r.region, realizedAt(r.id)) : null,
    reclaim_floor: dateFloorFor(settings, r.region, realizedAt(r.id)) }));
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
// realization — but the request can carry its own supporting documents, which
// link straight to the advance. Retries on an advance_no collision (see
// createClaim).
async function createCashAdvance(req, purpose, amountCents, currency, approverIds, region, docs) {
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
    for (const d of (docs || [])) {
      queries.push(qq(
        `INSERT INTO attachments (advance_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
         VALUES (currval(${ADV_SEQ}),$1,$2,$3,$4,$5)`, [d.url, d.pathname, d.original_name, d.mime, d.size]));
    }
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

// How an approved realization settles against the advance: actual > advance →
// top-up owed to the employee; actual < advance → balance the employee returns;
// equal → even. `cents` is always the positive amount that changes hands.
function settlementFor(row) {
  const diff = Number(row.realized_total_cents) - Number(row.amount_cents);
  return { direction: diff > 0 ? 'topup' : diff < 0 ? 'return' : 'even', cents: Math.abs(diff) };
}

// Revert one step of a cash advance's lifecycle (mirrors planRevert, doubled for
// the realization phase). Only the actor who owns a node may undo it. Returns a
// plan { kind, sql, action, from, to, comment? } or a refusal { error, code }.
function planAdvanceRevert(row, u) {
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  const isSuper = u.role === 'superadmin';
  const deny = (error) => ({ error, code: 403 });
  if (row.status === 'settled') {
    if (!canMarkPaid(u)) return deny('You do not have permission to revert a settlement');
    return { kind: 'unsettle', sql: `status='realize_approved', settlement_cents=0, settlement_direction='', settlement_note='', settled_by=NULL, settled_at=NULL`,
      action: 'reverted settlement', from: 'settled', to: 'realize_approved' };
  }
  if (row.status === 'realize_approved') {
    if (!isSuper && Number(row.manager_id) !== u.id) return deny('Only the approver who approved this realization can revert it');
    return { kind: 'unapprove-final', sql: `status='realize_submitted', manager_id=NULL, manager_comment='', decided_at=NULL`, action: 'reverted realization approval', from: 'realize_approved', to: 'realize_submitted' };
  }
  if (row.status === 'realize_submitted') {
    if (step > 1) {
      if (!isSuper && ids[step - 2] !== u.id) return deny('Only the approver of the previous step can revert it');
      return { kind: 'unapprove-step', sql: `current_step=${step - 1}`, action: 'reverted realization approval', from: 'realize_submitted', to: 'realize_submitted' };
    }
    if (!isSuper && Number(row.employee_id) !== u.id) return deny('Only the claimant can revert this realization');
    return { kind: 'cancel', sql: `status='rejected_realize', manager_id=NULL, decided_at=now()`, action: 'reverted — cancelled realization to edit', from: 'realize_submitted', to: 'rejected_realize', comment: 'Reverted by the claimant to make changes' };
  }
  if (row.status === 'paid') {
    if (!canMarkPaid(u)) return deny('You do not have permission to revert a payment');
    return { kind: 'unpay', sql: `status='approved', paid_by=NULL, paid_at=NULL`, action: 'reverted payment', from: 'paid', to: 'approved' };
  }
  if (row.status === 'approved') {
    if (!isSuper && Number(row.manager_id) !== u.id) return deny('Only the approver who approved this advance can revert the approval');
    return { kind: 'unapprove-final', sql: `status='submitted', manager_id=NULL, manager_comment='', decided_at=NULL`, action: 'reverted approval', from: 'approved', to: 'submitted' };
  }
  if (row.status === 'submitted') {
    if (step > 1) {
      if (!isSuper && ids[step - 2] !== u.id) return deny('Only the approver of the previous step can revert it');
      return { kind: 'unapprove-step', sql: `current_step=${step - 1}`, action: 'reverted approval', from: 'submitted', to: 'submitted' };
    }
    if (!isSuper && Number(row.employee_id) !== u.id) return deny('Only the claimant can revert this submission');
    return { kind: 'cancel', sql: `status='rejected', manager_id=NULL, decided_at=now()`, action: 'reverted — cancelled to edit', from: 'submitted', to: 'rejected', comment: 'Reverted by the claimant to make changes' };
  }
  return { error: `A ${row.status} cash advance cannot be reverted`, code: 409 };
}

module.exports = {
  normaliseAdvanceRequest, advanceNotify, serializeOneAdvance,
  createCashAdvance, loadAdvanceOr404, ADV_LINE_SEQ, settlementFor,
  planAdvanceRevert, serializeManyAdvance
};
