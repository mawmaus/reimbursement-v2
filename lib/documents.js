'use strict';

// Plumbing shared by claims, meal claims and cash advances: history logging,
// per-line decision fields, approver names and the slim list shape.

const { q } = require('../db');
const { asIntArray, iso } = require('./util');

async function logHistory(claimId, actor, action, fromStatus, toStatus, comment = '') {
  await q(
    `INSERT INTO claim_history (claim_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [claimId, actor.id, actor.full_name, action, fromStatus, toStatus, comment]
  );
}
// { id: full_name } for every distinct approver referenced across the rows.
async function approverNames(rows) {
  const ids = [...new Set(rows.flatMap(r => asIntArray(r.approver_ids)))];
  const nameMap = {};
  if (!ids.length) return nameMap;
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  for (const u of await q(`SELECT id, full_name FROM users WHERE id IN (${ph})`, ids)) nameMap[u.id] = u.full_name;
  return nameMap;
}
// List views get a slim shape: no history and no receipt metadata (the drawer,
// edit forms and PDF all re-fetch the full record by id). Of the history, a list
// only needs whether the viewer decided on the claim (the "Reviewed by me"
// filter), so that comes back as `reviewed_by_me` instead. Without this the
// ledger outgrows Vercel's 4.5 MB function-response cap within months.
const REVIEW_ACTION_RE = /\b(approved|rejected)\b/;
async function reviewedByViewer(table, fk, ids, ph, viewerId) {
  const rows = await q(
    `SELECT ${fk} AS doc_id, action FROM ${table} WHERE ${fk} IN (${ph}) AND actor_id = $${ids.length + 1}`,
    [...ids, viewerId]);
  return new Set(rows.filter(r => REVIEW_ACTION_RE.test(String(r.action))).map(r => r.doc_id));
}
function slimForList(doc, reviewed) {
  const { history, attachments, ...rest } = doc;
  return { ...rest, lines: (rest.lines || []).map(({ attachments: _a, ...l }) => l), reviewed_by_me: reviewed.has(doc.id) };
}
// Line fields every serializer exposes for per-line approval.
function lineDecision(l) {
  return {
    rejected: l.rejected_at ? {
      at: iso(l.rejected_at), by: l.rejected_by_name || '', reason: l.rejected_reason || '',
      step: l.rejected_step == null ? null : Number(l.rejected_step)
    } : null,
    resubmitted_doc_id: l.resubmitted_doc_id == null ? null : Number(l.resubmitted_doc_id),
    resubmitted_doc_no: l.resubmitted_doc_no || ''
  };
}
// Header fields for a document raised from another's rejected lines.
function sourceView(row) {
  return {
    source_doc_type: row.source_doc_type || '',
    source_doc_id: row.source_doc_id == null ? null : Number(row.source_doc_id),
    source_doc_no: row.source_doc_no || ''
  };
}
// Aggregate header fields kept on the claims row so the list, CSV and search
// keep working off the header: earliest date, the type ("Multiple" for >1 line),
// the first DB no, and — only for a single-line claim — its description.
function claimHeaderFromLines(lines) {
  const dates = lines.map(l => l.line_date).filter(Boolean).sort();
  return {
    expense_date: dates[0] || '',
    expense_type: lines.length === 1 ? lines[0].expense_type : 'Multiple',
    db_no: lines[0].db_no || '',
    description: lines.length === 1 ? lines[0].description : ''
  };
}
async function logMealHistory(claimId, actor, action, fromStatus, toStatus, comment = '') {
  await q(
    `INSERT INTO meal_claim_history (meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [claimId, actor.id, actor.full_name, action, fromStatus, toStatus, comment]);
}
async function logAdvanceHistory(advanceId, actor, action, fromStatus, toStatus, comment = '') {
  await q(
    `INSERT INTO cash_advance_history (advance_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [advanceId, actor.id, actor.full_name, action, fromStatus, toStatus, comment]);
}

module.exports = {
  sourceView, lineDecision, reviewedByViewer, approverNames, slimForList,
  claimHeaderFromLines, logHistory, logMealHistory, logAdvanceHistory
};
