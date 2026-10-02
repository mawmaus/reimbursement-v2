'use strict';

// The approval chain shared by all three document types: whose turn it is,
// payments, reverts, Approver 1 re-picks, stale-approver guards, the
// unrealized-advance hold, the claim-list window and which purposes an account
// may raise.

const { q } = require('../db');
const { asIntArray, isISODate } = require('./util');
const { userCan } = require('./permissions');
const { ALL_REGIONS } = require('./settings');

// Build the notification payload for a claim row (the shape lib/notify expects).
function reimbNotify(row) {
  return { claimNo: row.claim_no, claimantName: row.claimant_name,
    typeLabel: 'reimbursement claim', amount: Number(row.amount_cents) / 100, currency: row.currency };
}
function mealNotify(row) {
  return { claimNo: row.claim_no, claimantName: row.claimant_name,
    typeLabel: 'meal allowance claim', amount: Number(row.total_cents) / 100, currency: row.currency };
}
// The approver whose turn it currently is (1-based current_step), or null.
function currentApproverId(row) {
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  return step >= 1 && step <= ids.length ? ids[step - 1] : null;
}

// Bank details, claimant name and department now come from the claimant's
// account, so they are not required on the claim form itself.
const REQUIRED_FIELDS = ['expense_date', 'expense_type'];

// --- Approval routing -------------------------------------------------------
// Each account has an ordered list of approvers. A claim advances through them
// one at a time: only the approver at the current step may act. Super admins can
// always override. A claim with no approvers can only be approved by a superadmin.
function userCanApprove(user, claim) {
  if (user.role === 'superadmin') return true;
  const ids = asIntArray(claim.approver_ids);
  if (!ids.length) return false;
  return ids[(claim.current_step || 1) - 1] === user.id;
}

// Who may record a payment (mark paid / revert a payment): super admins always,
// plus any account a super admin has granted the can_mark_paid permission.
function canMarkPaid(user) {
  return user.role === 'superadmin' || user.can_mark_paid === true || userCan(user, 'mark_paid');
}

// --- Revert (undo one step) -------------------------------------------------
// Revert walks a claim back exactly one node of its lifecycle, and only the
// actor who owns that node may do it (super admins may always override):
//   paid                 -> approved     (the payer, i.e. a super admin)
//   approved             -> submitted    (the final approver — manager_id)
//   submitted @ step k>1 -> submitted @ k-1  (the approver of the previous step)
//   submitted @ step ≤1  -> rejected     (the claimant cancels to edit & resubmit)
// A rejected claim has nothing to revert (the claimant edits & resubmits it).
// Returns a plan { kind, action, from, to, comment } or a refusal { error, code }.
function planRevert(row, user) {
  const ids = asIntArray(row.approver_ids);
  const step = row.current_step || 0;
  const isSuper = user.role === 'superadmin';
  if (row.status === 'paid') {
    if (!canMarkPaid(user)) return { error: 'You do not have permission to revert a payment', code: 403 };
    return { kind: 'unpay', action: 'reverted payment', from: 'paid', to: 'approved' };
  }
  if (row.status === 'approved') {
    if (!isSuper && Number(row.manager_id) !== user.id) {
      return { error: 'Only the approver who approved this claim can revert the approval', code: 403 };
    }
    return { kind: 'unapprove-final', action: 'reverted approval', from: 'approved', to: 'submitted' };
  }
  if (row.status === 'submitted') {
    if (step > 1) {
      if (!isSuper && ids[step - 2] !== user.id) {
        return { error: 'Only the approver of the previous step can revert it', code: 403 };
      }
      return { kind: 'unapprove-step', action: 'reverted approval', from: 'submitted', to: 'submitted' };
    }
    if (!isSuper && Number(row.employee_id) !== user.id) {
      return { error: 'Only the claimant can revert this submission', code: 403 };
    }
    return { kind: 'cancel', action: 'reverted — cancelled to edit', from: 'submitted', to: 'rejected',
      comment: 'Reverted by the claimant to make changes' };
  }
  return { error: `A ${row.status} claim cannot be reverted`, code: 409 };
}

// The chain step whose approval a revert undoes — its line rejections are
// undone with it (see restoreStepRejections). 0 when no approval is undone.
// 'unapprove-final' leaves current_step on the final approver's own step;
// 'unapprove-step' hands back to the previous one.
function undoneApprovalStep(kind, step) {
  if (kind === 'unapprove-final') return step || 0;
  if (kind === 'unapprove-step') return (step || 0) - 1;
  return 0;
}

