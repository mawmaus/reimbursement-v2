'use strict';

// Region isolation for actions, through the real app (see _app.js: the database
// is an in-memory stand-in). A region-scoped account that may pay and delete
// must not be able to act on another region's documents by id — and must still
// act on its own region's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');

const FIN = 20, ROOT = 1;
// Region-scoped Finance with every money/delete right; it is also the approver
// on these documents, so only the region rule stands in its way.
state.users.set(FIN, account({ id: FIN, role: 'finance', department: 'Finance', can_mark_paid: true }));
state.users.set(ROOT, account({ id: ROOT, role: 'superadmin', region: '*' }));
state.settings.role_permissions = { finance: { mark_paid: true, delete_claims: true } };
const theirs = { employee_id: FIN, approver_ids: [FIN], manager_id: FIN };
state.tables.claims.push(doc({ id: 5, region: 'Thailand', status: 'approved', ...theirs }),
  doc({ id: 8, region: 'Thailand', status: 'paid', ...theirs }),
  doc({ id: 15, region: 'Indonesia', status: 'approved', ...theirs }));
state.tables.meal_claims.push(doc({ id: 6, region: 'Thailand', status: 'approved', ...theirs }));
state.tables.cash_advances.push(doc({ id: 7, region: 'Thailand', status: 'approved', ...theirs }));

const paid = { payment_date: '2026-10-01' };
// Every action that changes a document, aimed at another region's documents.
const ACTIONS = [
  ['PUT', '/api/claims/5', {}], ['POST', '/api/claims/5/approve', {}], ['POST', '/api/claims/5/reject', { comment: 'x' }],
  ['POST', '/api/claims/5/mark-paid', paid], ['POST', '/api/claims/8/revert', {}], ['DELETE', '/api/claims/5'],
  ['PUT', '/api/meal-claims/6', {}], ['POST', '/api/meal-claims/6/approve', {}], ['POST', '/api/meal-claims/6/reject', { comment: 'x' }],
  ['POST', '/api/meal-claims/6/mark-paid', paid], ['POST', '/api/meal-claims/6/revert', {}], ['DELETE', '/api/meal-claims/6'],
  ['PUT', '/api/cash-advances/7', {}], ['POST', '/api/cash-advances/7/approve', {}], ['POST', '/api/cash-advances/7/reject', { comment: 'x' }],
  ['POST', '/api/cash-advances/7/mark-paid', paid], ['POST', '/api/cash-advances/7/realize', {}], ['PUT', '/api/cash-advances/7/realize', {}],
  ['POST', '/api/cash-advances/7/settle', {}], ['POST', '/api/cash-advances/7/revert', {}], ['DELETE', '/api/cash-advances/7']
];

test('a region-scoped account cannot act on another region\'s documents', async (t) => {
  await serve(t);
  state.writes.length = 0;
  for (const [method, p, body] of ACTIONS) {
    const r = await call(FIN, method, p, body);
    assert.equal(r.status, 403, `${method} ${p} -> ${r.status} ${r.body}`);
    assert.match(r.body, /another region/, `${method} ${p}`);
  }
  assert.deepEqual(state.writes, [], 'nothing was written');
});

test('bulk payment actions skip another region\'s documents', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const pay = await call(FIN, 'POST', '/api/claims/mark-paid-bulk', { ...paid, items: [{ type: 'claim', id: 5 }, { type: 'meal', id: 6 }] });
  assert.deepEqual([pay.status, pay.json], [200, { paid: 0, skipped: 2 }]);
  const unpay = await call(FIN, 'POST', '/api/claims/revert-paid-bulk', { items: [{ type: 'claim', id: 8 }] });
  assert.equal(unpay.status, 200);
  assert.equal(unpay.json.skipped, 1);
  assert.deepEqual(state.writes, [], 'nothing was written');
});

test('the same account still acts on its own region; super admins act everywhere', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const own = await call(FIN, 'POST', '/api/claims/15/mark-paid', paid);
  assert.equal(own.status, 200, own.body);
  assert.ok(state.writes.some(w => /^UPDATE claims SET status='paid'/.test(w)), 'its own region\'s claim was paid');
  for (const [method, p, body] of ACTIONS) {
    const r = await call(ROOT, method, p, body);
    assert.doesNotMatch(r.body, /another region/, `super admin: ${method} ${p}`);
  }
  const bulk = await call(ROOT, 'POST', '/api/claims/mark-paid-bulk', { ...paid, items: [{ type: 'claim', id: 5 }] });
  assert.deepEqual(bulk.json, { paid: 1, skipped: 0 });
});

test('only super admins read the per-region overview', async (t) => {
  await serve(t);
  const fin = await call(FIN, 'GET', '/api/regions/overview');
  assert.equal(fin.status, 403, fin.body);
  const root = await call(ROOT, 'GET', '/api/regions/overview');
  assert.equal(root.status, 200, root.body);
  assert.equal(typeof root.json.items, 'object');
});
