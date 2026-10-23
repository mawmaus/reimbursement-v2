'use strict';

// GPS meal allowance: submit and resubmit (called from routes/meals.js, which
// owns the meal-claim paths), the approved-amount adjustment, receipt reads and
// the per-region on/off switch. The rules live in lib/meal-gps.js.

const express = require('express');
const { q, qq, transaction } = require('../db');
const { requireAuth, requireCap, refuseOutOfRegion } = require('../lib/auth');
const { ah, asIntArray, intArrayLiteral } = require('../lib/util');
const { userCan } = require('../lib/permissions');
const {
  loadAppSettings, setAppSetting, resolveLookupRegion, regionPrefsFor, seesAllRegions
} = require('../lib/settings');
const { deleteReceipt, sendReceipt } = require('../lib/blob');
const { verifyAttachments } = require('../lib/uploads');
const { fmtMoney, parseAmountToCents } = require('../lib/money');
const { notifyPendingApprover } = require('../lib/notify');
const {
  heldByUnrealizedAdvance, resolveSubmitApprovers, currentApproverId, mealNotify,
  userCanApprove, canMarkPaid, computePurposes, stillAsRead, isStaleAbort, STALE_DOCUMENT
} = require('../lib/workflow');
const { serializeOneMeal, loadMealClaimOr404, createMealClaim, gpsLineQueries } = require('../lib/meals');
const { freezeRejectionsQuery, deleteReceiptIfUnused, payableTotalSql } = require('../lib/lines');
const { claimDateViolation, carriedLineDates } = require('../lib/claim-window');
const { liveDateChange, dateChangeGranted, consumeDateChange } = require('../lib/date-changes');
const { logMealHistory } = require('../lib/documents');
const {
  RULES, mealGpsMap, mealGpsEnabled, mayRaiseGps, baseView, normaliseGpsLines, datesTakenElsewhere, loadBase
} = require('../lib/meal-gps');

const router = express.Router();

// Verify every line's new receipt uploads. On a problem the uploads verified so
// far are deleted (nothing references them yet). Returns { byLine, all } or { error }.
async function verifyLineUploads(lines) {
  const byLine = [];
  const all = [];
  for (const line of lines) {
    const checked = await verifyAttachments(line.rawAttachments);
    if (checked.error) { await dropUploads(all); return { error: checked.error }; }
    byLine.push(checked.items);
    all.push(...checked.items);
  }
  return { byLine, all };
}
async function dropUploads(items) {
  for (const u of items) { try { await deleteReceipt(u.url); } catch { /* ignore */ } }
}
// "2026-11-03 is already claimed on MA-2026-0012" for the first clash, or null.
async function takenError(employeeId, lines, exceptClaimId) {
  const taken = await datesTakenElsewhere(employeeId, lines.map(l => l.line_date), exceptClaimId);
  if (!taken.length) return null;
  const t = taken[0];
  return `${t.line_date} is already claimed on ${t.claim_no} — a day's meals can only be claimed once`;
}

// POST /api/meal-claims with scheme 'gps'.
async function submitGpsMeal(req, res) {
  const b = req.body || {};
  const settings = await loadAppSettings();
  if (!mayRaiseGps(req.user, await computePurposes(req.user), settings)) {
    return res.status(403).json({ error: 'The GPS meal allowance is not switched on for your region' });
  }
  if (await heldByUnrealizedAdvance(req, res)) return;
  const base = await loadBase(req.user.id);
  const region = String(req.user.region || '');
  const currency = (await regionPrefsFor(region)).currency;
  const parsed = normaliseGpsLines(b.lines, base, currency);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region);
  if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  const clash = await takenError(req.user.id, parsed.lines, 0);
  if (clash) return res.status(409).json({ error: clash });
  const built = await resolveSubmitApprovers(req.user.approver1_options, req.user.approver_ids, b.approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  const up = await verifyLineUploads(parsed.lines);
  if (up.error) return res.status(400).json({ error: up.error });
  let claimId;
  try {
    claimId = await createMealClaim(req, parsed.lines, parsed.totalCents, built.ids, region, null, { uploadsByLine: up.byLine });
  } catch (e) { await dropUploads(up.all); throw e; }
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [claimId]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, mealNotify(rows[0]));
  res.status(201).json({ claim: await serializeOneMeal(rows[0]) });
}

