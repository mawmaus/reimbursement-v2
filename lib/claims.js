'use strict';

// Reimbursement claims: numbering, history, serialization (full and list
// shapes) and creation.

const { q, qq, transaction } = require('../db');
const { asIntArray, iso, groupBy, intArrayLiteral } = require('./util');
const {
  sourceView, lineDecision, reviewedByViewer, approverNames, slimForList,
  claimHeaderFromLines
} = require('./documents');
const { liveDateChanges } = require('./date-changes');
const { loadAppSettings, regionPrefsFor } = require('./settings');
const { dateFloorFor } = require('./claim-window');
const { parseAmountToCents } = require('./money');
const { carryLinesQueries } = require('./lines');

async function nextClaimNo() {
  const year = new Date().getFullYear();
  // Derive from the highest existing suffix, not COUNT(*): a deleted claim
  // would otherwise make the count point at an already-used number, colliding
  // on every retry (see the createClaim retry loop).
  const rows = await q(
    `SELECT COALESCE(MAX(SUBSTRING(claim_no FROM '[0-9]+$')::int), 0) AS n
       FROM claims WHERE claim_no LIKE $1`,
    [`RC-${year}-%`]);
  return `RC-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}
function baseClaim(row, attachments, lines, attByLine, history, nameMap) {
  const attView = (a) => ({
    id: a.id, original_name: a.original_name, mime_type: a.mime_type,
    size_bytes: a.size_bytes, uploaded_at: iso(a.uploaded_at)
  });
  return {
    id: row.id,
    claim_no: row.claim_no,
    employee_id: row.employee_id,
    claimant_name: row.claimant_name,
    expense_date: row.expense_date,
    department: row.department,
    region: row.region || '',
    bank_name: row.bank_name,
    recipient_name: row.recipient_name,
    bank_account_no: row.bank_account_no,
    db_no: row.db_no || '',
    expense_type: row.expense_type,
    amount: Number(row.amount_cents) / 100,
    currency: row.currency,
    description: row.description,
    status: row.status,
    manager_comment: row.manager_comment,
    manager_id: row.manager_id == null ? null : Number(row.manager_id),
    paid_by: row.paid_by == null ? null : Number(row.paid_by),
    approvers: asIntArray(row.approver_ids).map(id => ({ id, name: (nameMap && nameMap[id]) || `User #${id}` })),
    current_step: row.current_step || 0,
    decided_at: iso(row.decided_at),
    paid_at: iso(row.paid_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    // Flat list of every receipt on the claim (kept for anything reading the
    // whole set, e.g. counts); per-line receipts live under `lines`.
    attachments: (attachments || []).map(attView),
    lines: (lines || []).map(l => ({
      id: l.id, line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: Number(l.amount_cents) / 100, description: l.description,
      attachments: ((attByLine && attByLine[l.id]) || []).map(attView),
      ...lineDecision(l)
    })),
    // Everything the claimant put in, rejected lines included; `amount` is what is
    // actually payable.
    claimed_amount: (lines || []).reduce((s, l) => s + Number(l.amount_cents), 0) / 100,
    ...sourceView(row),
    history: (history || []).map(h => ({
      actor_id: h.actor_id == null ? null : Number(h.actor_id),
      actor_name: h.actor_name, action: h.action, from_status: h.from_status,
      to_status: h.to_status, comment: h.comment, created_at: iso(h.created_at)
    }))
  };
}

