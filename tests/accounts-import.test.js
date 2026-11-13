'use strict';

// Accounts in Excel: the workbook round trip (export → read back) and the
// import plan — new accounts, changes, untouched rows and every problem.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost/test';
const { buildAccountsWorkbook, readAccountsWorkbook } = require('../lib/accounts-sheet');
const { planImport } = require('../lib/accounts-import');
const { buildWorkbook } = require('../lib/xlsx');

const users = [
  { id: 1, username: 'root', full_name: 'Root', role: 'superadmin', region: '*', email: 'root@x.co', active: true, approver_ids: [], approver1_options: [], managed_by: null, approval_limit_cents: null },
  { id: 2, username: 'budi', full_name: 'Budi', role: 'manager', region: 'Indonesia', department: 'Sales', position: 'Manager', email: 'budi@x.co', active: true, approver_ids: [], approver1_options: [], managed_by: null, approval_limit_cents: 500000000, bank_account_no: '0123456789012345678' },
  { id: 3, username: 'fin', full_name: 'Finance AP', role: 'finance', region: 'Indonesia', department: 'Finance', position: 'Staff', email: '', active: true, approver_ids: [], approver1_options: [], managed_by: null, approval_limit_cents: null },
  { id: 4, username: 'som', full_name: 'Somchai', role: 'employee', region: 'Thailand', department: 'Sales', position: 'Staff', email: '', active: true, approver_ids: [], approver1_options: [], managed_by: null, approval_limit_cents: null },
  { id: 5, username: 'ani', full_name: 'Ani', role: 'employee', region: 'Indonesia', department: 'Sales', position: 'Staff', email: 'ani@x.co', active: true, approver_ids: [2, 3], approver1_options: [], managed_by: 2, approval_limit_cents: null, base_id: 9, base_name: 'Jakarta', base_lat: -6.2, base_lng: 106.8 }
];
const ctx = {
  users, regions: ['Indonesia', 'Thailand'], actorId: 1, defaultRegion: 'Indonesia',
  departments: [{ name: 'Sales', region: 'Indonesia' }, { name: 'Finance', region: 'Indonesia' }, { name: 'Sales', region: 'Thailand' }],
  positions: [{ name: 'Manager', region: 'Indonesia' }, { name: 'Staff', region: 'Indonesia' }, { name: 'Staff', region: 'Thailand' }],
  bases: [{ id: 9, region: 'Indonesia', name: 'Jakarta', lat: -6.2, lng: 106.8 }]
};
const exportIndonesia = () => buildAccountsWorkbook({
  users: users.filter(u => u.region === 'Indonesia'), allUsers: users, region: 'Indonesia',
  lists: { regions: ctx.regions, departments: ['Sales', 'Finance'], positions: ['Manager', 'Staff'], bases: ctx.bases }
});
const plan = (rows, columns) => planImport(rows.map((values, i) => ({ row: i + 2, values })), columns || Object.keys(rows[0]), ctx);

test('an exported market re-imports with nothing to do', () => {
  const read = readAccountsWorkbook(exportIndonesia());
  assert.equal(read.rows.length, 3);
  const ani = read.rows.find(r => r.values.username === 'ani').values;
  assert.equal(ani.approver_ids, 'budi, fin');
  assert.equal(ani.managed_by, 'budi');
  assert.equal(ani.base, 'Jakarta');
  assert.equal(read.rows.find(r => r.values.username === 'budi').values.bank_account_no, '0123456789012345678', 'long digits stay text');
  const p = planImport(read.rows, read.columns, ctx);
  assert.deepEqual(p.issues, []);
  assert.equal(p.creates.length + p.updates.length, 0);
  assert.equal(p.unchanged.length, 3);
});

