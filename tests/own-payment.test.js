'use strict';

// Recording a payment needs a second person: a payer (Finance with the mark-paid
// permission) never pays their own claim, meal claim or cash advance, singly or
// in bulk. Super Admins and Regional Admins are exempt (they test with their own
// claims). Through the real app (see _app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');

const FIN = 40, ROOT = 41, OTHER = 42, RA = 43;
state.users.set(FIN, account({ id: FIN, role: 'finance', department: 'Finance', can_mark_paid: true }));
state.users.set(ROOT, account({ id: ROOT, role: 'superadmin', region: '*' }));
state.users.set(OTHER, account({ id: OTHER }));
state.users.set(RA, account({ id: RA, role: 'regionadmin' }));
const mine = { employee_id: FIN, approver_ids: [OTHER], manager_id: OTHER };
state.tables.claims.push(
  doc({ id: 50, status: 'approved', ...mine }),
  doc({ id: 51, status: 'approved', employee_id: OTHER, approver_ids: [ROOT], manager_id: ROOT }),
  doc({ id: 52, status: 'approved', employee_id: ROOT, approver_ids: [], manager_id: ROOT }),
  doc({ id: 53, status: 'approved', employee_id: RA, approver_ids: [], manager_id: RA }));
state.tables.meal_claims.push(doc({ id: 54, status: 'approved', ...mine }));
state.tables.cash_advances.push(doc({ id: 55, status: 'approved', ...mine }), doc({ id: 56, status: 'realize_approved', ...mine }));
const paid = { payment_date: '2026-11-18' };

test('a payer cannot record the payment of their own documents', async (t) => {
  await serve(t);
  for (const p of ['/api/claims/50/mark-paid', '/api/meal-claims/54/mark-paid',
    '/api/cash-advances/55/mark-paid', '/api/cash-advances/56/settle']) {
    const r = await call(FIN, 'POST', p, paid);
    assert.equal(r.status, 403, `${p}: ${r.body}`);
    assert.match(r.json.error, /Someone else must record the payment/);
  }
});

test('bulk mark-paid skips the payer’s own claims and pays the rest', async (t) => {
  await serve(t);
  const r = await call(FIN, 'POST', '/api/claims/mark-paid-bulk', { ...paid, items: [{ type: 'claim', id: 50 }, { type: 'claim', id: 51 }] });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json, { paid: 1, skipped: 1 });
});

test('Super Admins and Regional Admins may still pay their own claims', async (t) => {
  await serve(t);
  let r = await call(ROOT, 'POST', '/api/claims/52/mark-paid', paid);
  assert.equal(r.status, 200, r.body);
  r = await call(RA, 'POST', '/api/claims/53/mark-paid', paid);
  assert.equal(r.status, 200, r.body);
});