// Batch-load lines, attachments + history for many claims. `listFor` (the
// viewing user) selects the slim list shape described above.
async function serializeMany(rows, { listFor = null } = {}) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  // Every lookup below is independent, so they go out together rather than as
  // six back-to-back round-trips to the database.
  const [atts, lines, hist, nameMap, dc, settings] = await Promise.all([
    listFor ? [] : q(`SELECT id, claim_id, line_id, original_name, mime_type, size_bytes, uploaded_at
       FROM attachments WHERE claim_id IN (${ph}) ORDER BY id`, ids),
    q(`SELECT * FROM claim_lines WHERE claim_id IN (${ph}) ORDER BY sort_order, id`, ids),
    listFor
      ? reviewedByViewer('claim_history', 'claim_id', ids, ph, listFor.id)
      : q(`SELECT claim_id, actor_id, actor_name, action, from_status, to_status, comment, created_at
       FROM claim_history WHERE claim_id IN (${ph}) ORDER BY id`, ids),
    approverNames(rows),
    // A live date-change request rides along so the edit form knows whether the
    // line dates are locked, awaiting a decision, or unlocked.
    liveDateChanges('claim', ids),
    loadAppSettings()
  ]);
  const a = groupBy(atts, 'claim_id');
  const attByLine = groupBy(atts, 'line_id');
  const l = groupBy(lines, 'claim_id');
  const h = listFor ? {} : groupBy(hist, 'claim_id');
  const out = rows.map(r => ({ ...baseClaim(r, a[r.id], l[r.id], attByLine, h[r.id], nameMap), date_change: dc[r.id] || null,
    date_floor: r.status === 'rejected' ? dateFloorFor(settings, r.region, r.window_from || r.created_at) : null,
    // The floor a re-claim of this claim's rejected lines is held to (the window
    // it was first submitted into — see resolveLineSource).
    reclaim_floor: dateFloorFor(settings, r.region, r.window_from || r.created_at) }));
  return listFor ? out.map(c => slimForList(c, hist)) : out;
}
async function serializeOne(row) {
  return (await serializeMany([row]))[0];
}
async function loadClaimOr404(req, res) {
  const rows = await q('SELECT * FROM claims WHERE id = $1', [req.params.id]);
  if (!rows[0]) { res.status(404).json({ error: 'Claim not found' }); return null; }
  return rows[0];
}

// Sequences backing claims.id / claim_lines.id, so later inserts in the same
// transaction can reference the just-created rows via currval().
const CLAIM_SEQ = "pg_get_serial_sequence('claims','id')";
const LINE_SEQ = "pg_get_serial_sequence('claim_lines','id')";

// Validate the itemised lines of a reimbursement claim. Each filled row needs a
// date, an expense type and a positive amount; DB no + description are optional.
// Blank rows are skipped. Attachment references (new uploads + kept ids) ride
// along untouched for the caller to verify. Returns { lines, totalCents } or
// { error }.
function normaliseClaimLines(input) {
  if (!Array.isArray(input)) return { error: 'Add at least one expense line' };
  const lines = [];
  let totalCents = 0;
  for (const raw of input) {
    const r = raw || {};
    const date = String(r.line_date || r.expense_date || r.date || '').trim();
    const db_no = String(r.db_no || '').trim();
    const expense_type = String(r.expense_type || '').trim();
    const description = String(r.description || r.desc || '').trim();
    const cents = parseAmountToCents(r.amount);
    const rawAttachments = Array.isArray(r.attachments) ? r.attachments : [];
    const keepIds = asIntArray(r.keep_attachment_ids);
    const blank = !date && !db_no && !expense_type && !description
      && (cents === null || cents === 0) && !rawAttachments.length && !keepIds.length;
    if (blank) continue;
    if (!date) return { error: 'Every filled row needs a date' };
    if (!expense_type) return { error: 'Every filled row needs an expense type' };
    if (cents === null || cents <= 0) return { error: 'Every filled row needs a positive amount' };
    totalCents += cents;
    lines.push({ line_date: date, db_no, expense_type, amount_cents: cents, description, rawAttachments, keepIds });
  }
  if (!lines.length) return { error: 'Add at least one expense line with a date, type and amount' };
  return { lines, totalCents };
}