// PUT /api/meal-claims/:id on a rejected GPS claim (ownership and status are
// checked by the caller). Lines are rebuilt; receipts the claimant kept are
// re-linked to the same blobs, dropped ones deleted once nothing uses them.
async function resubmitGpsMeal(req, res, row) {
  const b = req.body || {};
  const emp = (await q(
    `SELECT full_name, department, bank_name, recipient_name, bank_account_no, approver_ids, approver1_options,
            base_name, base_lat, base_lng FROM users WHERE id = $1`, [row.employee_id]))[0] || {};
  const parsed = normaliseGpsLines(b.lines, baseView(emp), row.currency);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const grant = await liveDateChange('meal', row.id);
  if (!dateChangeGranted(grant)) {
    const carried = await carriedLineDates('SELECT line_date FROM meal_claim_lines WHERE meal_claim_id = $1', row.id);
    const dv = await claimDateViolation(parsed.lines.map(l => l.line_date), req.user.region, carried, row.window_from || row.created_at);
    if (dv) return res.status(400).json({ error: dv.error, code: 'claim_date', earliest: dv.earliest });
  }
  const clash = await takenError(row.employee_id, parsed.lines, row.id);
  if (clash) return res.status(409).json({ error: clash });
  const built = await resolveSubmitApprovers(emp.approver1_options, emp.approver_ids, b.approver1);
  if (built.error) return res.status(400).json({ error: built.error });
  const existing = await q(
    `SELECT a.id, a.blob_url, a.blob_pathname, a.original_name, a.mime_type, a.size_bytes
       FROM attachments a JOIN meal_claim_lines l ON l.id = a.meal_line_id
      WHERE l.meal_claim_id = $1 AND l.rejected_at IS NULL`, [row.id]);
  const byId = new Map(existing.map(a => [Number(a.id), a]));
  const keptByLine = parsed.lines.map(l => l.keepIds.filter(id => byId.has(id)).map(id => byId.get(id)));
  const bare = parsed.lines.findIndex((l, i) => !keptByLine[i].length && !l.rawAttachments.length);
  if (bare >= 0) return res.status(400).json({ error: `Line ${bare + 1} (${parsed.lines[bare].line_date}): attach the meal receipt` });
  const up = await verifyLineUploads(parsed.lines);
  if (up.error) return res.status(400).json({ error: up.error });
  const keptIds = new Set(keptByLine.flat().map(a => Number(a.id)));
  const dropped = existing.filter(a => !keptIds.has(Number(a.id)));
  const claimId = Number(row.id);
  const queries = [stillAsRead('meal_claims', row), qq(
    `UPDATE meal_claims SET total_cents=$1, department=$2, bank_name=$3, recipient_name=$4,
       bank_account_no=$5, status='submitted', manager_comment='', manager_id=NULL, decided_at=NULL,
       approver_ids=$6::int[], current_step=$7, updated_at=now() WHERE id=$8`,
    [parsed.totalCents, String(emp.department || '').trim(), String(emp.bank_name || '').trim(),
     String(emp.recipient_name || '').trim(), String(emp.bank_account_no || '').trim(),
     intArrayLiteral(built.ids), built.ids.length ? 1 : 0, claimId]),
    // Live lines are rebuilt (their receipt rows go with them); rejected ones stay as history.
    qq('DELETE FROM meal_claim_lines WHERE meal_claim_id = $1 AND rejected_at IS NULL', [claimId]),
    freezeRejectionsQuery('meal', claimId)];
  parsed.lines.forEach((l, i) => queries.push(...gpsLineQueries(claimId, l, i, keptByLine[i], up.byLine[i])));
  queries.push(qq(
    `INSERT INTO meal_claim_history (meal_claim_id, actor_id, actor_name, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,'resubmitted','rejected','submitted',$4)`,
    [claimId, req.user.id, String(req.user.full_name || '').trim(), String(b.resubmit_note || '').trim()]));
  try {
    await transaction(queries);
  } catch (e) {
    await dropUploads(up.all);
    if (isStaleAbort(e)) return res.status(409).json({ error: STALE_DOCUMENT });
    throw e;
  }
  for (const a of dropped) await deleteReceiptIfUnused(a.blob_url);
  if (dateChangeGranted(grant)) await consumeDateChange('meal', row.id);
  const rows = await q('SELECT * FROM meal_claims WHERE id = $1', [row.id]);
  const first = currentApproverId(rows[0]);
  if (first) await notifyPendingApprover(first, mealNotify(rows[0]));
  res.json({ claim: await serializeOneMeal(rows[0]) });
}

// --- Approved amount ---------------------------------------------------------------
// The Manager or Finance AP may lower what a GPS line pays (say the receipt shows
// IDR 20,000 against IDR 35,000 claimed): whoever holds the claim in the chain
// while it is submitted, and whoever records payments once it is approved. Never
// above the claimed amount; setting it back to the claimed amount clears it.
function canAdjustApproved(user, row) {
  if (row.scheme !== 'gps') return false;
  if (row.status === 'submitted') return userCanApprove(user, row);
  if (row.status === 'approved') return canMarkPaid(user);
  return false;
}

