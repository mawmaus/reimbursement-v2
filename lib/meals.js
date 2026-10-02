'use strict';

// Meal-allowance claims: numbering, history, line validation, serialization
// and creation.

const { q, qq, transaction } = require('../db');
const { parseAmountToCents } = require('./money');
const { asIntArray, iso, groupBy, intArrayLiteral } = require('./util');
const { httpError } = require('./errors');
const {
  sourceView, lineDecision, reviewedByViewer, approverNames, slimForList
} = require('./documents');
const { liveDateChanges } = require('./date-changes');
const { loadAppSettings, regionPrefsFor } = require('./settings');
const { dateFloorFor } = require('./claim-window');
const { carryLinesQueries } = require('./lines');

// ---------------------------------------------------------------------------
// Meal allowance claims
// A header + line items, following the same submit → approve chain → reject /
// resubmit → paid workflow as reimbursement claims (see userCanApprove).
// ---------------------------------------------------------------------------
async function nextMealClaimNo() {
  const year = new Date().getFullYear();
  // Highest existing suffix + 1, not COUNT(*) — same deletion-collision reason
  // as nextClaimNo.
  const rows = await q(
    `SELECT COALESCE(MAX(SUBSTRING(claim_no FROM '[0-9]+$')::int), 0) AS n
       FROM meal_claims WHERE claim_no LIKE $1`,
    [`MA-${year}-%`]);
  return `MA-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}
// Validate + normalise the submitted line items. Fully-blank rows are dropped;
// a kept row needs a date and a positive amount. Returns { lines, totalCents }.
function normaliseMealLines(input) {
  if (!Array.isArray(input)) return { error: 'Lines must be a list' };
  const lines = [];
  let totalCents = 0;
  for (const raw of input) {
    const r = raw || {};
    const date = String(r.date || r.line_date || '').trim();
    const site = String(r.site || '').trim();
    const category = String(r.category || r.job_category || '').trim();
    const description = String(r.desc || r.description || '').trim();
    const cents = parseAmountToCents(r.amount);
    const blank = !date && !site && !category && !description && (cents === null || cents === 0);
    if (blank) continue;
    if (!date) return { error: 'Every filled row needs a date' };
    if (cents === null || cents <= 0) return { error: 'Every filled row needs a positive amount' };
    totalCents += cents;
    lines.push({ line_date: date, site, job_category: category, amount_cents: cents, description });
  }
  if (!lines.length) return { error: 'Add at least one line with a date and amount' };
  return { lines, totalCents };
}
function baseMealClaim(row, lines, history, nameMap) {
  return {
    id: row.id, type: 'meal', claim_no: row.claim_no,
    employee_id: row.employee_id, claimant_name: row.claimant_name,
    department: row.department, region: row.region || '', bank_name: row.bank_name,
    recipient_name: row.recipient_name, bank_account_no: row.bank_account_no,
    total_amount: Number(row.total_cents) / 100, currency: row.currency,
    status: row.status, manager_comment: row.manager_comment,
    manager_id: row.manager_id == null ? null : Number(row.manager_id),
    paid_by: row.paid_by == null ? null : Number(row.paid_by),
    approvers: asIntArray(row.approver_ids).map(id => ({ id, name: (nameMap && nameMap[id]) || `User #${id}` })),
    current_step: row.current_step || 0,
    decided_at: iso(row.decided_at), paid_at: iso(row.paid_at),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    lines: (lines || []).map(l => ({
      id: l.id, line_date: l.line_date, site: l.site, job_category: l.job_category,
      amount: Number(l.amount_cents) / 100, description: l.description,
      ...lineDecision(l)
    })),
    claimed_amount: (lines || []).reduce((s, l) => s + Number(l.amount_cents), 0) / 100,
    ...sourceView(row),
    history: (history || []).map(h => ({
      actor_id: h.actor_id == null ? null : Number(h.actor_id),
      actor_name: h.actor_name, action: h.action, from_status: h.from_status,
      to_status: h.to_status, comment: h.comment, created_at: iso(h.created_at)
    }))
  };
}
// `listFor`: the slim list shape, as for serializeMany.
async function serializeManyMeal(rows, { listFor = null } = {}) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const [lines, hist, nameMap, dc, settings] = await Promise.all([
    q(`SELECT * FROM meal_claim_lines WHERE meal_claim_id IN (${ph}) ORDER BY sort_order, id`, ids),
    listFor
      ? reviewedByViewer('meal_claim_history', 'meal_claim_id', ids, ph, listFor.id)
      : q(`SELECT meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment, created_at
       FROM meal_claim_history WHERE meal_claim_id IN (${ph}) ORDER BY id`, ids),
    approverNames(rows),
    liveDateChanges('meal', ids),
    loadAppSettings()
  ]);
  const l = groupBy(lines, 'meal_claim_id');
  const h = listFor ? {} : groupBy(hist, 'meal_claim_id');
  const out = rows.map(r => ({ ...baseMealClaim(r, l[r.id], h[r.id], nameMap), date_change: dc[r.id] || null,
    date_floor: r.status === 'rejected' ? dateFloorFor(settings, r.region, r.window_from || r.created_at) : null,
    reclaim_floor: dateFloorFor(settings, r.region, r.window_from || r.created_at) }));
  return listFor ? out.map(c => slimForList(c, hist)) : out;
}
async function serializeOneMeal(row) { return (await serializeManyMeal([row]))[0]; }
async function loadMealClaimOr404(req, res) {
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Meal claim not found' }); return null; }
  return rows[0];
}

