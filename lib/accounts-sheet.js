'use strict';

// The accounts workbook (Settings → Accounts → Excel): the column layout, the
// export (a market's accounts, or a blank template) and reading an uploaded
// copy back into rows for lib/accounts-import.js.
//
// The file itself is English, like the PDF export, so this module's text is not
// part of the UI translations (scripts/check-i18n.js skips it). Columns are
// matched by header name on import, so reordering them or adding columns of
// your own is fine; only "Username" is needed to find the table.

const { buildWorkbook, readXlsx, colName } = require('./xlsx');

const ROLE_LABELS = {
  superadmin: 'Super Admin', vp: 'Vice President', admin: 'Country Manager / Managing Director',
  manager: 'Mid Management', lowmgmt: 'Low Management', finance: 'Finance', employee: 'Employee'
};
const ALL_REGIONS_LABEL = 'All regions';

// key → header. `list` names the Lists-sheet column that feeds its dropdown.
const COLUMNS = [
  { key: 'username',          header: 'Username',            width: 18, type: 'textfmt', required: true },
  { key: 'full_name',         header: 'Full name',           width: 26, required: true },
  { key: 'password',          header: 'Password',            width: 16, type: 'textfmt' },
  { key: 'email',             header: 'Email',               width: 28 },
  { key: 'role',              header: 'Role',                width: 22, list: 'role', required: true },
  { key: 'region',            header: 'Region',              width: 14, list: 'region', required: true },
  { key: 'department',        header: 'Department',          width: 20, list: 'department' },
  { key: 'position',          header: 'Job position',        width: 20, list: 'position' },
  { key: 'approver_ids',      header: 'Approval chain',      width: 28 },
  { key: 'approver1_options', header: 'Approver 1 choices',  width: 24 },
  { key: 'managed_by',        header: 'Managed by',          width: 18 },
  { key: 'approval_limit',    header: 'Approval limit',      width: 16, type: 'money' },
  { key: 'can_mark_paid',     header: 'Can mark paid',       width: 14, list: 'yesno' },
  { key: 'allow_advance',     header: 'Cash advance',        width: 14, list: 'yesno' },
  { key: 'bank_name',         header: 'Bank name',           width: 18 },
  { key: 'recipient_name',    header: 'Recipient name',      width: 22 },
  { key: 'bank_account_no',   header: 'Bank account no.',    width: 20, type: 'textfmt' },
  { key: 'base',              header: 'Base',                width: 22, list: 'base' },
  { key: 'active',            header: 'Active',              width: 10, list: 'yesno' }
];
const HEADER_OF = Object.fromEntries(COLUMNS.map(c => [c.key, c.header]));

const yesNo = (b) => (b ? 'Yes' : 'No');
// A base typed onto one account (not one of the region's bases) travels as
// "Name | lat, lng" so it survives a round trip.
const baseCell = (u, basesById) => {
  if (u.base_id != null && basesById.has(Number(u.base_id))) return basesById.get(Number(u.base_id)).name;
  if (u.base_lat != null && u.base_lng != null) return `${u.base_name || 'Base'} | ${u.base_lat}, ${u.base_lng}`;
  return '';
};