// --- Re-picking Approver 1 on a revert ---------------------------------------
// A revert that leaves a document waiting on step 1 is the one moment worth
// re-opening the Approver 1 choice: it is about to sit with the first approver
// again, so whoever reverts may hand it to a different one instead of the
// claimant having to cancel and resubmit. (A claimant's own revert lands on
// 'rejected', where the resubmit form already offers the same picker.)
// 'unapprove-final' leaves current_step where it is — approving the last step
// never advances it — so it lands on step 1 only for a one-approver chain or a
// superadmin override at step 1; 'unapprove-step' lands there when it undoes
// step 2. Every other kind ends up somewhere the first approver no longer
// decides anything, so the chain is left exactly as it is.
function revertLandsOnApprover1(kind, step) {
  if (kind === 'unapprove-final') return (step || 0) === 1;
  if (kind === 'unapprove-step') return (step || 0) === 2;
  return false;
}

// Resolve the Approver 1 re-pick riding along with such a revert. Absent (or
// unchanged) leaves the chain untouched — { ids: null }. A choice is validated
// against the claimant's own still-active candidates, and only honoured when
// there are two or more of them: exactly the rule the submit form's picker
// follows. Only the first link changes; the rest keeps its order, with the new
// approver pulled out of it so nobody appears in the chain twice.
async function resolveRevertApprover1(row, kind, chosenRaw) {
  if (chosenRaw === undefined || chosenRaw === null || chosenRaw === '') return { ids: null };
  const chosen = Number(chosenRaw);
  if (!Number.isInteger(chosen)) return { error: 'Choose a valid Approver 1' };
  if (!revertLandsOnApprover1(kind, row.current_step)) {
    return { error: 'Approver 1 can only be changed by a revert that sends this back to the first approver' };
  }
  const ids = asIntArray(row.approver_ids);
  if (ids[0] === chosen) return { ids: null };
  const emp = (await q('SELECT approver1_options FROM users WHERE id = $1', [row.employee_id]))[0] || {};
  const pool = await activeApproverIds(emp.approver1_options);
  if (pool.length < 2 || !pool.includes(chosen)) {
    return { error: 'That account is not one of the claimant\'s Approver 1 choices' };
  }
  const named = await q('SELECT full_name, username FROM users WHERE id = $1', [chosen]);
  const n = named[0] || {};
  return {
    ids: [chosen, ...ids.slice(1).filter(id => id !== chosen)],
    chosen,
    name: n.full_name || n.username || `User #${chosen}`
  };
}

// The claimant's chooseable Approver 1 pool for one document, for the drawer to
// render the revert picker with. Empty unless there are two or more candidates
// — with one there is nothing to choose, same as on the submit form.
async function claimantApprover1Choices(employeeId) {
  const u = (await q('SELECT approver1_options FROM users WHERE id = $1', [employeeId]))[0];
  const choices = u ? await approver1Choices(u.approver1_options) : [];
  return choices.length >= 2 ? choices : [];
}

// --- Stale-approver guards --------------------------------------------------
// Keep only the still-active approvers from a candidate list, preserving order.
// Used when a claim is submitted/resubmitted so a new claim never routes to a
// deactivated account (which could never log in to act on it). If every
// candidate is inactive the claim ends up with no approvers — a superadmin can
// still finalise it, which is the right fallback.
async function activeApproverIds(candidateIds) {
  const ids = asIntArray(candidateIds);
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rows = await q(`SELECT id FROM users WHERE id IN (${ph}) AND active = TRUE`, ids);
  const ok = new Set(rows.map(r => Number(r.id)));
  return ids.filter(id => ok.has(id));
}

// Build the ordered, still-active approver id list for a claim being submitted or
// resubmitted. `optionsRaw` is the account's chooseable-Approver-1 candidate pool
// and `baseRaw` its fixed chain. Behaviour keys off how many candidates are still
// active:
//   • none   → the chain is just the fixed list (legacy behaviour).
//   • one    → that candidate is Approver 1 automatically (no choice needed).
//   • two+   → the submitter must have picked one (`chosenRaw`) as Approver 1.
// The resulting Approver 1 is prepended to the fixed chain (de-duplicated).
// Returns { ids } on success or { error } when a required choice is missing or
// invalid — the caller maps that to a 400. Async because it filters out
// deactivated accounts (which could never act on the claim).
async function resolveSubmitApprovers(optionsRaw, baseRaw, chosenRaw) {
  const [activeOpts, base] = await Promise.all([
    activeApproverIds(optionsRaw),
    activeApproverIds(baseRaw),
  ]);
  if (!activeOpts.length) return { ids: base };
  let first;
  if (activeOpts.length === 1) {
    first = activeOpts[0];
  } else {
    const chosen = Number(chosenRaw);
    if (!Number.isInteger(chosen) || !activeOpts.includes(chosen)) {
      return { error: 'Please choose an Approver 1 for this claim' };
    }
    first = chosen;
  }
  return { ids: [first, ...base.filter(id => id !== first)] };
}