router.put('/api/meal-claims/:id/lines/:lineId/approved', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (refuseOutOfRegion(req, res, row)) return;
  if (row.scheme !== 'gps') return res.status(400).json({ error: 'Only GPS meal claims have an approved amount per line' });
  if (!canAdjustApproved(req.user, row)) {
    return res.status(403).json({ error: 'Only the current approver, or Finance before payment, can change the approved amount' });
  }
  const line = (await q('SELECT * FROM meal_claim_lines WHERE id = $1 AND meal_claim_id = $2',
    [Number(req.params.lineId) || 0, row.id]))[0];
  if (!line || line.rejected_at) return res.status(404).json({ error: 'That line is no longer on this claim — reload and try again' });
  const b = req.body || {};
  const cents = parseAmountToCents(b.amount);
  if (cents === null) return res.status(400).json({ error: 'Enter the approved amount (0 or more)' });
  const claimed = Number(line.amount_cents);
  if (cents > claimed) return res.status(400).json({ error: `The approved amount can't be more than the ${fmtMoney(claimed, row.currency)} claimed` });
  const note = String(b.note || '').trim().slice(0, 500);
  const before = Number(line.approved_cents != null ? line.approved_cents : claimed);
  const next = cents === claimed ? null : cents;
  const actor = String(req.user.full_name || '').trim();
  try {
    await transaction([
      stillAsRead('meal_claims', row),
      qq(`UPDATE meal_claim_lines SET approved_cents = $1, approved_by_name = $2, approved_note = $3,
            approved_at = CASE WHEN $1::bigint IS NULL THEN NULL ELSE now() END
          WHERE id = $4 AND meal_claim_id = $5 AND rejected_at IS NULL`,
        [next, next == null ? '' : actor, next == null ? '' : note, line.id, row.id]),
      qq(payableTotalSql('meal'), [row.id])
    ]);
  } catch (e) {
    if (isStaleAbort(e)) return res.status(409).json({ error: STALE_DOCUMENT });
    throw e;
  }
  const order = await q('SELECT id FROM meal_claim_lines WHERE meal_claim_id = $1 ORDER BY sort_order, id', [row.id]);
  const n = order.findIndex(r => Number(r.id) === Number(line.id)) + 1;
  await logMealHistory(row.id, req.user, 'approved amount changed', row.status, row.status,
    `Line ${n} · ${line.line_date} · ${fmtMoney(before, row.currency)} → ${fmtMoney(cents, row.currency)}${note ? ` — ${note}` : ''}`);
  const fresh = (await q('SELECT * FROM meal_claims WHERE id = $1', [row.id]))[0];
  const claim = await serializeOneMeal(fresh);
  claim.can_adjust_approved = canAdjustApproved(req.user, fresh);
  res.json({ claim });
}));

// A GPS line's receipt, for anyone who may open the claim (mirrors GET
// /api/meal-claims/:id: region first, then ownership).
router.get('/api/meal-claims/:id/attachments/:attId', requireAuth, ah(async (req, res) => {
  const row = await loadMealClaimOr404(req, res);
  if (!row) return;
  if (!seesAllRegions(req.user) && String(row.region || '') !== String(req.user.region || '')) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  if (!userCan(req.user, 'view_all_claims') && row.employee_id !== req.user.id
      && !asIntArray(row.approver_ids).includes(req.user.id)) {
    return res.status(403).json({ error: 'You can only view your own attachments' });
  }
  const att = (await q(
    `SELECT a.* FROM attachments a JOIN meal_claim_lines l ON l.id = a.meal_line_id
      WHERE a.id = $1 AND l.meal_claim_id = $2`, [Number(req.params.attId) || 0, row.id]))[0];
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  await sendReceipt(res, att);
}));

// --- On / off per region -------------------------------------------------------------
// Read by any signed-in account for its own region; settings managers read and
// switch any region they may manage (resolveLookupRegion pins the rest).
router.get('/api/meal-gps-settings', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  const settings = await loadAppSettings();
  const out = { region, enabled: mealGpsEnabled(settings, region), rules: RULES };
  if (userCan(req.user, 'manage_settings') && region) {
    const rows = await q(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE base_lat IS NOT NULL)::int AS with_base
         FROM users WHERE region = $1 AND active = TRUE`, [region]);
    out.accounts = rows[0] ? rows[0].n : 0;
    out.with_base = rows[0] ? rows[0].with_base : 0;
    out.currency = (await regionPrefsFor(region)).currency;
  }
  res.json(out);
}));

router.put('/api/meal-gps-settings', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region || region === '*') return res.status(400).json({ error: 'Choose a region' });
  const settings = await loadAppSettings({ fresh: true });
  const byRegion = mealGpsMap(settings);
  byRegion[region] = { enabled: b.enabled === true };
  await setAppSetting('meal_gps_by_region', JSON.stringify(byRegion));
  res.json({ region, enabled: byRegion[region].enabled, rules: RULES });
}));

module.exports = { router, submitGpsMeal, resubmitGpsMeal, canAdjustApproved };