test('new rows become accounts; blank password is generated; approvers may be added in the same file', () => {
  const p = plan([
    { username: 'new1', full_name: 'New One', role: 'Employee', region: '', department: 'sales', position: 'Staff', approver_ids: 'new2, fin', managed_by: 'new2', can_mark_paid: '', allow_advance: 'Yes' },
    { username: 'new2', full_name: 'New Two', role: 'manager', region: 'Indonesia', department: 'Sales', position: 'Manager', approver_ids: '', managed_by: '', can_mark_paid: 'no', allow_advance: '', password: 'longenough' }
  ]);
  assert.deepEqual(p.issues, []);
  assert.equal(p.creates.length, 2);
  const [a, b] = p.creates;
  assert.equal(a.fields.region, 'Indonesia', 'blank region takes the import market');
  assert.equal(a.fields.department, 'Sales', 'matched case-insensitively to the list');
  assert.equal(a.fields.role, 'employee');
  assert.deepEqual(a.fields.approver_ids, ['new2', 'fin']);
  assert.equal(a.fields.allow_advance, true);
  assert.equal(a.fields.active, true, 'new accounts start active');
  assert.ok(a.generated && a.password.length >= 8);
  assert.equal(b.generated, false);
});

test('a changed row lists exactly its changes; a missing column keeps the current value', () => {
  const p = plan([{ username: 'ani', full_name: 'Ani S', role: 'Employee', region: 'Indonesia', department: 'Sales', position: 'Staff', approver_ids: 'fin', active: 'No' }]);
  assert.deepEqual(p.issues, []);
  const u = p.updates[0];
  assert.deepEqual(u.changes.map(c => c.key), ['full_name', 'approver_ids', 'active']);
  assert.equal(u.fields.managed_by, 'budi', 'no Managed by column → unchanged');
  assert.equal(u.fields.base.id, 9);
});

test('every problem is reported against its row', () => {
  const p = plan([
    { username: '', full_name: 'x', role: 'Employee' },
    { username: 'z1', full_name: '', role: 'Wizard', region: 'Mars', department: '', position: '', email: 'bad', approver_ids: '', managed_by: '', password: 'short', can_mark_paid: 'maybe' },
    { username: 'z2', full_name: 'Z', role: 'Employee', region: 'Indonesia', department: 'Nope', position: '', email: 'budi@x.co', approver_ids: 'som, ghost, z2', managed_by: '', password: '', can_mark_paid: '' },
    { username: 'z2', full_name: 'dupe', role: 'Employee' }
  ], ['username', 'full_name', 'role', 'region', 'department', 'position', 'email', 'approver_ids', 'managed_by', 'password', 'can_mark_paid']);
  const msgs = p.issues.map(i => `${i.row}:${i.msg}`);
  for (const m of [
    '2:Username is missing', '3:Full name is missing', '3:Unknown role "{value}" — pick one from the dropdown',
    '3:Unknown region "{value}"', '3:Email "{value}" is not a valid address', '3:Password must be at least 8 characters',
    '3:{column}: "{value}" should be Yes or No', '4:Department "{value}" is not in the {region} list',
    '4:Email {value} is already used by {username}', '4:{column}: {value} is in {other}, not {region}',
    '4:{column}: no account with username "{value}"', '4:{column}: an account cannot list itself',
    '5:This username is also on row {other}'
  ]) assert.ok(msgs.includes(m), m);
  assert.equal(p.creates.length, 0);
});

test('managed-by loops and self-lockout are refused', () => {
  const p = plan([
    { username: 'budi', full_name: 'Budi', role: 'manager', region: 'Indonesia', managed_by: 'ani' },
    { username: 'root', full_name: 'Root', role: 'Employee', region: 'All regions', active: 'No', password: 'abcdefgh' }
  ], ['username', 'full_name', 'role', 'region', 'managed_by', 'active', 'password']);
  const msgs = p.issues.map(i => i.msg);
  assert.ok(msgs.includes('Managed by: this would make a loop ({chain})'));
  assert.ok(msgs.includes('You cannot disable your own account'));
  assert.ok(msgs.includes('You cannot change your own role'));
  assert.ok(msgs.includes('You cannot reset your own password from a file — use your profile'));
});

test('headers are found by name, in any order, on a sheet of any name', () => {
  const buf = buildWorkbook({ sheets: [{ name: 'Mine', columns: [{ header: 'Role' }, { header: 'username *' }, { header: 'Full Name' }, { header: 'Notes' }],
    rows: [['Finance', 'xx', 'X X', 'ignored'], ['', '', '', '']] }] });
  const read = readAccountsWorkbook(buf);
  assert.deepEqual(read.rows, [{ row: 2, values: { role: 'Finance', username: 'xx', full_name: 'X X' } }]);
  assert.equal(readAccountsWorkbook(Buffer.from('not a zip')).error, 'unreadable');
});