// How many still-open (submitted) claims — reimbursement + meal — have this user
// as the approver whose turn it currently is. Postgres arrays are 1-based, and
// current_step is 1-based, so approver_ids[current_step] is the pending approver.
async function openClaimsAwaitingApprover(userId) {
  const [reimb, meal, adv] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM claims
       WHERE status = 'submitted' AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId]),
    q(`SELECT COUNT(*)::int AS n FROM meal_claims
       WHERE status = 'submitted' AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId]),
    q(`SELECT COUNT(*)::int AS n FROM cash_advances
       WHERE status IN ('submitted','realize_submitted') AND current_step >= 1 AND approver_ids[current_step] = $1`, [userId])
  ]);
  return Number(reimb[0].n) + Number(meal[0].n) + Number(adv[0].n);
}

// --- Unrealized-advance hold -------------------------------------------------
// Money is out of the door and the paperwork closing it is not approved yet, so
// the holder may not start anything new: New Claim and New Meal Allowance are
// refused while they owe a realization. The three states are exactly the set the
// "Unrealized cash advances" tile counts —
//   paid              disbursed; the realization has not been submitted
//   realize_submitted realization submitted, still in the approver chain
//   rejected_realize  realization returned; awaiting a resubmit
//   realize_approved  …but only while the realization came in UNDER the advance:
//                     the unused balance is still with the employee, so the
//                     advance is not cleared until Finance AP settles it
//                     (confirms the refund was received). A top-up or an even
//                     realization is cleared on approval — nothing is owed back.
// Deliberately NOT held: raising another cash advance (a separate decision), and
// resubmitting an already-rejected claim or realization — blocking those would
// strand documents the employee has no other way to close.
const UNREALIZED_ADVANCE_STATES = ['paid', 'realize_submitted', 'rejected_realize'];
// The states are fixed literals defined right above, never user input.
const UNREALIZED_ADVANCE_SQL = UNREALIZED_ADVANCE_STATES.map((s) => `'${s}'`).join(',');

// --- Ledger window ------------------------------------------------------------
// The list endpoints take ?since=YYYY-MM-DD: the client asks for "open items plus
// anything active in the last 90 days" by default, and drops it for "Show all
// history". Open = still waiting on someone, whatever its age, so no queue ever
// loses an item: a claim pending approval or payment; an advance not yet closed
// (incl. an under-spent one awaiting its refund — same rule as the hold). Every
// state change stamps updated_at, so a paid/rejected/settled document stays in
// view for 90 days after it was last touched. A search always spans everything.
const OPEN_CLAIM_SQL = `status IN ('submitted','approved')`;
const OPEN_ADVANCE_SQL = `(status IN ('submitted','approved',${UNREALIZED_ADVANCE_SQL})
  OR (status = 'realize_approved' AND realized_total_cents < amount_cents))`;
function applyLedgerWindow(req, search, openSql, where, params) {
  const since = String((req.query && req.query.since) || '');
  if (search || !isISODate(since)) return;
  params.push(since);
  where.push(`(${openSql} OR COALESCE(updated_at, created_at) >= $${params.length}::date)`);
}

async function unrealizedAdvanceCount(userId) {
  const rows = await q(
    `SELECT COUNT(*)::int AS n FROM cash_advances
      WHERE employee_id = $1 AND (status IN (${UNREALIZED_ADVANCE_SQL})
         OR (status = 'realize_approved' AND realized_total_cents < amount_cents))`, [userId]);
  return Number(rows[0].n);
}

// Guard for the two "new submission" routes. Answers the request itself and
// returns true when the caller is on hold, so the route can bail on the spot —
// before it parses lines or verifies receipts.
async function heldByUnrealizedAdvance(req, res) {
  const n = await unrealizedAdvanceCount(req.user.id);
  if (!n) return false;
  res.status(409).json({
    code: 'unrealized_advance',
    count: n,
    error: n === 1
      ? 'You have a cash advance that is not cleared yet — it still needs to be realized, or its unused balance returned to Finance. Clear it before submitting a new claim.'
      : `You have ${n} cash advances that are not cleared yet — they still need to be realized, or their unused balance returned to Finance. Clear them before submitting a new claim.`
  });
  return true;
}

// --- Front-page purposes ----------------------------------------------------
// Which "purpose" buttons (New Claim / New Meal Allowance / New Cash Advance) a
// user may see.
//   New Claim / New Meal Allowance are ORG gates: each is visible only when it is
//     enabled on BOTH the user's department and their job position (AND), so an
//     unknown/blank department or position offers neither.
//   New Cash Advance is a PER-ACCOUNT grant (users.allow_advance) a super admin
//     hands out in the account editor. Department, job position and role play no
//     part — two colleagues sharing both can differ — so it also survives a blank
//     department/position, unlike the two org gates.
async function computePurposes(user) {
  const advance = user.role === 'superadmin' || user.allow_advance === true;
  const empty = { claim: false, meal: false, advance };
  // Superadmins can do everything: always show all three purpose buttons,
  // regardless of their own department/position/region flags.
  if (user.role === 'superadmin') return { claim: true, meal: true, advance: true };
  const dept = String(user.department || '').trim();
  const pos = String(user.position || '').trim();
  if (!dept || !pos) return empty;
  // Match the lookups in the user's own region; All-regions/blank accounts fall
  // back to matching any region's row.
  const region = String(user.region || '');
  const concrete = region && region !== ALL_REGIONS;
  const [drows, prows] = await Promise.all([
    concrete
      ? q('SELECT allow_claim, allow_meal FROM departments   WHERE lower(name) = lower($1) AND region = $2 AND active = TRUE', [dept, region])
      : q('SELECT allow_claim, allow_meal FROM departments   WHERE lower(name) = lower($1) AND active = TRUE', [dept]),
    concrete
      ? q('SELECT allow_claim, allow_meal FROM job_positions WHERE lower(name) = lower($1) AND region = $2 AND active = TRUE', [pos, region])
      : q('SELECT allow_claim, allow_meal FROM job_positions WHERE lower(name) = lower($1) AND active = TRUE', [pos])
  ]);
  const d = drows[0], p = prows[0];
  if (!d || !p) return empty;
  return {
    claim: !!(d.allow_claim && p.allow_claim),
    meal: !!(d.allow_meal && p.allow_meal),
    advance
  };
}

// Resolve an account's chooseable-Approver-1 candidate pool to [{id, name}],
// keeping only still-active accounts (an inactive one could never approve) and
// preserving the configured order. Empty for accounts without the feature.
async function approver1Choices(optionsRaw) {
  const ids = asIntArray(optionsRaw);
  if (!ids.length) return [];
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const rows = await q(
    `SELECT id, full_name, username FROM users WHERE id IN (${ph}) AND active = TRUE`, ids);
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  return ids.filter(id => byId.has(id)).map(id => {
    const r = byId.get(id);
    return { id, name: r.full_name || r.username || `User #${id}` };
  });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------
// Apply the ledger status filter. Besides the plain base statuses it understands
// the two "pending review" splits: pending_manager = still with the department
// Manager (submitted, step <= 1); pending_finance = Manager approved, now with
// FinanceAP (submitted, step >= 2). The split clauses reference current_step
// directly (safe literals); base statuses go through the parameterized `add`.
function applyListStatusFilter(status, where, add) {
  if (!status) return;
  if (status === 'pending_manager') where.push(`(status = 'submitted' AND COALESCE(current_step, 0) <= 1)`);
  else if (status === 'pending_finance') where.push(`(status = 'submitted' AND current_step >= 2)`);
  else add('status = $$', status);
}

module.exports = {
  computePurposes, unrealizedAdvanceCount, approver1Choices,
  applyListStatusFilter, applyLedgerWindow, OPEN_CLAIM_SQL,
  claimantApprover1Choices, heldByUnrealizedAdvance, resolveSubmitApprovers,
  currentApproverId, reimbNotify, userCanApprove, canMarkPaid, planRevert,
  resolveRevertApprover1, undoneApprovalStep, mealNotify, OPEN_ADVANCE_SQL,
  openClaimsAwaitingApprover, revertLandsOnApprover1
};
