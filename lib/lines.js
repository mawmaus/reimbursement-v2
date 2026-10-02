'use strict';

// Per-line approval across claims, meal claims and cash advances: line
// rejections, re-claiming rejected lines on a new document, and receipt
// clean-up.

const { q, qq, transaction } = require('../db');
const { deleteReceipt } = require('./blob');
const { notifyClaimantLinesRejected } = require('./notify');
const {
  logHistory, logMealHistory, logAdvanceHistory, claimHeaderFromLines
} = require('./documents');
const { fmtMoney } = require('./money');
const { asIntArray, intArrayLiteral, isISODate } = require('./util');
const { firstRealizedAt } = require('./claim-window');

// ---------------------------------------------------------------------------
// Per-line approval
// An approver may reject individual lines while approving the rest. Rejected
// lines stay on the document as history but leave its payable total; the
// claimant re-claims them on a NEW document (see resolveLineSource). One table
// describes how to reach each document type's lines.
// ---------------------------------------------------------------------------
const LINE_DOCS = {
  claim: {
    table: 'claims', lines: 'claim_lines', fk: 'claim_id', total: 'amount_cents', noCol: 'claim_no',
    histTable: 'claim_history', typeLabel: 'reimbursement claim',
    history: (...a) => logHistory(...a),
    describe: (l) => [l.line_date, l.expense_type]
  },
  meal: {
    table: 'meal_claims', lines: 'meal_claim_lines', fk: 'meal_claim_id', total: 'total_cents', noCol: 'claim_no',
    histTable: 'meal_claim_history', typeLabel: 'meal allowance claim',
    history: (...a) => logMealHistory(...a),
    describe: (l) => [l.line_date, l.job_category || 'Meal allowance']
  },
  advance: {
    table: 'cash_advances', lines: 'cash_advance_lines', fk: 'advance_id', total: 'realized_total_cents', noCol: 'advance_no',
    histTable: 'cash_advance_history', typeLabel: 'cash advance realization',
    history: (...a) => logAdvanceHistory(...a),
    describe: (l) => [l.line_date, l.expense_type]
  }
};
// "Line 2 · 2026-09-01 · Taxi · IDR 150,000" — how a line reads in history + email.
function lineLabel(kind, l, n, currency) {
  return [`Line ${n}`, ...LINE_DOCS[kind].describe(l).filter(Boolean), fmtMoney(l.amount_cents, currency)].join(' · ');
}
// The SQL that re-derives a header's payable total from its still-active lines.
function payableTotalSql(kind) {
  const d = LINE_DOCS[kind];
  return `UPDATE ${d.table} SET ${d.total} = (SELECT COALESCE(SUM(amount_cents),0) FROM ${d.lines}
            WHERE ${d.fk} = $1 AND rejected_at IS NULL), updated_at = now() WHERE id = $1`;
}
// A reimbursement claim's header mirrors its lines (type "Multiple", first DB
// no…); keep that summary in step with the lines still being paid.
async function refreshClaimHeader(claimId) {
  const active = await q(
    `SELECT line_date, db_no, expense_type, description FROM claim_lines
      WHERE claim_id = $1 AND rejected_at IS NULL ORDER BY sort_order, id`, [claimId]);
  if (!active.length) return;
  const h = claimHeaderFromLines(active);
  await q(`UPDATE claims SET expense_date=$1, expense_type=$2, db_no=$3, description=$4 WHERE id=$5`,
    [h.expense_date, h.expense_type, h.db_no, h.description, claimId]);
}

