'use strict';

// Settings → Customer sites (routes/customer-sites.js): everyone reads their
// region's pins, only settings managers change them, a region-scoped manager
// only in their own region. Through the real app over the in-memory stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

const CM = 2, CM_TH = 3, EMP = 10;
for (const u of [
  account({ id: CM, role: 'admin', position: 'Country Manager' }),
  account({ id: CM_TH, role: 'admin', region: 'Thailand', position: 'Country Manager' }),
  account({ id: EMP })
]) state.users.set(u.id, u);
state.settings.role_permissions_by_region = { Indonesia: { admin: { manage_settings: true } }, Thailand: { admin: { manage_settings: true } } };
state.tables.customer_sites.push({ id: 5, region: 'Indonesia', db_no: '500222', name: 'PT Sumber Selaras Abadi', address: '', lat: -6.1923, lng: 106.8352 });

test('an employee can read the sites but not change them', async (t) => {
  await serve(t);
  state.writes.length = 0;
  assert.equal((await call(EMP, 'GET', '/api/customer-sites')).status, 200);
  assert.equal((await call(EMP, 'POST', '/api/customer-sites', { db_no: 'DB1', coords: '-6.59, 106.80' })).status, 403);
  assert.equal((await call(EMP, 'PUT', '/api/customer-sites/5', { db_no: 'DB1', coords: '-6.59, 106.80' })).status, 403);
  assert.equal((await call(EMP, 'DELETE', '/api/customer-sites/5')).status, 403);
  assert.deepEqual(state.writes, []);
});

test('a manager in another region cannot touch this region’s site', async (t) => {
  await serve(t);
  state.writes.length = 0;
  assert.equal((await call(CM_TH, 'PUT', '/api/customer-sites/5', { db_no: 'DB500222', coords: '-6.1, 106.8' })).status, 403);
  assert.equal((await call(CM_TH, 'DELETE', '/api/customer-sites/5')).status, 403);
  assert.deepEqual(state.writes, []);
});

test('a site needs a DB number and a readable location', async (t) => {
  await serve(t);
  state.writes.length = 0;
  let r = await call(CM, 'POST', '/api/customer-sites', { db_no: 'DB', coords: '-6.59, 106.80' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /DB number/);
  r = await call(CM, 'POST', '/api/customer-sites', { db_no: 'DB500300', coords: 'near the mall' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /paste coordinates/);
  assert.deepEqual(state.writes, []);
});

test('a manager pins a site in their own region, DB number kept as digits', async (t) => {
  await serve(t);
  let params = null;
  state.onWrite = (sql, p) => { if (/^INSERT INTO customer_sites/.test(sql)) params = p; };
  t.after(() => { state.onWrite = null; });
  await call(CM, 'POST', '/api/customer-sites', { db_no: 'DB 500300', name: 'Bu Vivi', coords: 'https://www.google.com/maps/search/?api=1&query=-6.2302604,106.8040777' });
  assert.deepEqual(params, ['Indonesia', '500300', 'Bu Vivi', '', -6.2302604, 106.8040777]);
});
