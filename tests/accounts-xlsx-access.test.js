'use strict';

// Accounts in Excel (routes/accounts-xlsx.js) is Super Admin only — even an
// account allowed to create and manage accounts gets a 403 and writes nothing.
// Its own file: the harness must load before anything requires db.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

test('only a Super Admin may export or import accounts', async (t) => {
  for (const u of [account({ id: 1, role: 'superadmin', region: '*' }), account({ id: 2, role: 'admin', position: 'Country Manager' }), account({ id: 3 })]) state.users.set(u.id, u);
  state.settings.role_permissions_by_region = { Indonesia: { admin: { create_accounts: true, manage_accounts: true } } };
  await serve(t);
  state.writes.length = 0;
  for (const id of [2, 3]) {
    assert.equal((await call(id, 'GET', '/api/users/export.xlsx?region=Indonesia')).status, 403);
    assert.equal((await call(id, 'POST', '/api/users/import?mode=apply', 'x', { 'content-type': 'application/octet-stream' })).status, 403);
  }
  assert.deepEqual(state.writes, []);
});