// Validate the `rejected_lines` riding on an approve: [{ id, reason }]. Every
// id must be a still-active line of this document and carry a reason, and at
// least one line must survive — rejecting them all is "Reject & return".
// Returns { picks: [{ line, n, reason }], remainingCents } or { error }.
async function planLineRejections(kind, row, raw) {
  const d = LINE_DOCS[kind];
  const list = Array.isArray(raw) ? raw : [];
  const lines = await q(`SELECT * FROM ${d.lines} WHERE ${d.fk} = $1 ORDER BY sort_order, id`, [row.id]);
  const active = lines.filter(l => !l.rejected_at);
  const activeCents = active.reduce((s, l) => s + Number(l.amount_cents), 0);
  if (!list.length) return { picks: [], remainingCents: activeCents };
  const byId = new Map(active.map(l => [Number(l.id), l]));
  const seen = new Set();
  const picks = [];
  for (const r of list) {
    const id = Number(r && r.id);
    const reason = String((r && r.reason) || '').trim();
    if (!byId.has(id)) return { error: 'One of the rejected lines is no longer on this claim — reload and try again' };
    if (!reason) return { error: 'Give a reason for every rejected line' };
    if (seen.has(id)) continue;
    seen.add(id);
    const line = byId.get(id);
    picks.push({ line, reason: reason.slice(0, 1000), n: lines.indexOf(line) + 1 });
  }
  if (picks.length >= active.length) {
    return { error: 'Every line would be rejected — use "Reject & return" to send the whole claim back instead' };
  }
  const rejectedCents = picks.reduce((s, p) => s + Number(p.line.amount_cents), 0);
  return { picks, remainingCents: activeCents - rejectedCents };
}
// Apply a validated plan: mark the lines rejected at this chain step, re-derive
// the payable total, log one history row per line and email the claimant.
async function applyLineRejections(kind, row, user, picks) {
  if (!picks.length) return;
  const d = LINE_DOCS[kind];
  const step = row.current_step || 0;
  const queries = picks.map(p => qq(
    `UPDATE ${d.lines} SET rejected_at = now(), rejected_by_name = $1, rejected_reason = $2, rejected_step = $3
      WHERE id = $4 AND ${d.fk} = $5 AND rejected_at IS NULL`,
    [String(user.full_name || '').trim(), p.reason, step, p.line.id, row.id]));
  queries.push(qq(payableTotalSql(kind), [row.id]));
  await transaction(queries);
  if (kind === 'claim') await refreshClaimHeader(row.id);
  for (const p of picks) {
    await d.history(row.id, user, 'line rejected', row.status, row.status,
      `${lineLabel(kind, p.line, p.n, row.currency)} — ${p.reason}`);
  }
  const fresh = (await q(`SELECT * FROM ${d.table} WHERE id = $1`, [row.id]))[0];
  await notifyClaimantLinesRejected(fresh.employee_id, {
    claimNo: fresh[d.noCol], typeLabel: d.typeLabel,
    amount: Number(fresh[d.total]) / 100, currency: fresh.currency
  }, picks.map(p => ({ label: lineLabel(kind, p.line, p.n, row.currency), reason: p.reason })));
}
// Undoing a step's approval also undoes the line rejections that step made —
// except lines the claimant already re-claimed elsewhere, which stay rejected.
async function restoreStepRejections(kind, row, user, step) {
  if (!step) return;
  const d = LINE_DOCS[kind];
  const restored = await q(
    `UPDATE ${d.lines} SET rejected_at = NULL, rejected_by_name = '', rejected_reason = '', rejected_step = NULL
      WHERE ${d.fk} = $1 AND rejected_step = $2 AND rejected_at IS NOT NULL AND resubmitted_doc_id IS NULL
      RETURNING *`, [row.id, step]);
  if (!restored.length) return;
  await q(payableTotalSql(kind), [row.id]);
  if (kind === 'claim') await refreshClaimHeader(row.id);
  const order = await q(`SELECT id FROM ${d.lines} WHERE ${d.fk} = $1 ORDER BY sort_order, id`, [row.id]);
  const pos = new Map(order.map((r, i) => [Number(r.id), i + 1]));
  for (const l of restored) {
    await d.history(row.id, user, 'line restored', row.status, row.status,
      lineLabel(kind, l, pos.get(Number(l.id)) || 0, row.currency));
  }
}
// A whole-document resubmit starts a fresh approval cycle; line rejections from
// the old cycle become permanent so a later revert can't resurrect them.
function freezeRejectionsQuery(kind, id) {
  const d = LINE_DOCS[kind];
  return qq(`UPDATE ${d.lines} SET rejected_step = NULL WHERE ${d.fk} = $1 AND rejected_at IS NOT NULL`, [id]);
}
// Removing a document frees any rejected lines that had been re-claimed on it,
// so they can be re-claimed again.
function releaseCarriedQueries(kinds, docNo) {
  return kinds.map(k => qq(
    `UPDATE ${LINE_DOCS[k].lines} SET resubmitted_doc_id = NULL, resubmitted_doc_no = '' WHERE resubmitted_doc_no = $1`,
    [docNo]));
}