// The workbook: Accounts (one row per account, dropdowns on the list columns),
// Lists (what the dropdowns offer) and How to use.
//   users      — accounts to list (empty for a blank template)
//   allUsers   — every account, to turn approver / manager ids into usernames
//   lists      — { regions, departments, positions, bases } for the dropdowns
//   region     — the market this file is for ('' = every market)
function buildAccountsWorkbook({ users, allUsers, lists, region }) {
  const byId = new Map(allUsers.map(u => [Number(u.id), u]));
  const nameOf = (id) => (byId.get(Number(id)) || {}).username || '';
  const basesById = new Map(lists.bases.map(b => [Number(b.id), b]));
  const rows = users.map(u => COLUMNS.map(c => {
    switch (c.key) {
      case 'password': return '';
      case 'role': return ROLE_LABELS[u.role] || u.role;
      case 'region': return u.region === '*' ? ALL_REGIONS_LABEL : u.region;
      case 'approver_ids': case 'approver1_options': return (u[c.key] || []).map(nameOf).filter(Boolean).join(', ');
      case 'managed_by': return u.managed_by == null ? '' : nameOf(u.managed_by);
      case 'approval_limit': return u.approval_limit_cents == null ? '' : Number(u.approval_limit_cents) / 100;
      case 'can_mark_paid': case 'allow_advance': case 'active': return yesNo(u[c.key]);
      case 'base': return baseCell(u, basesById);
      default: return u[c.key] == null ? '' : u[c.key];
    }
  }));

  // Lists sheet: one column per dropdown.
  const listCols = [
    ['role', 'Roles', Object.values(ROLE_LABELS)],
    ['region', 'Regions', [...lists.regions, ALL_REGIONS_LABEL]],
    ['department', 'Departments', lists.departments],
    ['position', 'Job positions', lists.positions],
    ['base', 'Bases', lists.bases.map(b => b.name)],
    ['yesno', 'Yes / No', ['Yes', 'No']]
  ];
  const longest = Math.max(...listCols.map(l => l[2].length));
  const listRows = Array.from({ length: longest }, (_, i) => listCols.map(l => l[2][i] ?? ''));
  const validations = [];
  listCols.forEach(([key, , values], li) => {
    if (!values.length) return;
    const L = colName(li);
    COLUMNS.forEach((c, ci) => { if (c.list === key) validations.push({ col: ci, source: `Lists!$${L}$2:$${L}$${values.length + 1}` }); });
  });

  const market = region || 'every market';
  const help = [
    `Accounts for ${market}. Edit this sheet, save it, then use Import in Settings → Accounts.`,
    '',
    'ADDING ACCOUNTS',
    '• Add one row per new person. Username, Full name, Role and Region are required (Region can be left blank to use the market chosen when importing).',
    '• Password: leave it blank and the portal makes one; you can download the new sign-ins after the import. A password you type must be at least 8 characters.',
    '',
    'CHANGING EXISTING ACCOUNTS',
    '• A row whose Username already exists updates that account. Every column is taken as written, so a blank cell clears that field (Full name, Role and Region cannot be blank).',
    '• Leave Password blank to keep the current one; type a new one to reset it.',
    '• Rows you do not change are skipped. Deleting a row does not delete or disable the account — set Active to No for that.',
    '• Usernames cannot be renamed from the file — a changed username is read as a new account.',
    '',
    'COLUMNS',
    '• Role, Region, Department, Job position and Base have dropdowns (see the Lists sheet). Department, Job position and Base must exist in that region\'s Settings.',
    '• Approval chain: usernames of the approvers, in order, separated by commas — e.g. "budi, financeap". Approver 1 choices: usernames the person may pick their first approver from.',
    '• Managed by: one username. Approvers and managers may be people added in this same file, and must be in the same region (or All regions).',
    '• Approval limit: the largest claim this person may approve. Leave blank for unlimited.',
    '• Can mark paid, Cash advance, Active: Yes or No. Blank means No (Active: blank keeps it as is, or Yes for a new account).',
    '• Base: one of the region\'s bases, or "Name | latitude, longitude" for a location of this person\'s own.',
    '',
    'Nothing is saved until you confirm: the import first shows every new account and every change, and stops on any row with a problem.'
  ];

  return buildWorkbook({ sheets: [
    { name: 'Accounts', columns: COLUMNS.map(c => ({ header: c.header + (c.required ? ' *' : ''), width: c.width, type: c.type })), rows, validations },
    { name: 'Lists', columns: listCols.map(l => ({ header: l[1], width: 26 })), rows: listRows, filter: false },
    { name: 'How to use', columns: [{ header: 'How to use this file', width: 120, type: 'wrap' }], rows: help.map(h => [h]), filter: false }
  ] });
}

// Read an uploaded workbook into { rows: [{ row, values: { key: text } }] } or
// { error }. Takes the "Accounts" sheet (else the first sheet with a Username
// header) and finds the header row within its first 10 rows.
const normHead = (s) => String(s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const HEAD_KEYS = new Map(COLUMNS.map(c => [normHead(c.header), c.key]));
function readAccountsWorkbook(buf) {
  let sheets;
  try { sheets = readXlsx(buf); } catch { return { error: 'unreadable' }; }
  const ordered = [...sheets.filter(s => normHead(s.name) === 'accounts'), ...sheets.filter(s => normHead(s.name) !== 'accounts')];
  for (const sh of ordered) {
    const hi = sh.rows.slice(0, 10).findIndex(r => (r || []).some(c => HEAD_KEYS.get(normHead(c)) === 'username'));
    if (hi < 0) continue;
    const map = new Map(); // column index → key
    sh.rows[hi].forEach((c, i) => { const k = HEAD_KEYS.get(normHead(c)); if (k && ![...map.values()].includes(k)) map.set(i, k); });
    const rows = [];
    for (let r = hi + 1; r < sh.rows.length; r++) {
      const cells = sh.rows[r] || [];
      const values = {};
      for (const [i, k] of map) values[k] = String(cells[i] ?? '').trim();
      if (Object.values(values).every(v => v === '')) continue;
      rows.push({ row: r + 1, values });
    }
    return { rows, columns: [...map.values()] };
  }
  return { error: 'noheader' };
}

module.exports = { COLUMNS, HEADER_OF, ROLE_LABELS, ALL_REGIONS_LABEL, buildAccountsWorkbook, readAccountsWorkbook };
