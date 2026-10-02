'use strict';

// Who may do what: the per-region role matrix, account management by
// department + position rank, and Insights visibility.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./_rules');

const P = R.POSITIONS;
const { user } = R;

test('fillMatrix: a region inherits the global matrix and overrides key by key', () => {
  const global = R.fillMatrix({ finance: { mark_paid: true, export_csv: true } }, null);
  const region = R.fillMatrix({ finance: { export_csv: false } }, global);
  assert.equal(region.finance.mark_paid, true, 'inherited from global');
  assert.equal(region.finance.export_csv, false, 'overridden for the region');
  assert.equal(global.vp.export_csv, true, 'built-in default');
  assert.equal(global.employee.mark_paid, false, 'everything else starts off');
});

test('capsFor: super admins hold every capability; others get their role row', () => {
  const perms = R.fillMatrix({ finance: { mark_paid: true } }, null);
  const all = R.CAPABILITIES.map(c => c.key);
  const superCaps = R.capsFor(user({ role: 'superadmin' }), perms);
  assert.ok(all.every(k => superCaps[k] === true));
  const finance = R.capsFor(user({ role: 'finance' }), perms);
  assert.equal(finance.mark_paid, true);
  assert.equal(finance.delete_claims, false);
  assert.ok(all.every(k => R.capsFor(user({ role: 'employee' }), perms)[k] === false));
});

test('editableRolesFor: nobody edits their own row or anyone above it', () => {
  assert.deepEqual(R.editableRolesFor(user({ role: 'superadmin' })), ['vp', 'admin', 'manager', 'lowmgmt', 'finance']);
  assert.ok(!R.editableRolesFor(user({ role: 'vp' })).includes('vp'));
  assert.deepEqual(R.editableRolesFor(user({ role: 'admin' })), ['manager', 'lowmgmt', 'finance']);
  assert.deepEqual(R.editableRolesFor(user({ role: 'manager' })), []);
  assert.ok(!R.editableRolesFor(user({ role: 'superadmin' })).includes('employee'), 'the Employee baseline is locked');
});

test('creatablePositions: only positions ranked strictly below your own', () => {
  assert.deepEqual(R.creatablePositions(user({ position: 'Manager' }), P), ['Supervisor', 'Staff']);
  assert.deepEqual(R.creatablePositions(user({ position: 'Staff' }), P), [], 'no delegation flag');
  assert.deepEqual(R.creatablePositions(user({ position: 'Intern' }), P), [], 'position not on the ladder');
});

test('canManageAccount: same department, strictly lower rank, never a super admin or VP', () => {
  const mgr = user({ id: 2, position: 'Manager', department: 'Sales' });
  assert.equal(R.canManageAccount(mgr, user({ position: 'Staff', department: 'Sales' }), P), true);
  assert.equal(R.canManageAccount(mgr, user({ position: 'Staff', department: 'sales ' }), P), true, 'department match ignores case/spaces');
  assert.equal(R.canManageAccount(mgr, user({ position: 'Staff', department: 'Finance' }), P), false, 'other department');
  assert.equal(R.canManageAccount(mgr, user({ position: 'Manager', department: 'Sales' }), P), false, 'same rank');
  assert.equal(R.canManageAccount(mgr, user({ position: 'Director', department: 'Sales' }), P), false, 'more senior');
  assert.equal(R.canManageAccount(mgr, user({ position: 'Staff', region: 'Thailand' }), P), false, 'other region');
  assert.equal(R.canManageAccount(mgr, user({ role: 'vp', position: 'Staff' }), P), false);
  assert.equal(R.canManageAccount(mgr, user({ role: 'superadmin', position: 'Staff' }), P), false);
  assert.equal(R.canManageAccount(user({ position: 'Staff' }), user({ position: 'Staff' }), P), false, 'no delegation');
});

test('canManageAccount: Director and above reach across departments, not regions', () => {
  const director = user({ position: 'Director', department: 'Operations' }, { manage_accounts: true });
  assert.equal(R.canManageAccount(director, user({ position: 'Staff', department: 'Sales' }), P), true);
  assert.equal(R.canManageAccount(director, user({ position: 'Staff', department: 'Sales', region: 'Vietnam' }), P), false);
  const allRegions = user({ position: 'Director', region: '*' }, { manage_accounts: true });
  assert.equal(R.canManageAccount(allRegions, user({ position: 'Staff', region: 'Vietnam' }), P), true);
  assert.equal(R.canManageAccount(user({ role: 'superadmin' }), user({ role: 'vp' }), P), true);
});

test('Insights: who may open it, and who sees company-wide data', () => {
  const at = (position, extra) => user({ position, ...extra });
  assert.equal(R.insightsCanView(at('Staff'), P), false);
  assert.equal(R.insightsCanView(at('Supervisor'), P), true);
  assert.equal(R.insightsCanView(at('Staff', { department: 'Finance & Accounting' }), P), true, 'any Finance department');
  assert.equal(R.insightsSeeAll(at('Supervisor'), P), false, 'department-scoped below General Manager');
  assert.equal(R.insightsSeeAll(at('General Manager'), P), true);
  assert.equal(R.insightsSeeAll(user({ caps: { view_insights_all: true } }), P), true);
});

test('Rank thresholds fall back to the seeded ranks when a position is renamed away', () => {
  const noGm = R.ladder([['Chief', 1], ['Head', 4], ['Lead', 6]]);
  assert.equal(R.insightsSeeAll(user({ position: 'Head' }), noGm), true, 'rank 4 is above the GM fallback (5)');
  assert.equal(R.insightsSeeAll(user({ position: 'Lead' }), noGm), false);
  assert.equal(R.accountsSeeAllDepts(user({ position: 'Head' }), noGm), false, 'Director fallback is rank 3');
});
