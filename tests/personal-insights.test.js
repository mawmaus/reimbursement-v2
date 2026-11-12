'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

test('staff can view approval times for their own claims only', async t => {
  const staff = 10;
  const colleague = 20;
  state.users.set(staff, account({ id: staff, position: 'Staff' }));
  state.users.set(colleague, account({ id: colleague, position: 'Staff' }));
  state.positions = [{ name: 'Staff', rank: 13 }];
  const event = (employee_id, action, hours) => ({
    cid: `c${employee_id}`, employee_id, name: `Staff ${employee_id}`, username: `user${employee_id}`,
    action, at_ms: hours * 3600000, d: '2026-11-01'
  });
  state.approvalEvents = [
    event(staff, 'submitted', 0),
    event(staff, 'approved — step 1 of 2', 12),
    event(staff, 'approved — step 2 of 2', 36),
    event(colleague, 'submitted', 0),
    event(colleague, 'approved — step 1 of 2', 48)
  ];
  await serve(t);
  assert.equal((await call(null, 'GET', '/api/insights/mine')).status, 401);
  assert.equal((await call(staff, 'GET', '/api/insights')).status, 403);
  const own = await call(staff, 'GET', `/api/insights/mine?employee_id=${colleague}&name=Staff+20`);
  assert.equal(own.status, 200, own.body);
  assert.deepEqual(own.json.approvalByEmployee.map(({ employee_id, manager, finance }) => ({
    employee_id, manager, finance
  })), [{ employee_id: staff, manager: { n: 1, avg_days: 0.5 }, finance: { n: 1, avg_days: 1 } }]);
  // Each own claim is listed with the time each stage took.
  assert.deepEqual(own.json.approvalByEmployee[0].claims, [{
    cid: `c${staff}`, claim_no: '', submitted: '2026-11-01', manager_days: 0.5, finance_days: 1
  }]);
});

test('an approver sees their own approval times in Insights next to their team', async t => {
  const supervisor = 30;
  const report = 31;
  state.users.set(supervisor, account({ id: supervisor, position: 'Supervisor', department: 'Ops' }));
  state.users.set(report, account({ id: report, position: 'Staff', department: 'Ops' }));
  state.positions = [{ name: 'Supervisor', rank: 10 }, { name: 'Staff', rank: 13 }];
  const event = (employee_id, action, hours, appr) => ({
    cid: `c${employee_id}`, employee_id, name: `User ${employee_id}`, username: `user${employee_id}`,
    action, at_ms: hours * 3600000, d: '2026-11-01', appr
  });
  state.approvalEvents = [
    event(supervisor, 'submitted', 0, [99]),
    event(supervisor, 'approved — step 1 of 2', 24, [99]),
    event(report, 'submitted', 0, [supervisor]),
    event(report, 'approved — step 1 of 2', 6, [supervisor])
  ];
  await serve(t);
  const res = await call(supervisor, 'GET', '/api/insights');
  assert.equal(res.status, 200, res.body);
  const rows = Object.fromEntries(res.json.approvalByEmployee.map(e => [e.employee_id, e.manager]));
  assert.deepEqual(rows[supervisor], { n: 1, avg_days: 1 });
  assert.deepEqual(rows[report], { n: 1, avg_days: 0.25 });
});
