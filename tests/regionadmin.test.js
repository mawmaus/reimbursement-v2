'use strict';

// Regional Admin (role 'regionadmin'): a Super Admin inside their own region.
// Every capability and Super Admin power (full account editor, approval
// override, account export), but region-locked for reading and acting: naming
// another region never shows it, and another region's documents and accounts
// refuse. Through the real app (see _app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');
const { readsAllRegions, seesAllRegions, actsAsSuper } = require('../lib/settings');
const R = require('../lib/permissions');

const RA = 70, CLAIMANT = 71, LOCAL = 72, CM = 73, PEER = 74, VP = 75;
state.regions = ['Indonesia', 'Thailand'];
state.users.set(RA, account({ id: RA, role: 'regionadmin', region: 'Indonesia', department: 'Management' }));
state.users.set(CLAIMANT, account({ id: CLAIMANT, region: 'Thailand' }));
state.users.set(LOCAL, account({ id: LOCAL, region: 'Indonesia', department: 'Sales', position: 'Staff' }));
state.users.set(CM, account({ id: CM, role: 'admin', region: 'Indonesia', department: 'Management' }));
state.users.set(PEER, account({ id: PEER, role: 'regionadmin', region: 'Indonesia' }));
state.users.set(VP, account({ id: VP, role: 'vp', region: '*' }));
// No role-matrix grants at all: a Regional Admin's powers don't depend on them.
state.settings.role_permissions = {};
const thai = { region: 'Thailand', employee_id: CLAIMANT, approver_ids: [RA], manager_id: RA };
state.tables.claims.push(doc({ id: 80, status: 'submitted', current_step: 1, ...thai }));
// An Indonesian claim on someone else's chain: a Regional Admin may override it.
state.tables.claims.push(doc({ id: 81, status: 'submitted', current_step: 1, region: 'Indonesia', employee_id: LOCAL, approver_ids: [CM, VP], manager_id: VP }));

test('a regional admin acts as a super admin but stays region-locked', () => {
  const u = { role: 'regionadmin', region: 'Indonesia' };
  assert.equal(actsAsSuper(u), true);
  assert.equal(readsAllRegions(u), false);
  assert.equal(seesAllRegions(u), false);
  assert.ok(Object.values(R.capsFor(u, {})).every(Boolean), 'holds every capability');
  assert.ok(R.ROLES.indexOf('regionadmin') < R.ROLES.indexOf('admin'), 'ranks above CM/MD');
  assert.deepEqual(R.creatableRolesFor(u), ['admin', 'manager', 'lowmgmt', 'finance', 'employee']);
});

