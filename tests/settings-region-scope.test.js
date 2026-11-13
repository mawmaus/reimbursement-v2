'use strict';

// A region-locked admin (Country Manager / Managing Director with
// manage_settings) only ever reads and changes their own region's settings:
// naming another region in ?region / body.region is ignored, and another
// region's rows refuse by id. Through the real app (see _app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

const ADMIN = 40;
state.users.set(ADMIN, account({ id: ADMIN, role: 'admin', region: 'Indonesia', department: 'Management' }));
state.settings.role_permissions = { admin: { manage_settings: true, create_accounts: true } };
state.tables.departments.push({ id: 1, name: 'Ops', region: 'Thailand', active: true });
state.tables.job_positions.push({ id: 2, name: 'Lead', region: 'Thailand', rank: 5, active: true });
state.tables.expense_types.push({ id: 3, name: 'Fuel', region: 'Thailand', active: true });
state.tables.bases.push({ id: 4, name: 'Bangkok', region: 'Thailand', lat: 13.7, lng: 100.5 });
state.tables.customer_sites.push({ id: 5, db_no: '1', name: 'Shop', region: 'Thailand', lat: 13.7, lng: 100.5 });

const settingsOf = (key) => JSON.parse(state.settings[key] || '{}');

test('reads aimed at another region come back for the admin\'s own region', async (t) => {
  await serve(t);
  for (const path of ['/api/claim-window', '/api/region-prefs?manage=1', '/api/meal-rates?manage=1',
    '/api/meal-gps-settings', '/api/role-permissions', '/api/bases?manage=1', '/api/customer-sites?manage=1']) {
    const r = await call(ADMIN, 'GET', path + (path.includes('?') ? '&' : '?') + 'region=Thailand');
    assert.equal(r.status, 200, `${path}: ${r.body}`);
    if (r.json.region !== undefined) assert.equal(r.json.region, 'Indonesia', path);
  }
});

test('saves aimed at another region land in the admin\'s own region only', async (t) => {
  await serve(t);
  const saves = [
    ['/api/claim-window', { region: 'Thailand', max_age_days: 30, earliest_date: '' }, 'claim_window_by_region'],
    ['/api/meal-rates', { region: 'Thailand', rates: [10000] }, 'meal_rates_by_region'],
    ['/api/meal-gps-settings', { region: 'Thailand', enabled: true }, 'meal_gps_by_region'],
    ['/api/role-permissions', { region: 'Thailand', role: 'finance', cap: 'mark_paid', value: true }, 'role_permissions_by_region']
  ];
  for (const [path, body, key] of saves) {
    const r = await call(ADMIN, 'PUT', path, body);
    assert.ok(r.status < 500, `${path}: ${r.body}`);
    assert.equal(settingsOf(key).Thailand, undefined, `${path} must not write Thailand`);
  }
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

test('super-admin-only settings stay closed to the admin', async (t) => {
  await serve(t);
  for (const path of ['/api/regions/overview', '/api/survey/results', '/api/users/export.xlsx?region=Thailand']) {
    assert.equal((await call(ADMIN, 'GET', path)).status, 403, path);
  }
});
