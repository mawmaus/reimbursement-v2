'use strict';

// Marking many claims paid (or reverting payment) in one go.

const express = require('express');
const { q, qq, transaction } = require('../db');
const { notifyClaimantDecision } = require('../lib/notify');
const { reimbNotify, mealNotify, canMarkPaid } = require('../lib/workflow');
const { advanceNotify } = require('../lib/advances');
const { intArrayLiteral, ah, DATE_RE } = require('../lib/util');
const { requireAuth, inUserRegion } = require('../lib/auth');

const router = express.Router();

// --- Bulk payment actions ---------------------------------------------------
// The client used to POST one /:id request per ticked claim — N round trips and
// N independent writes. These two routes settle a whole selection in a single
// transaction instead, with the same eligibility rules, history lines and
// notifications the single routes apply.
const BULK_PAID_KINDS = {
  claim:   { table: 'claims',        history: 'claim_history',        historyCol: 'claim_id',      notify: reimbNotify,   action: (d) => `marked paid — ${d}` },
  meal:    { table: 'meal_claims',   history: 'meal_claim_history',   historyCol: 'meal_claim_id', notify: mealNotify,    action: (d) => `marked paid — ${d}` },
  advance: { table: 'cash_advances', history: 'cash_advance_history', historyCol: 'advance_id',    notify: advanceNotify, action: (d) => `advance paid — ${d}` }
};
// One transaction is one HTTP round trip to Neon carrying two statements per
// claim, so a selection is capped rather than sent unbounded.
const BULK_PAID_MAX = 200;
// Run fn over items with at most `limit` in flight — used for the notification
// fan-out below, so a large batch can't serialise long enough to time out.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
// Group a bulk request's {type, id} items by kind and load the rows actually in
// `requiredStatus` — one lookup per kind, never one per claim. Requiring the
// status in SQL is also what keeps a stale client honest: a row someone else
// has already moved simply isn't eligible, rather than being walked to whatever
// its new status happens to allow.
// Documents from outside `user`'s region are never eligible (see inUserRegion).
async function loadBulkEligible(items, requiredStatus, user) {
  const idsByKind = { claim: [], meal: [], advance: [] };
  for (const it of items) {
    const kind = BULK_PAID_KINDS[it && it.type] ? it.type : null;
    const id = Number(it && it.id);
    if (kind && Number.isInteger(id) && id > 0) idsByKind[kind].push(id);
  }
  const eligible = []; // { kind, row }
  for (const kind of Object.keys(idsByKind)) {
    const ids = idsByKind[kind];
    if (!ids.length) continue;
    const { table } = BULK_PAID_KINDS[kind];
    const rows = await q(`SELECT * FROM ${table} WHERE id = ANY($1::int[]) AND status = $2`,
      [intArrayLiteral(ids), requiredStatus]);
    for (const r of rows) if (inUserRegion(user, r)) eligible.push({ kind, row: r });
  }
  return eligible;
}
// One guarded UPDATE + history INSERT per eligible row, committed together. The
// UPDATE re-checks the status (someone may have moved the row since it was
// loaded) and the history line is written only for a row it actually moved.
// Returns the entries that moved.
async function commitBulkTransition(eligible, user, { set, params, action, from, to, comment }) {
  const queries = [];
  for (const { kind, row } of eligible) {
    const { table, history, historyCol } = BULK_PAID_KINDS[kind];
    // $1-$7 are the row id, the required status and the history fields, so a
    // caller's own placeholders start at $8 and no caller has to count them.
    // (The casts matter: a bare parameter in a SELECT list would resolve as text.)
    queries.push(qq(
      `WITH moved AS (UPDATE ${table} SET ${set}, updated_at=now() WHERE id=$1 AND status=$2::text RETURNING id)
       INSERT INTO ${history} (${historyCol}, actor_id, actor_name, action, from_status, to_status, comment)
       SELECT id, $3::int, $4::text, $5::text, $2::text, $6::text, $7::text FROM moved RETURNING ${historyCol} AS id`,
      [row.id, from, user.id, user.full_name, action(kind, row), to, comment, ...(params ? params(row) : [])]));
  }
  const results = await transaction(queries);
  return eligible.filter((_, i) => results[i] && results[i].length);
}

router.post('/api/claims/mark-paid-bulk', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to mark claims as paid' });
  const paymentDate = String((req.body && req.body.payment_date) || '').trim();
  if (!DATE_RE.test(paymentDate)) return res.status(400).json({ error: 'A payment date is required to mark a claim as paid' });
  const comment = String((req.body && req.body.comment) || '').trim();
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (items.length > BULK_PAID_MAX) {
    return res.status(400).json({ error: `Mark at most ${BULK_PAID_MAX} claims as paid at a time` });
  }

  // Only 'approved' rows move; anything else is silently skipped and counted,
  // the way the client's own pre-filter already expects.
  const eligible = await loadBulkEligible(items, 'approved', req.user);
  if (!eligible.length) return res.json({ paid: 0, skipped: items.length });

  const moved = await commitBulkTransition(eligible, req.user, {
    set: 'status=\'paid\', paid_by=$8, paid_at=$9',
    params: () => [req.user.id, paymentDate],
    action: (kind) => BULK_PAID_KINDS[kind].action(paymentDate),
    from: 'approved', to: 'paid', comment
  });

  // Notify from the rows already in hand — the three payload builders read only
  // claim_no / claimant_name / amount / currency, none of which mark-paid
  // touches, so there is nothing to re-read. notifyClaimantDecision swallows
  // its own failures, so a dead mailbox can't unwind a committed payment.
  await mapLimit(moved, 4, ({ kind, row }) =>
    notifyClaimantDecision(row.employee_id, BULK_PAID_KINDS[kind].notify(row), 'paid'));

  res.json({ paid: moved.length, skipped: items.length - moved.length });
}));

// The mirror of the above: walk a selection of paid claims back to approved.
// This is planRevert's 'unpay' step, which is identical across all three claim
// types (same gate, same columns cleared, same history line) and sends no
// notification — so unlike mark-paid it needs no per-kind branching.
router.post('/api/claims/revert-paid-bulk', requireAuth, ah(async (req, res) => {
  if (!canMarkPaid(req.user)) return res.status(403).json({ error: 'You do not have permission to revert a payment' });
  const comment = String((req.body && req.body.comment) || '').trim();
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (items.length > BULK_PAID_MAX) {
    return res.status(400).json({ error: `Revert at most ${BULK_PAID_MAX} payments at a time` });
  }

  // Only 'paid' rows move. The single /:id/revert route runs planRevert on
  // whatever status it finds, so a selection made stale by someone else's edit
  // could walk a claim back a step nobody asked for; requiring 'paid' here
  // means such a row is skipped instead.
  const eligible = await loadBulkEligible(items, 'paid', req.user);
  if (!eligible.length) return res.json({ reverted: 0, skipped: items.length });

  const moved = await commitBulkTransition(eligible, req.user, {
    set: 'status=\'approved\', paid_by=NULL, paid_at=NULL',
    action: () => 'reverted payment',
    from: 'paid', to: 'approved', comment
  });

  res.json({ reverted: moved.length, skipped: items.length - moved.length });
}));

module.exports = router;
