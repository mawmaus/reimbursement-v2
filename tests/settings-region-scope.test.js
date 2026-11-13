'use strict';

// A region-locked admin (Country Manager / Managing Director) may LOOK at every
// region — settings, claims, insights — but only changes or acts on their own.
// Saves naming another region are refused (not redirected to their own), and
// another region's rows and documents refuse by id. Through the real app (see
// _app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');

const ADMIN = 40, FIN = 41, CLAIMANT = 42;
state.users.set(ADMIN, account({ id: ADMIN, role: 'admin', region: 'Indonesia', department: 'Management', can_mark_paid: true }));
state.users.set(FIN, account({ id: FIN, role: 'finance', region: 'Indonesia', department: 'Finance' }));
state.users.set(CLAIMANT, account({ id: CLAIMANT, region: 'Thailand' }));
state.settings.role_permissions = {
  admin: { manage_settings: true, create_accounts: true, view_all_claims: true, mark_paid: true, delete_claims: true },
  finance: { view_all_claims: true }
};
state.tables.departments.push({ id: 1, name: 'Ops', region: 'Thailand', active: true });
state.tables.job_positions.push({ id: 2, name: 'Lead', region: 'Thailand', rank: 5, active: true });
state.tables.expense_types.push({ id: 3, name: 'Fuel', region: 'Thailand', active: true });
state.tables.bases.push({ id: 4, name: 'Bangkok', region: 'Thailand', lat: 13.7, lng: 100.5 });
state.tables.customer_sites.push({ id: 5, db_no: '1', name: 'Shop', region: 'Thailand', lat: 13.7, lng: 100.5 });
// A Thailand claim the admin is (improperly) listed on, so only the region rule stands in the way.
const thai = { region: 'Thailand', employee_id: CLAIMANT, approver_ids: [ADMIN], manager_id: ADMIN };
state.tables.claims.push(doc({ id: 60, status: 'submitted', current_step: 1, ...thai }), doc({ id: 61, status: 'approved', ...thai }));

const settingsOf = (key) => JSON.parse(state.settings[key] || '{}');
const READS = ['/api/region-prefs?manage=1', '/api/meal-rates?manage=1', '/api/meal-gps-settings',
  '/api/role-permissions', '/api/bases?manage=1', '/api/customer-sites?manage=1'];
const withRegion = (path, r) => path + (path.includes('?') ? '&' : '?') + 'region=' + r;

test('the admin may read another region\'s settings; with none named they get their own', async (t) => {
  await serve(t);
  for (const path of READS) {
    const other = await call(ADMIN, 'GET', withRegion(path, 'Thailand'));
    assert.equal(other.status, 200, `${path}: ${other.body}`);
    assert.equal(other.json.region, 'Thailand', path);
    const own = await call(ADMIN, 'GET', path);
    assert.equal(own.json.region, 'Indonesia', path);
  }
  assert.equal((await call(ADMIN, 'GET', '/api/claim-window?region=Thailand')).status, 200);
  assert.equal((await call(ADMIN, 'GET', '/api/departments?manage=1&region=Thailand')).status, 200);
  assert.ok(state.reads.some(x => /FROM departments WHERE region = \$1/.test(x)));
});

test('other region-locked accounts stay pinned to their own region', async (t) => {
  await serve(t);
  for (const path of ['/api/region-prefs', '/api/meal-rates', '/api/bases', '/api/customer-sites']) {
    const r = await call(FIN, 'GET', withRegion(path, 'Thailand'));
    assert.equal(r.json.region, 'Indonesia', path);
  }
});