// Create an itemised claim — header, its lines, each line's receipts and the
// initial history row — as one atomic transaction. `verifiedByLine[i]` is the
// verified upload list for line i. Retries on a claim_no collision. `src` (from
// resolveLineSource) marks a re-claim of another document's rejected lines:
// `keptByLine[i]` are that source's receipts line i keeps, re-linked to the same blob.
async function createClaim(req, header, lines, verifiedByLine, totalCents, approverIds, region, src = null, keptByLine = []) {
  const h = claimHeaderFromLines(lines);
  // Default the currency to the region's configured default when the client
  // doesn't send one.
  const defaultCurrency = (await regionPrefsFor(region)).currency;
  for (let attempt = 0; attempt < 4; attempt++) {
    const claimNo = await nextClaimNo();
    const queries = [qq(
      `INSERT INTO claims
        (claim_no, employee_id, claimant_name, expense_date, department, db_no, bank_name,
         recipient_name, bank_account_no, expense_type, amount_cents, currency, description,
         status, approver_ids, current_step, region, source_doc_type, source_doc_id, source_doc_no, window_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted',$14::int[],$15,$16,$17,$18,$19,$20)`,
      [claimNo, req.user.id, String(req.user.full_name || '').trim(), h.expense_date,
       String(req.user.department || '').trim(), h.db_no,
       String(req.user.bank_name || '').trim(),
       String(req.user.recipient_name || '').trim(), String(req.user.bank_account_no || '').trim(),
       h.expense_type, totalCents,
       String(header.currency || defaultCurrency).trim().slice(0, 8), h.description,
       intArrayLiteral(approverIds), approverIds.length ? 1 : 0, String(region || ''),
       src ? src.kind : '', src ? src.row.id : null, src ? src.docNo : '', src ? src.windowFrom : null])];
    lines.forEach((l, i) => {
      queries.push(qq(
        `INSERT INTO claim_lines (claim_id, sort_order, line_date, db_no, expense_type, amount_cents, description)
         VALUES (currval(${CLAIM_SEQ}),$1,$2,$3,$4,$5,$6)`,
        [i, l.line_date, l.db_no, l.expense_type, l.amount_cents, l.description]));
      for (const a of (keptByLine[i] || [])) {
        queries.push(qq(
          `INSERT INTO attachments (claim_id, line_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
           VALUES (currval(${CLAIM_SEQ}), currval(${LINE_SEQ}),$1,$2,$3,$4,$5)`,
          [a.blob_url, a.blob_pathname, a.original_name, a.mime_type, a.size_bytes]));
      }
      for (const u of (verifiedByLine[i] || [])) {
        queries.push(qq(
          `INSERT INTO attachments (claim_id, line_id, blob_url, blob_pathname, original_name, mime_type, size_bytes)
           VALUES (currval(${CLAIM_SEQ}), currval(${LINE_SEQ}),$1,$2,$3,$4,$5)`,
          [u.url, u.pathname, u.original_name, u.mime, u.size]));
      }
    });
    queries.push(qq(
      `INSERT INTO claim_history (claim_id, actor_id, actor_name, action, from_status, to_status, comment)
       VALUES (currval(${CLAIM_SEQ}),$1,$2,'submitted',NULL,'submitted',$3)`,
      [req.user.id, String(req.user.full_name || '').trim(), src ? `Re-claims rejected lines from ${src.docNo}` : '']));
    if (src) queries.push(...carryLinesQueries(src, req.user, `currval(${CLAIM_SEQ})`, claimNo));
    queries.push(qq(`SELECT currval(${CLAIM_SEQ})::int AS id`));
    try {
      const results = await transaction(queries);
      return results[results.length - 1][0].id;
    } catch (e) {
      const msg = String(e.message || '');
      if (e.code === '23505' || msg.includes('claim_no') || msg.includes('duplicate')) continue;
      throw e;
    }
  }
  throw new Error('Could not allocate a claim number — please try again');
}

module.exports = {
  serializeMany, loadClaimOr404, serializeOne, normaliseClaimLines,
  createClaim, LINE_SEQ
};
