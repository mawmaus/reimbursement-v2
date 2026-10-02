'use strict';

// The daily approver reminder digest (Vercel Cron).

const express = require('express');
const { q } = require('../db');
const { sendReminderDigest } = require('../lib/notify');
const { ah } = require('../lib/util');
const { currentApproverId, reimbNotify, mealNotify } = require('../lib/workflow');
const { advanceNotify } = require('../lib/advances');

const router = express.Router();

// ---------------------------------------------------------------------------
// Daily reminder (Vercel Cron)
// ---------------------------------------------------------------------------
// Vercel Cron calls this once a day (see vercel.json). It emails every approver
// a digest of the claims currently sitting at their step. Protected by
// CRON_SECRET: Vercel sends it as an "Authorization: Bearer <secret>" header.
router.get('/api/cron/reminders', ah(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const byApprover = new Map(); // approverId -> [claim payloads]
  const push = (id, payload) => {
    if (!id) return;
    if (!byApprover.has(id)) byApprover.set(id, []);
    byApprover.get(id).push(payload);
  };
  const reimb = await q(
    `SELECT claim_no, claimant_name, amount_cents, currency, approver_ids, current_step
     FROM claims WHERE status = 'submitted'`);
  for (const r of reimb) push(currentApproverId(r), reimbNotify(r));
  const meal = await q(
    `SELECT claim_no, claimant_name, total_cents, currency, approver_ids, current_step
     FROM meal_claims WHERE status = 'submitted'`);
  for (const r of meal) push(currentApproverId(r), mealNotify(r));
  const adv = await q(
    `SELECT advance_no, claimant_name, amount_cents, currency, approver_ids, current_step
     FROM cash_advances WHERE status IN ('submitted','realize_submitted')`);
  for (const r of adv) push(currentApproverId(r), advanceNotify(r));

  let sent = 0;
  for (const [approverId, claims] of byApprover) {
    const r = await sendReminderDigest(approverId, claims);
    if (r && r.ok) sent += 1;
  }
  res.json({ ok: true, approvers: byApprover.size, sent });
}));

module.exports = router;