// Which source documents a new document may re-claim rejected lines from:
// a reimbursement claim takes them from another claim or from a cash-advance
// realization (same line shape); a meal claim only from another meal claim.
const SOURCE_KINDS = { claim: ['claim', 'advance'], meal: ['meal'] };
// Resolve `source: { type, id, line_ids }` on a new submission. The source must
// be the caller's own, and every picked line must be rejected and not yet
// re-claimed. Returns null when there is no source, else { kind, row, docNo,
// lines, windowFrom, carried, atts } or { error }.
async function resolveLineSource(req, target, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.type || '');
  if (!(SOURCE_KINDS[target] || []).includes(kind)) return { error: 'Those lines cannot be re-claimed on this kind of claim' };
  const d = LINE_DOCS[kind];
  const row = (await q(`SELECT * FROM ${d.table} WHERE id = $1`, [Number(raw.id) || 0]))[0];
  if (!row) return { error: 'The original claim no longer exists' };
  if (Number(row.employee_id) !== req.user.id) return { error: 'You can only re-claim lines from your own claims' };
  const ids = [...new Set(asIntArray(raw.line_ids))];
  if (!ids.length) return { error: 'Pick at least one rejected line to re-claim' };
  const lines = await q(`SELECT * FROM ${d.lines} WHERE ${d.fk} = $1 AND id = ANY($2::int[])`, [row.id, intArrayLiteral(ids)]);
  if (lines.length !== ids.length || lines.some(l => !l.rejected_at)) {
    return { error: 'Only rejected lines can be re-claimed — reload and try again' };
  }
  const taken = lines.find(l => l.resubmitted_doc_id);
  if (taken) return { error: `That line was already re-claimed on ${taken.resubmitted_doc_no}` };
  // Judged by the window the source was first submitted into (for an advance:
  // when its realization first went in), like a resubmit of the source itself.
  const windowFrom = kind === 'advance' ? await firstRealizedAt(row.id) : (row.window_from || row.created_at);
  let atts = [];
  if (kind !== 'meal') {
    const col = kind === 'advance' ? 'advance_line_id' : 'line_id';
    atts = await q(`SELECT id, ${col} AS line_id, blob_url, blob_pathname, original_name, mime_type, size_bytes
                      FROM attachments WHERE ${col} = ANY($1::int[])`, [intArrayLiteral(ids)]);
  }
  return {
    kind, row, docNo: row[d.noCol], lines, windowFrom, atts,
    carried: new Set(lines.map(l => String(l.line_date || '')).filter(isISODate))
  };
}
// The queries that stamp the source lines as re-claimed on the new document
// (whose id is `newIdExpr`, a trusted currval() fragment) and log it on the source.
function carryLinesQueries(src, user, newIdExpr, newNo) {
  const d = LINE_DOCS[src.kind];
  const n = src.lines.length;
  return [
    qq(`UPDATE ${d.lines} SET resubmitted_doc_id = ${newIdExpr}, resubmitted_doc_no = $1
         WHERE id = ANY($2::int[]) AND resubmitted_doc_id IS NULL`,
      [newNo, intArrayLiteral(src.lines.map(l => Number(l.id)))]),
    qq(`INSERT INTO ${d.histTable} (${d.fk}, actor_id, actor_name, action, from_status, to_status, comment)
        VALUES ($1,$2,$3,'lines re-claimed',$4,$4,$5)`,
      [src.row.id, user.id, String(user.full_name || '').trim(), src.row.status,
       `${n === 1 ? '1 rejected line' : `${n} rejected lines`} re-claimed on ${newNo}`])
  ];
}
// Kept receipts on a re-claim point at the SAME blob as the source line's
// receipt, so one blob may back more than one attachment row. Delete it only
// once nothing references it any more.
async function deleteReceiptIfUnused(url) {
  const still = await q('SELECT 1 FROM attachments WHERE blob_url = $1 LIMIT 1', [url]);
  if (still.length) return;
  try { await deleteReceipt(url); } catch { /* ignore */ }
}

module.exports = {
  carryLinesQueries, resolveLineSource, freezeRejectionsQuery,
  deleteReceiptIfUnused, planLineRejections, applyLineRejections,
  restoreStepRejections, releaseCarriedQueries
};