test('saves naming another region are refused and write nothing', async (t) => {
  await serve(t);
  const before = state.writes.length;
  const saves = [
    ['PUT', '/api/claim-window', { region: 'Thailand', max_age_days: 30, earliest_date: '' }],
    ['PUT', '/api/region-prefs', { region: 'Thailand', currency: 'THB', timezone: 'Asia/Bangkok' }],
    ['PUT', '/api/meal-rates', { region: 'Thailand', rates: [10000] }],
    ['PUT', '/api/meal-gps-settings', { region: 'Thailand', enabled: true }],
    ['PUT', '/api/role-permissions', { region: 'Thailand', role: 'finance', cap: 'mark_paid', value: true }],
    ['POST', '/api/departments', { region: 'Thailand', name: 'New' }],
    ['POST', '/api/positions/reorder', { region: 'Thailand', order: [2] }],
    ['POST', '/api/bases', { region: 'Thailand', name: 'X', coords: '1,1' }],
    ['POST', '/api/customer-sites', { region: 'Thailand', db_no: '2', name: 'X', coords: '1,1' }],
    ['PUT', '/api/customer-sites/editors', { region: 'Thailand', user_ids: [] }]
  ];
  for (const [m, path, body] of saves) {
    const r = await call(ADMIN, m, path, body);
    assert.equal(r.status, 403, `${m} ${path}: ${r.status} ${r.body}`);
  }
  assert.equal(state.writes.length, before, 'nothing was written');
  for (const key of ['claim_window_by_region', 'meal_rates_by_region', 'meal_gps_by_region', 'role_permissions_by_region']) {
    assert.equal(settingsOf(key).Thailand, undefined, key);
  }
});

test('the admin still saves their own region', async (t) => {
  await serve(t);
  const r = await call(ADMIN, 'PUT', '/api/meal-gps-settings', { region: 'Indonesia', enabled: true });
  assert.equal(r.status, 200, r.body);
  assert.equal(settingsOf('meal_gps_by_region').Indonesia.enabled, true);
});

test('another region\'s lookup rows, bases and sites refuse by id', async (t) => {
  await serve(t);
  const before = state.writes.length;
  const attempts = [
    ['PUT', '/api/departments/1', { name: 'X' }], ['DELETE', '/api/departments/1'],
    ['PUT', '/api/positions/2', { name: 'X' }], ['DELETE', '/api/positions/2'],
    ['PUT', '/api/expense-types/3', { name: 'X' }], ['DELETE', '/api/expense-types/3'],
    ['PUT', '/api/bases/4', { name: 'X', coords: '1,1' }], ['DELETE', '/api/bases/4'],
    ['PUT', '/api/bases/4/accounts', { user_ids: [] }],
    ['PUT', '/api/customer-sites/5', { db_no: '1', name: 'X', coords: '1,1' }], ['DELETE', '/api/customer-sites/5']
  ];
  for (const [m, path, body] of attempts) {
    const r = await call(ADMIN, m, path, body);
    // The stand-in DB answers some deletes' region lookup as not found; either way it is refused.
    assert.ok(r.status === 403 || (m === 'DELETE' && r.status === 404), `${m} ${path}: ${r.status} ${r.body}`);
  }
  assert.equal(state.writes.length, before, 'nothing was written');
});

test('the admin opens another region\'s claim but cannot approve, pay or delete it', async (t) => {
  await serve(t);
  assert.equal((await call(ADMIN, 'GET', '/api/claims/60')).status, 200);
  assert.equal((await call(FIN, 'GET', '/api/claims/60')).status, 403, 'other region-locked accounts still cannot open it');
  const before = state.writes.length;
  for (const [m, path, body] of [['POST', '/api/claims/60/approve', {}], ['POST', '/api/claims/60/reject', { comment: 'x' }],
    ['POST', '/api/claims/61/mark-paid', { payment_date: '2026-11-01' }], ['DELETE', '/api/claims/60']]) {
    assert.equal((await call(ADMIN, m, path, body)).status, 403, `${m} ${path}`);
  }
  assert.equal(state.writes.length, before, 'nothing was written');
});

test('the admin\'s claim list and insights may span regions; others stay pinned', async (t) => {
  await serve(t);
  state.reads.length = 0;
  await call(ADMIN, 'GET', '/api/claims/summary');
  assert.ok(!state.reads.some(x => /FROM claims WHERE.*region = \$/.test(x)), 'no region filter for the admin by default');
  state.reads.length = 0;
  await call(ADMIN, 'GET', '/api/claims/summary?region=Thailand');
  assert.ok(state.reads.some(x => /FROM claims WHERE.*region = \$/.test(x)), 'the picker narrows to one region');
  state.reads.length = 0;
  await call(FIN, 'GET', '/api/claims/summary?region=Thailand');
  assert.ok(state.reads.some(x => /FROM claims WHERE.*region = \$/.test(x)), 'finance stays on its own region');
});

test('super-admin-only settings stay closed to the admin', async (t) => {
  await serve(t);
  for (const path of ['/api/regions/overview', '/api/survey/results', '/api/users/export.xlsx?region=Thailand']) {
    assert.equal((await call(ADMIN, 'GET', path)).status, 403, path);
  }
});
