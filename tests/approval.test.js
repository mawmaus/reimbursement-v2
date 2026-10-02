'use strict';

// The approval chain: whose turn it is, who may record a payment, and who may
// revert which step (claims and cash advances).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./_rules');

const CLAIMANT = 10, A1 = 21, A2 = 22, A3 = 23, OTHER = 99;
const chain = { employee_id: CLAIMANT, approver_ids: [A1, A2, A3] };
const as = (id, props = {}, caps = {}) => R.user({ id, ...props }, caps);
const SUPER = as(1, { role: 'superadmin' });
const PAYER = as(50, { can_mark_paid: true });

test('currentApproverId follows current_step through the chain', () => {
  assert.equal(R.currentApproverId({ ...chain, current_step: 1 }), A1);
  assert.equal(R.currentApproverId({ ...chain, current_step: 3 }), A3);
  assert.equal(R.currentApproverId({ ...chain, current_step: 4 }), null, 'past the end');
  assert.equal(R.currentApproverId({ ...chain, current_step: 0 }), null);
  assert.equal(R.currentApproverId({ approver_ids: '{21,22}', current_step: 2 }), A2, 'Postgres array text');
});

test('userCanApprove: only the approver whose turn it is (super admins override)', () => {
  const atStep2 = { ...chain, current_step: 2 };
  assert.equal(R.userCanApprove(as(A2), atStep2), true);
  assert.equal(R.userCanApprove(as(A1), atStep2), false, 'an earlier approver cannot act again');
  assert.equal(R.userCanApprove(as(A3), atStep2), false, 'a later approver must wait');
  assert.equal(R.userCanApprove(as(CLAIMANT), atStep2), false);
  assert.equal(R.userCanApprove(SUPER, atStep2), true);
  assert.equal(R.userCanApprove(as(A1), { ...chain, current_step: 0 }), true, 'step 0 is treated as step 1');
  assert.equal(R.userCanApprove(as(A1), { approver_ids: [], current_step: 1 }), false, 'no chain: super admin only');
});

test('canMarkPaid: super admin, the can_mark_paid flag, or the mark_paid capability', () => {
  assert.equal(R.canMarkPaid(SUPER), true);
  assert.equal(R.canMarkPaid(PAYER), true);
  assert.equal(R.canMarkPaid(as(2, {}, { mark_paid: true })), true);
  assert.equal(R.canMarkPaid(as(2, { can_mark_paid: 'true' })), false, 'only a real boolean flag counts');
  assert.equal(R.canMarkPaid(as(2)), false);
});

test('planRevert: each step can only be undone by whoever owns it', () => {
  const paid = { ...chain, status: 'paid', current_step: 3, manager_id: A3 };
  assert.equal(R.planRevert(paid, PAYER).kind, 'unpay');
  assert.equal(R.planRevert(paid, as(A3)).code, 403, 'the final approver is not the payer');

  const approved = { ...chain, status: 'approved', current_step: 3, manager_id: A3 };
  assert.deepEqual(R.planRevert(approved, as(A3)), { kind: 'unapprove-final', action: 'reverted approval', from: 'approved', to: 'submitted' });
  assert.equal(R.planRevert(approved, as(A2)).code, 403);

  const atStep3 = { ...chain, status: 'submitted', current_step: 3 };
  assert.equal(R.planRevert(atStep3, as(A2)).kind, 'unapprove-step', 'the previous step\'s approver takes it back');
  assert.equal(R.planRevert(atStep3, as(A3)).code, 403, 'the current approver cannot revert (they reject instead)');
  assert.equal(R.planRevert(atStep3, as(CLAIMANT)).code, 403);

  const atStep1 = { ...chain, status: 'submitted', current_step: 1 };
  const cancel = R.planRevert(atStep1, as(CLAIMANT));
  assert.equal(cancel.kind, 'cancel');
  assert.equal(cancel.to, 'rejected', 'the claimant pulls it back to edit');
  assert.equal(R.planRevert(atStep1, as(A1)).code, 403);
});

test('planRevert: super admins may revert any step; rejected claims have nothing to revert', () => {
  for (const [status, step] of [['paid', 3], ['approved', 3], ['submitted', 3], ['submitted', 1]]) {
    assert.equal(R.planRevert({ ...chain, status, current_step: step, manager_id: A3 }, SUPER).error, undefined, `${status}@${step}`);
  }
  const rejected = R.planRevert({ ...chain, status: 'rejected' }, SUPER);
  assert.equal(rejected.code, 409);
});

test('undoneApprovalStep and revertLandsOnApprover1', () => {
  assert.equal(R.undoneApprovalStep('unapprove-final', 3), 3);
  assert.equal(R.undoneApprovalStep('unapprove-step', 3), 2);
  assert.equal(R.undoneApprovalStep('cancel', 1), 0);
  assert.equal(R.undoneApprovalStep('unpay', 3), 0);
  assert.equal(R.revertLandsOnApprover1('unapprove-step', 2), true);
  assert.equal(R.revertLandsOnApprover1('unapprove-step', 3), false);
  assert.equal(R.revertLandsOnApprover1('unapprove-final', 1), true, 'one-approver chain');
  assert.equal(R.revertLandsOnApprover1('unapprove-final', 3), false);
  assert.equal(R.revertLandsOnApprover1('cancel', 1), false);
});

test('planAdvanceRevert walks both phases back one step, owner only', () => {
  const adv = (status, step, extra = {}) => ({ ...chain, status, current_step: step, manager_id: A3, ...extra });
  const cases = [
    // [row, actor, expected kind or error code, expected target status]
    [adv('settled', 3), PAYER, 'unsettle', 'realize_approved'],
    [adv('settled', 3), as(A3), 403],
    [adv('realize_approved', 3), as(A3), 'unapprove-final', 'realize_submitted'],
    [adv('realize_approved', 3), as(A2), 403],
    [adv('realize_submitted', 2), as(A1), 'unapprove-step', 'realize_submitted'],
    [adv('realize_submitted', 1), as(CLAIMANT), 'cancel', 'rejected_realize'],
    [adv('realize_submitted', 1), as(OTHER), 403],
    [adv('paid', 3), PAYER, 'unpay', 'approved'],
    [adv('paid', 3), as(CLAIMANT), 403],
    [adv('approved', 3), as(A3), 'unapprove-final', 'submitted'],
    [adv('submitted', 3), as(A2), 'unapprove-step', 'submitted'],
    [adv('submitted', 1), as(CLAIMANT), 'cancel', 'rejected'],
    [adv('rejected', 1), SUPER, 409],
    [adv('rejected_realize', 1), SUPER, 409]
  ];
  for (const [row, actor, want, to] of cases) {
    const plan = R.planAdvanceRevert(row, actor);
    const label = `${row.status}@${row.current_step} by ${actor.id}`;
    if (typeof want === 'number') assert.equal(plan.code, want, label);
    else { assert.equal(plan.kind, want, label); assert.equal(plan.to, to, label); }
  }
  assert.equal(R.planAdvanceRevert(adv('submitted', 3), as(A2)).sql, 'current_step=2', 'hands back to the previous step');
});
