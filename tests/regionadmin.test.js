'use strict';

// Regional Admin (role 'regionadmin'): the Country Manager / MD's powers, but
// locked to their own region for reading too — claims, insights and settings.
// Unlike a CM/MD ('admin'), naming another region never shows it. Through the
// real app (see _app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');
const { readsAllRegions, seesAllRegions } = require('../lib/settings');
const R = require('../lib/permissions');

const RA = 70, CLAIMANT = 71;
state.regions = ['Indonesia', 'Thailand'];
state.users.set(RA, account({ id: RA, role: 'regionadmin', region: 'Indonesia', department: 'Management', can_mark_paid: true }));
state.users.set(CLAIMANT, account({ id: CLAIMANT, region: 'Thailand' }));
state.settings.role_permissions = {
  regionadmin: { manage_settings: true, view_all_claims: true, mark_paid: true, delete_claims: true, view_insights_all: true }
};
const thai = { region: 'Thailand', employee_id: CLAIMANT, approver_ids: [RA], manager_id: RA };
state.tables.claims.push(doc({ id: 80, status: 'submitted', current_step: 1, ...thai }));

test('a regional admin is region-locked for reading and acting', () => {
  const u = { role: 'regionadmin', region: 'Indonesia' };
  assert.equal(readsAllRegions(u), false);
  assert.equal(seesAllRegions(u), false);
  assert.ok(R.ROLES.indexOf('regionadmin') > R.ROLES.indexOf('admin'), 'ranks below CM/MD');
  assert.ok(!R.creatableRolesFor(u).includes('admin'), 'cannot mint a CM/MD');
});

test('settings reads naming another region return their own', async (t) => {
  await serve(t);
  for (const path of ['/api/region-prefs?manage=1', '/api/meal-rates?manage=1', '/api/role-permissions',
    '/api/bases?manage=1', '/api/customer-sites?manage=1']) {
    const r = await call(RA, 'GET', path + (path.includes('?') ? '&' : '?') + 'region=Thailand');
    assert.equal(r.status, 200, `${path}: ${r.body}`);
    assert.equal(r.json.region, 'Indonesia', path);
  }
});

test('the regional admin edits only the rows below their own in their own region', async (t) => {
  await serve(t);
  const m = await call(RA, 'GET', '/api/role-permissions');
  assert.deepEqual(m.json.editableRoles, ['manager', 'lowmgmt', 'finance']);
  assert.equal((await call(RA, 'PUT', '/api/role-permissions', { region: 'Indonesia', role: 'regionadmin', cap: 'mark_paid', value: true })).status, 400);
  assert.equal((await call(RA, 'PUT', '/api/role-permissions', { region: 'Thailand', role: 'finance', cap: 'mark_paid', value: true })).status, 403);
  assert.equal((await call(RA, 'PUT', '/api/role-permissions', { region: 'Indonesia', role: 'finance', cap: 'mark_paid', value: true })).status, 200);
  assert.equal((await call(RA, 'PUT', '/api/region-prefs', { region: 'Thailand', currency: 'THB', timezone: 'Asia/Bangkok' })).status, 403);
});

test('another region\'s claims stay hidden, and lists and insights stay pinned', async (t) => {
  await serve(t);
  assert.equal((await call(RA, 'GET', '/api/claims/80')).status, 403);
  state.reads.length = 0;
  await call(RA, 'GET', '/api/claims/summary');
  assert.ok(state.reads.some(x => /FROM claims WHERE.*region = \$/.test(x)), 'own-region filter by default');
  state.reads.length = 0;
  await call(RA, 'GET', '/api/claims/summary?region=Thailand');
  assert.ok(state.reads.some(x => /FROM claims WHERE.*region = \$/.test(x)), 'still filtered');
  const ins = await call(RA, 'GET', '/api/insights?region=Thailand');
  assert.equal(ins.status, 200, ins.body);
  assert.equal(ins.json.scope.region, 'Indonesia', 'even company-wide insights stay in their region');
});

test('super-admin-only settings stay closed', async (t) => {
  await serve(t);
  for (const path of ['/api/regions/overview', '/api/survey/results', '/api/users/export.xlsx']) {
    assert.equal((await call(RA, 'GET', path)).status, 403, path);
  }
});
