'use strict';

// Region isolation for actions, end to end through the real app with an
// in-memory stand-in for the database (the real one is never touched). A
// region-scoped account that may pay and delete must not be able to act on
// another region's documents by id — and must still act on its own region's.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Keygrip = require('keygrip');

process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
process.env.SESSION_SECRET = 'region-access-test';

// --- the stand-in database ---------------------------------------------------
const users = new Map([
  // Region-scoped Finance with every money/delete right.
  [20, { id: 20, username: 'fin', full_name: 'Fina', role: 'finance', region: 'Indonesia', department: 'Finance', position: 'Staff', can_mark_paid: true, active: true, session_version: 0, approver_ids: [], approver1_options: [], language: 'en' }],
  [1, { id: 1, username: 'root', full_name: 'Root', role: 'superadmin', region: '*', department: '', position: '', active: true, session_version: 0, approver_ids: [], approver1_options: [], language: 'en' }]
]);
const doc = (id, region, status, extra = {}) => ({ id, region, status, employee_id: 20, approver_ids: [20], current_step: 1,
  manager_id: 20, amount_cents: 100000, total_cents: 100000, realized_total_cents: 100000, currency: 'IDR',
  claim_no: 'RC-2026-' + id, advance_no: 'CA-2026-' + id, claimant_name: 'X', created_at: new Date(), ...extra });
const tables = {
  claims: [doc(5, 'Thailand', 'approved'), doc(8, 'Thailand', 'paid'), doc(15, 'Indonesia', 'approved')],
  meal_claims: [doc(6, 'Thailand', 'approved')],
  cash_advances: [doc(7, 'Thailand', 'approved')]
};
const writes = [];
async function q(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  if (/^SELECT key, value FROM app_settings/.test(sql)) {
    return [{ key: 'role_permissions', value: JSON.stringify({ finance: { mark_paid: true, delete_claims: true } }) }];
  }
  if (/^SELECT .* FROM users WHERE id = \$1/.test(sql)) { const u = users.get(Number(params[0])); return u ? [{ ...u }] : []; }
  let m = sql.match(/^SELECT \* FROM (claims|meal_claims|cash_advances) WHERE id ?= ?\$1$/);
  if (m) return tables[m[1]].filter(r => r.id === Number(params[0])).map(r => ({ ...r }));
  m = sql.match(/^SELECT \* FROM (claims|meal_claims|cash_advances) WHERE id = ANY\(\$1::int\[\]\) AND status = \$2/);
  if (m) { const ids = String(params[0]).replace(/[{}]/g, '').split(',').map(Number); return tables[m[1]].filter(r => ids.includes(r.id) && r.status === params[1]).map(r => ({ ...r })); }
  if (/COUNT\(/i.test(sql)) return [{ n: 0 }];
  if (/^(INSERT|UPDATE|DELETE)/.test(sql)) { writes.push(sql.slice(0, 60)); return []; }
  return [];
}
const transaction = async (queries) => { for (const x of queries) await x; return queries.map(() => []); };
const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { q, qq: q, transaction, sql: null } };
const app = require('../app');

// A signed session cookie for a user (the cookie-session format).
const cookieFor = (userId) => {
  const value = Buffer.from(JSON.stringify({ userId, sv: 0 })).toString('base64');
  return `rsess=${value}; rsess.sig=${new Keygrip([process.env.SESSION_SECRET]).sign(`rsess=${value}`)}`;
};
function call(port, userId, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { cookie: cookieFor(userId), 'x-forwarded-proto': 'https', ...(data ? { 'content-type': 'application/json' } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function serve(t) {
  t.mock.method(console, 'error', () => {});
  const s = http.createServer(app).listen(0, '127.0.0.1'); t.after(() => s.close());
  await new Promise(r => s.once('listening', r));
  return s.address().port;
}

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
  const port = await serve(t);
  writes.length = 0;
  for (const [method, p, body] of ACTIONS) {
    const r = await call(port, 20, method, p, body);
    assert.equal(r.status, 403, `${method} ${p} -> ${r.status} ${r.body}`);
    assert.match(r.body, /another region/, `${method} ${p}`);
  }
  assert.deepEqual(writes, [], 'nothing was written');
});

test('bulk payment actions skip another region\'s documents', async (t) => {
  const port = await serve(t);
  writes.length = 0;
  const pay = await call(port, 20, 'POST', '/api/claims/mark-paid-bulk', { ...paid, items: [{ type: 'claim', id: 5 }, { type: 'meal', id: 6 }] });
  assert.equal(pay.status, 200);
  assert.deepEqual(JSON.parse(pay.body), { paid: 0, skipped: 2 });
  const unpay = await call(port, 20, 'POST', '/api/claims/revert-paid-bulk', { items: [{ type: 'claim', id: 8 }] });
  assert.equal(unpay.status, 200);
  assert.match(unpay.body, /"skipped":1/);
  assert.deepEqual(writes, [], 'nothing was written');
});

test('the same account still acts on its own region; super admins act everywhere', async (t) => {
  const port = await serve(t);
  writes.length = 0;
  const own = await call(port, 20, 'POST', '/api/claims/15/mark-paid', paid);
  assert.equal(own.status, 200, own.body);
  assert.ok(writes.some(w => /^UPDATE claims SET status='paid'/.test(w)), 'its own region\'s claim was paid');

  for (const [method, p, body] of ACTIONS) {
    const r = await call(port, 1, method, p, body);
    assert.doesNotMatch(r.body, /another region/, `super admin: ${method} ${p}`);
  }
  const bulk = await call(port, 1, 'POST', '/api/claims/mark-paid-bulk', { ...paid, items: [{ type: 'claim', id: 5 }] });
  assert.deepEqual(JSON.parse(bulk.body), { paid: 1, skipped: 0 });
});