// Sequence backing meal_claims.id (see CLAIM_SEQ).
const MEAL_SEQ = "pg_get_serial_sequence('meal_claims','id')";

// One lazy meal-line INSERT. `claimIdExpr` is a trusted SQL fragment: a numeric
// claim id (resubmit) or currval(...) (new claim) — never user input.
function mealLineQuery(claimIdExpr, l, i) {
  return qq(
    `INSERT INTO meal_claim_lines (meal_claim_id, sort_order, line_date, site, job_category, amount_cents, description)
     VALUES (${claimIdExpr},$1,$2,$3,$4,$5,$6)`,
    [i, l.line_date, l.site, l.job_category, l.amount_cents, l.description]);
}

// Create a meal claim, its line items and initial history row as one atomic
// transaction. Retries on a claim_no collision. `src` marks a re-claim of
// another meal claim's rejected lines (see resolveLineSource).
async function createMealClaim(req, lines, totalCents, approverIds, region, src = null) {
  const currency = (await regionPrefsFor(region)).currency;
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextMealClaimNo();
    const queries = [qq(
      `INSERT INTO meal_claims
        (claim_no, employee_id, claimant_name, department, bank_name, recipient_name,
         bank_account_no, total_cents, currency, status, approver_ids, current_step, region,
         source_doc_type, source_doc_id, source_doc_no, window_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10::int[],$11,$12,$13,$14,$15,$16)`,
      [claimNo, req.user.id, String(req.user.full_name || '').trim(), String(req.user.department || '').trim(),
       String(req.user.bank_name || '').trim(), String(req.user.recipient_name || '').trim(),
       String(req.user.bank_account_no || '').trim(), totalCents, currency,
       intArrayLiteral(approverIds), approverIds.length ? 1 : 0, String(region || ''),
       src ? src.kind : '', src ? src.row.id : null, src ? src.docNo : '', src ? src.windowFrom : null])];
    lines.forEach((l, i) => queries.push(mealLineQuery(`currval(${MEAL_SEQ})`, l, i)));
    queries.push(qq(
      `INSERT INTO meal_claim_history (meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES (currval(${MEAL_SEQ}),$1,$2,'submitted',NULL,'submitted',$3)`,
      [req.user.id, String(req.user.full_name || '').trim(), src ? `Re-claims rejected lines from ${src.docNo}` : '']));
    if (src) queries.push(...carryLinesQueries(src, req.user, `currval(${MEAL_SEQ})`, claimNo));
    queries.push(qq(`SELECT currval(${MEAL_SEQ})::int AS id`));
    try {
      const results = await transaction(queries);
      return results[results.length - 1][0].id;
    } catch (e) {
      const msg = String(e.message || '');
      if (e.code === '23505' || msg.includes('claim_no') || msg.includes('duplicate')) continue;
      throw e;
    }
  }
  throw httpError(409, 'Could not allocate a claim number — please try again');
}

module.exports = {
  serializeManyMeal, loadMealClaimOr404, serializeOneMeal, normaliseMealLines,
  createMealClaim, mealLineQuery
};
