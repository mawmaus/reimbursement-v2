'use strict';

// Who may do what, checked at the endpoints themselves through the real app
// (see _app.js: the database is an in-memory stand-in). Every refusal must
// also leave the database untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');

// --- the cast ------------------------------------------------------------------
const CLAIMANT = 10, APPROVER1 = 21, APPROVER2 = 22, LIMITED = 23, COLLEAGUE = 30, PAYER = 40, CMMD = 50, ROOT = 1;
for (const u of [
  account({ id: CLAIMANT }),
  account({ id: APPROVER1, position: 'Supervisor' }),
  account({ id: APPROVER2, position: 'Manager' }),
  account({ id: LIMITED, position: 'Supervisor', approval_limit_cents: 50000 }), // may approve up to IDR 500
  account({ id: COLLEAGUE }),                                                     // same region and department, no part in it
  account({ id: PAYER, role: 'finance', department: 'Finance', can_mark_paid: true }),
  account({ id: CMMD, role: 'admin', position: 'Manager' }),                      // Country Manager / MD
  account({ id: ROOT, role: 'superadmin', region: '*' })
]) state.users.set(u.id, u);
state.positions = [{ name: 'Director', rank: 3 }, { name: 'Manager', rank: 7, can_manage: true },
  { name: 'Supervisor', rank: 10, can_manage: true }, { name: 'Staff', rank: 13 }];
// Region matrix: CM/MD may delete claims; nobody here has view-all or settings rights.
state.settings.role_permissions = { admin: { delete_claims: true, export_csv: false } };

const chain = { employee_id: CLAIMANT, approver_ids: [APPROVER1, APPROVER2] };
state.tables.claims.push(
  doc({ id: 100, ...chain, status: 'submitted', current_step: 1 }),            // waiting on approver 1
  doc({ id: 101, ...chain, status: 'approved', current_step: 2, manager_id: APPROVER2 }),
  doc({ id: 102, ...chain, status: 'paid', current_step: 2, manager_id: APPROVER2 }),
  doc({ id: 103, employee_id: CLAIMANT, approver_ids: [LIMITED], status: 'submitted', current_step: 1, amount_cents: 100000 })
);
state.tables.claim_lines.push(
  { id: 1000, claim_id: 100, amount_cents: 100000, sort_order: 0 },
  { id: 1030, claim_id: 103, amount_cents: 100000, sort_order: 0 }
);

// Runs `fn` with a fresh write log and returns what it wrote.
async function writesDuring(fn) { state.writes.length = 0; const r = await fn(); return { r, writes: [...state.writes] }; }
async function refused(t, who, method, p, body, status, pattern) {
  const { r, writes } = await writesDuring(() => call(who, method, p, body));
  assert.equal(r.status, status, `${method} ${p} as ${who}: ${r.status} ${r.body}`);
  if (pattern) assert.match(r.json && r.json.error || '', pattern, `${method} ${p} as ${who}`);
  assert.deepEqual(writes, [], `${method} ${p} as ${who} must not write`);
}
async function allowed(who, method, p, body) {
  const { r, writes } = await writesDuring(() => call(who, method, p, body));
  assert.ok(r.status < 300, `${method} ${p} as ${who}: ${r.status} ${r.body}`);
  return writes;
}

test('opening a claim: its claimant and approvers, not colleagues or Finance without view-all', async (t) => {
  await serve(t);
  for (const who of [CLAIMANT, APPROVER1, APPROVER2, ROOT]) assert.equal((await call(who, 'GET', '/api/claims/100')).status, 200, `as ${who}`);
  for (const who of [COLLEAGUE, PAYER, CMMD]) assert.equal((await call(who, 'GET', '/api/claims/100')).status, 403, `as ${who}`);
  assert.equal((await call(null, 'GET', '/api/claims/100')).status, 401, 'signed out');
});

test('approving and rejecting: only the approver whose turn it is', async (t) => {
  await serve(t);
  for (const who of [APPROVER2, CLAIMANT, COLLEAGUE, PAYER, CMMD]) {
    await refused(t, who, 'POST', '/api/claims/100/approve', {}, 403, /not the approver/);
    await refused(t, who, 'POST', '/api/claims/100/reject', { comment: 'no' }, 403, /not the approver/);
  }
  await refused(t, APPROVER1, 'POST', '/api/claims/100/reject', {}, 400, /reason is required/);
  const writes = await allowed(APPROVER1, 'POST', '/api/claims/100/approve', {});
  assert.ok(writes.some(w => /^UPDATE claims SET current_step/.test(w)), 'hands the claim to approver 2');
  assert.ok((await allowed(APPROVER1, 'POST', '/api/claims/100/reject', { comment: 'Missing receipt' })).some(w => /status='rejected'/.test(w)));
  assert.ok((await allowed(ROOT, 'POST', '/api/claims/100/approve', {})).some(w => /status='approved'/.test(w)), 'a super admin finalises');
  // Nothing to approve once it has moved on.
  await refused(t, APPROVER2, 'POST', '/api/claims/101/approve', {}, 409);
});

test('an approval limit blocks a claim above it', async (t) => {
  await serve(t);
  await refused(t, LIMITED, 'POST', '/api/claims/103/approve', {}, 403, /above your approval limit of IDR 500/);
});

