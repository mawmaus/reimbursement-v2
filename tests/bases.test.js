'use strict';

// Settings → Bases (routes/bases.js): only settings managers change them, a
// region-scoped manager only in their own region, and accounts only join a
// base in that base's region. Through the real app over the in-memory stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

const ROOT = 1, CM = 2, CM_TH = 3, EMP = 10, EMP_TH = 11;
for (const u of [
  account({ id: ROOT, role: 'superadmin', region: '*' }),
  account({ id: CM, role: 'admin', position: 'Country Manager' }),
  account({ id: CM_TH, role: 'admin', region: 'Thailand', position: 'Country Manager' }),
  account({ id: EMP }),
  account({ id: EMP_TH, region: 'Thailand' })
]) state.users.set(u.id, u);
state.settings.role_permissions_by_region = { Indonesia: { admin: { manage_settings: true } }, Thailand: { admin: { manage_settings: true } } };
state.tables.bases.push({ id: 7, region: 'Indonesia', name: 'Jakarta office', lat: -6.1754, lng: 106.8272 });

test('an employee cannot add, edit or fill a base', async (t) => {
  await serve(t);
  state.writes.length = 0;
  assert.equal((await call(EMP, 'POST', '/api/bases', { name: 'Bogor', coords: '-6.59, 106.80' })).status, 403);
  assert.equal((await call(EMP, 'PUT', '/api/bases/7', { name: 'X', coords: '-6.1, 106.8' })).status, 403);
  assert.equal((await call(EMP, 'PUT', '/api/bases/7/accounts', { user_ids: [EMP] })).status, 403);
  assert.deepEqual(state.writes, []);
});

test('a manager in another region cannot touch this region’s base', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const r = await call(CM_TH, 'PUT', '/api/bases/7', { name: 'Jakarta HQ', coords: '-6.1, 106.8' });
  assert.equal(r.status, 403);
  assert.equal((await call(CM_TH, 'DELETE', '/api/bases/7')).status, 403);
  assert.deepEqual(state.writes, []);
});

test('a base must have a readable location', async (t) => {
  await serve(t);
  const r = await call(CM, 'POST', '/api/bases', { name: 'Bogor', coords: 'somewhere south' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /paste coordinates/);
});

test('only accounts in the base’s region can join it', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const r = await call(CM, 'PUT', '/api/bases/7/accounts', { user_ids: [EMP_TH] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Only accounts in Indonesia/);
  assert.deepEqual(state.writes, []);
});
