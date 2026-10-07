'use strict';

// Two people acting on one document at once (or one double-click): the second
// action must be refused rather than overwrite the first. Plus the smaller
// write-safety fixes: account edits, the reminder job, search patterns and
// receipt downloads. Through the real app over the in-memory stand-in (_app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { state, account, doc, serve, call } = require('./_app');
const { likeContains } = require('../lib/util');
const { sendReceipt } = require('../lib/blob');

const CLAIMANT = 10, APPROVER1 = 21, APPROVER2 = 22, PAYER = 40, ROOT = 1;
for (const u of [
  account({ id: CLAIMANT }),
  account({ id: APPROVER1, position: 'Supervisor' }),
  account({ id: APPROVER2, position: 'Manager' }),
  account({ id: PAYER, role: 'finance', department: 'Finance', can_mark_paid: true }),
  account({ id: ROOT, role: 'superadmin', region: '*' })
]) state.users.set(u.id, u);

const chain = { employee_id: CLAIMANT, approver_ids: [APPROVER1, APPROVER2] };
state.tables.claims.push(
  doc({ id: 200, ...chain, status: 'submitted', current_step: 2 }),
  doc({ id: 201, ...chain, status: 'approved', current_step: 2, manager_id: APPROVER2 }),
  doc({ id: 202, ...chain, status: 'approved', current_step: 2, manager_id: APPROVER2 }),
  doc({ id: 203, ...chain, status: 'approved', current_step: 2, manager_id: APPROVER2 })
);
state.tables.meal_claims.push(doc({ id: 300, ...chain, status: 'submitted', current_step: 2 }));
state.tables.cash_advances.push(doc({ id: 400, ...chain, status: 'realize_approved', current_step: 2, manager_id: APPROVER2 }));
state.tables.claim_lines.push({ id: 2000, claim_id: 200, amount_cents: 100000, sort_order: 0 });
state.tables.meal_claim_lines.push({ id: 3000, meal_claim_id: 300, amount_cents: 100000, sort_order: 0 });

const find = (table, id) => state.tables[table].find(r => r.id === id);
// Run `fn` while the document is moved to `status` by "someone else" just before
// the request's first write lands; puts it back afterwards.
async function racing(table, id, status, fn) {
  const row = find(table, id);
  const before = row.status;
  state.writes.length = 0;
  state.onWrite = () => { row.status = status; state.onWrite = null; };
  try { return { r: await fn(), writes: [...state.writes] }; }
  finally { state.onWrite = null; row.status = before; }
}
const noHistory = (writes) => assert.ok(!writes.some(w => /^INSERT INTO \w*history/.test(w)), `no history written: ${writes}`);

test('approving a claim someone has just rejected is refused', async (t) => {
  await serve(t);
  const { r, writes } = await racing('claims', 200, 'rejected', () => call(APPROVER2, 'POST', '/api/claims/200/approve', {}));
  assert.equal(r.status, 409, r.body);
  assert.match(r.json.error, /Someone else has just changed/);
  noHistory(writes);
});

test('rejecting a meal claim someone has just approved is refused', async (t) => {
  await serve(t);
  const { r, writes } = await racing('meal_claims', 300, 'approved', () => call(APPROVER2, 'POST', '/api/meal-claims/300/reject', { comment: 'no' }));
  assert.equal(r.status, 409, r.body);
  noHistory(writes);
});

test('a second "mark paid" (double-click) is refused, not recorded twice', async (t) => {
  await serve(t);
  const { r, writes } = await racing('claims', 201, 'paid', () => call(PAYER, 'POST', '/api/claims/201/mark-paid', { payment_date: '2026-10-01' }));
  assert.equal(r.status, 409, r.body);
  noHistory(writes);
});

test('settling or reverting an advance that has moved on is refused', async (t) => {
  await serve(t);
  let { r } = await racing('cash_advances', 400, 'settled', () => call(PAYER, 'POST', '/api/cash-advances/400/settle', {}));
  assert.equal(r.status, 409, r.body);
  ({ r } = await racing('cash_advances', 400, 'settled', () => call(APPROVER2, 'POST', '/api/cash-advances/400/revert', {})));
  assert.equal(r.status, 409, r.body);
});

test('an undisturbed action still goes through', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const r = await call(APPROVER2, 'POST', '/api/claims/200/approve', {});
  assert.equal(r.status, 200, r.body);
  assert.ok(state.writes.some(w => /^INSERT INTO claim_history/.test(w)), 'history recorded');
});

test('bulk mark-paid counts only the rows it actually moved', async (t) => {
  await serve(t);
  const items = [{ type: 'claim', id: 202 }, { type: 'claim', id: 203 }];
  // 203 is paid by someone else between the eligibility read and the commit.
  const { r } = await racing('claims', 203, 'paid', () => call(PAYER, 'POST', '/api/claims/mark-paid-bulk', { payment_date: '2026-10-01', items }));
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json, { paid: 1, skipped: 1 });
});

test('an account edit with a too-short password saves nothing', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const r = await call(ROOT, 'PUT', `/api/users/${CLAIMANT}`, { full_name: 'Renamed', password: 'short' });
  assert.equal(r.status, 400);
  assert.deepEqual(state.writes, []);
});

test('the reminder job refuses every call on a deployment without its secret', async (t) => {
  await serve(t);
  const saved = { VERCEL: process.env.VERCEL, CRON_SECRET: process.env.CRON_SECRET };
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.CRON_SECRET;
  process.env.VERCEL = '1';
  assert.equal((await call(null, 'GET', '/api/cron/reminders')).status, 401);
});

test('search text matches % and _ literally', () => {
  assert.equal(likeContains('50%_off'), '%50\\%\\_off%');
  assert.equal(likeContains('a\\b'), '%a\\\\b%');
  assert.equal(likeContains('RC-2026'), '%RC-2026%');
});

test('a receipt download streams and keeps its real file name', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('receipt-bytes', { headers: { 'content-length': '13' } }));
  const app = express();
  app.get('/r', (req, res, next) => sendReceipt(res, { blob_url: 'https://x', mime_type: 'application/pdf', original_name: "Kwitansi Maret (Ø's).pdf" }).catch(next));
  const s = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise(r => s.once('listening', r));
  t.after(() => s.close());
  const r = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${s.address().port}/r`, (res) => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ res, b }));
  }).on('error', reject));
  assert.equal(r.b, 'receipt-bytes');
  assert.equal(r.res.headers['content-type'], 'application/pdf');
  assert.equal(r.res.headers['content-disposition'],
    `inline; filename="Kwitansi Maret (_'s).pdf"; filename*=UTF-8''Kwitansi%20Maret%20%28%C3%98%27s%29.pdf`);
});