test('marking paid: Finance (can mark paid) only, and only approved claims', async (t) => {
  await serve(t);
  for (const who of [CLAIMANT, APPROVER2, COLLEAGUE, CMMD]) {
    await refused(t, who, 'POST', '/api/claims/101/mark-paid', { payment_date: '2026-10-01' }, 403, /permission to mark claims as paid/);
  }
  await refused(t, PAYER, 'POST', '/api/claims/101/mark-paid', {}, 400, /payment date is required/);
  await refused(t, PAYER, 'POST', '/api/claims/100/mark-paid', { payment_date: '2026-10-01' }, 409, /Only approved claims/);
  assert.ok((await allowed(PAYER, 'POST', '/api/claims/101/mark-paid', { payment_date: '2026-10-01' })).some(w => /status='paid'/.test(w)));
  await refused(t, CLAIMANT, 'POST', '/api/claims/mark-paid-bulk', { payment_date: '2026-10-01', items: [{ type: 'claim', id: 101 }] }, 403);
});

test('reverting: only whoever owns the step being undone', async (t) => {
  await serve(t);
  // A payment: the payer.
  for (const who of [CLAIMANT, APPROVER2, COLLEAGUE]) await refused(t, who, 'POST', '/api/claims/102/revert', {}, 403);
  assert.ok((await allowed(PAYER, 'POST', '/api/claims/102/revert', {})).some(w => /status='approved'/.test(w)));
  // A final approval: the approver who gave it.
  for (const who of [APPROVER1, CLAIMANT, PAYER]) await refused(t, who, 'POST', '/api/claims/101/revert', {}, 403, /approver who approved/);
  assert.ok((await allowed(APPROVER2, 'POST', '/api/claims/101/revert', {})).some(w => /status='submitted'/.test(w)));
  // A claim still at step 1: the claimant pulls it back.
  for (const who of [APPROVER1, COLLEAGUE]) await refused(t, who, 'POST', '/api/claims/100/revert', {}, 403, /Only the claimant/);
  assert.ok((await allowed(CLAIMANT, 'POST', '/api/claims/100/revert', {})).some(w => /status='rejected'/.test(w)));
});

test('deleting: only accounts with the delete capability', async (t) => {
  await serve(t);
  for (const who of [CLAIMANT, APPROVER1, PAYER]) await refused(t, who, 'DELETE', '/api/claims/100', null, 403);
  assert.ok((await allowed(CMMD, 'DELETE', '/api/claims/100')).some(w => /^DELETE FROM claims/.test(w)));
});

test('settings, accounts and reports are closed to accounts without the right', async (t) => {
  await serve(t);
  await refused(t, CLAIMANT, 'PUT', '/api/claim-window', { region: 'Indonesia', max_age_days: 1 }, 403);
  await refused(t, CMMD, 'PUT', '/api/claim-window', { region: 'Indonesia', max_age_days: 1 }, 403, /permission/);
  await refused(t, CLAIMANT, 'PUT', '/api/meal-rates', { region: 'Indonesia', rates: [1] }, 403);
  await refused(t, CLAIMANT, 'PUT', '/api/region-prefs', { region: 'Indonesia', currency: 'USD' }, 403);
  await refused(t, CLAIMANT, 'GET', '/api/role-permissions', null, 403);
  await refused(t, PAYER, 'PUT', '/api/role-permissions', { region: 'Indonesia', role: 'finance', cap: 'mark_paid', value: true }, 403);
  assert.equal((await call(CMMD, 'GET', '/api/role-permissions?region=Indonesia')).status, 200, 'a CM/MD may open the matrix');
  await refused(t, CMMD, 'PUT', '/api/role-permissions', { region: 'Indonesia', role: 'admin', cap: 'view_all_claims', value: true }, 400, /not editable/);
  await refused(t, CLAIMANT, 'GET', '/api/users', null, 403);
  await refused(t, CMMD, 'PUT', '/api/users/10', { full_name: 'x' }, 403);
  await refused(t, CLAIMANT, 'POST', '/api/users', { username: 'x', password: 'abcdefgh', full_name: 'X' }, 403);
  await refused(t, COLLEAGUE, 'POST', '/api/users/10/set-active', { active: false }, 403);
  await refused(t, APPROVER1, 'POST', '/api/users/22/reset-password', { password: 'abcdefgh' }, 403, /permission/);
  await refused(t, CMMD, 'POST', '/api/test-email', {}, 403);
  await refused(t, CLAIMANT, 'GET', '/api/export.csv', null, 403);
  await refused(t, CLAIMANT, 'GET', '/api/insights', null, 403, /access to insights/);
  await refused(t, CMMD, 'POST', '/api/date-change-requests/1/decide', { decision: 'grant' }, 403);
});

test('the reminder job needs its secret', async (t) => {
  await serve(t);
  process.env.CRON_SECRET = 'cron-secret';
  t.after(() => { delete process.env.CRON_SECRET; });
  const { r, writes } = await writesDuring(() => call(null, 'GET', '/api/cron/reminders'));
  assert.equal(r.status, 401);
  assert.deepEqual(writes, []);
  assert.equal((await call(null, 'GET', '/api/cron/reminders', null, { authorization: 'Bearer cron-secret' })).status, 200);
});