test('they manage their own region\'s accounts, never peers or seniors', () => {
  const ra = { id: RA, role: 'regionadmin', region: 'Indonesia' };
  const P = new Map();
  assert.equal(R.canManageAccount(ra, { id: 1, role: 'admin', region: 'Indonesia' }, P), true);
  assert.equal(R.canManageAccount(ra, { id: 2, role: 'employee', region: 'Indonesia', position: '' }, P), true);
  assert.equal(R.canManageAccount(ra, { id: 3, role: 'employee', region: 'Thailand' }, P), false);
  assert.equal(R.canManageAccount(ra, { id: 4, role: 'regionadmin', region: 'Indonesia' }, P), false);
  assert.equal(R.canManageAccount(ra, { id: 5, role: 'vp', region: 'Indonesia' }, P), false);
  assert.equal(R.canManageAccount(ra, { id: 6, role: 'superadmin', region: 'Indonesia' }, P), false);
  const cm = { id: 9, role: 'admin', region: 'Indonesia', position: 'Director', caps: { manage_accounts: true } };
  assert.equal(R.canManageAccount(cm, { id: RA, role: 'regionadmin', region: 'Indonesia' }, P), false, 'a CM/MD cannot act on one');
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

test('the role matrix: every row below them, in their own region only', async (t) => {
  await serve(t);
  const m = await call(RA, 'GET', '/api/role-permissions');
  assert.deepEqual(m.json.editableRoles, ['admin', 'manager', 'lowmgmt', 'finance']);
  assert.equal((await call(RA, 'PUT', '/api/role-permissions', { region: 'Indonesia', role: 'regionadmin', cap: 'mark_paid', value: true })).status, 400);
  assert.equal((await call(RA, 'PUT', '/api/role-permissions', { region: 'Indonesia', role: 'vp', cap: 'mark_paid', value: true })).status, 400);
  assert.equal((await call(RA, 'PUT', '/api/role-permissions', { region: 'Thailand', role: 'finance', cap: 'mark_paid', value: true })).status, 403);
  assert.equal((await call(RA, 'PUT', '/api/role-permissions', { region: 'Indonesia', role: 'admin', cap: 'mark_paid', value: true })).status, 200);
  assert.equal((await call(RA, 'PUT', '/api/region-prefs', { region: 'Thailand', currency: 'THB', timezone: 'Asia/Bangkok' })).status, 403);
});

test('another region\'s claims stay hidden; lists and insights stay pinned', async (t) => {
  await serve(t);
  assert.equal((await call(RA, 'GET', '/api/claims/80')).status, 403);
  assert.equal((await call(RA, 'POST', '/api/claims/80/approve', {})).status, 403);
  state.reads.length = 0;
  await call(RA, 'GET', '/api/claims/summary?region=Thailand');
  assert.ok(state.reads.some(x => /FROM claims WHERE.*region = \$/.test(x)), 'still filtered to their region');
  const ins = await call(RA, 'GET', '/api/insights?region=Thailand');
  assert.equal(ins.status, 200, ins.body);
  assert.equal(ins.json.scope.region, 'Indonesia');
});

test('they override the approval chain on their own region\'s claims', async (t) => {
  await serve(t);
  const r = await call(RA, 'POST', '/api/claims/81/approve', {});
  assert.equal(r.status, 200, r.body);
  assert.ok(state.writes.some(w => /status\s*=\s*'approved'/.test(w)), 'the override finalises it');
});

test('the full account editor works in their region, and only there', async (t) => {
  await serve(t);
  state.reads.length = 0;
  const list = await call(RA, 'GET', '/api/users');
  assert.equal(list.status, 200, list.body);
  assert.ok(state.reads.some(x => /FROM users WHERE .*region = \$/.test(x)), 'the list is their region only');
  let r = await call(RA, 'PUT', `/api/users/${LOCAL}`, { full_name: 'Renamed', role: 'manager' });
  assert.equal(r.status, 200, r.body);
  // What the real editor form sends: every field, region blank (it has no Region field).
  r = await call(RA, 'PUT', `/api/users/${LOCAL}`, { username: 'local', full_name: 'Local', role: 'employee', email: '',
    department: 'Sales', position: 'Staff', bank_name: '', recipient_name: '', bank_account_no: '', approver_ids: [],
    can_mark_paid: false, allow_advance: false, approver1_options: [], managed_by: null, region: '',
    approval_unlimited: true, approval_limit: '' });
  assert.equal(r.status, 200, `the editor form's own payload saves: ${r.body}`);
  r = await call(RA, 'PUT', `/api/users/${CM}`, { full_name: 'CM' });
  assert.equal(r.status, 200, `a CM/MD is below them: ${r.body}`);
  for (const [id, body] of [[CLAIMANT, { full_name: 'X' }], [PEER, { full_name: 'X' }], [VP, { full_name: 'X' }],
    [LOCAL, { region: 'Thailand' }], [LOCAL, { role: 'regionadmin' }], [LOCAL, { role: 'vp' }], [RA, { role: 'superadmin' }]]) {
    r = await call(RA, 'PUT', `/api/users/${id}`, body);
    assert.equal(r.status, 403, `${id} ${JSON.stringify(body)}: ${r.status} ${r.body}`);
  }
  r = await call(RA, 'POST', '/api/users', { username: 'n1', password: 'password1', full_name: 'N', role: 'vp' });
  assert.equal(r.status, 403, r.body);
  assert.equal((await call(CM, 'PUT', `/api/users/${LOCAL}`, { full_name: 'X' })).status, 403, 'a CM/MD still has no full editor');
});

test('account Excel is open to them; global Super Admin tools stay closed', async (t) => {
  await serve(t);
  assert.equal((await call(RA, 'GET', '/api/users/export.xlsx?region=Thailand')).status, 200);
  for (const path of ['/api/regions/overview', '/api/survey/results']) {
    assert.equal((await call(RA, 'GET', path)).status, 403, path);
  }
  assert.equal((await call(RA, 'POST', '/api/test-email', {})).status, 403);
  assert.notEqual((await call(RA, 'POST', '/api/users/import', {})).status, 403, 'import is open to them (own region only)');
});

// A Regional Admin's account must name one region: "All regions" would make
// seesAllRegions treat them as unconfined, a Super Admin everywhere.
test('a regional admin is never all-region, and cannot be given All regions', async (t) => {
  assert.equal(seesAllRegions({ role: 'regionadmin', region: '*' }), false);
  assert.equal(readsAllRegions({ role: 'regionadmin', region: '*' }), false);
  assert.equal(seesAllRegions({ role: 'employee', region: '*' }), true, 'other All-regions accounts are unchanged');
  const SA = 76;
  state.users.set(SA, account({ id: SA, role: 'superadmin', region: '*' }));
  await serve(t);
  let r = await call(SA, 'POST', '/api/users', { username: 'ra2', password: 'password1', full_name: 'RA2', role: 'regionadmin', region: '*' });
  assert.equal(r.status, 400, r.body);
  r = await call(SA, 'PUT', `/api/users/${PEER}`, { region: '*' });
  assert.equal(r.status, 400, r.body);
  r = await call(SA, 'PUT', `/api/users/${VP}`, { role: 'regionadmin' });
  assert.equal(r.status, 400, `an All-regions VP cannot become a Regional Admin: ${r.body}`);
  r = await call(SA, 'POST', '/api/users', { username: 'ra3', password: 'password1', full_name: 'RA3', role: 'regionadmin', region: 'Thailand' });
  assert.notEqual(r.status, 400, `one real region is fine: ${r.body}`);
});
