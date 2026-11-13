'use strict';

// Accounts import (Settings → Accounts → Excel → Import): turns the rows of an
// uploaded accounts workbook (lib/accounts-sheet.js) into a plan — accounts to
// create, accounts to change (with each change), rows left as they are, and
// every problem — by the same rules as the account form (routes/users.js).
//
// planImport is pure: the route loads everything it needs into `ctx` first,
// so the preview and the real import judge a file identically, and tests can
// drive it without a database. Problems are { row, username, msg, params }: an
// English template the client runs through t(msg, params).

const crypto = require('crypto');
const { EMAIL_RE, normEmail } = require('./util');
const { parseAmountToCents } = require('./money');
const { parseBaseInput } = require('./meal-gps');
const { ROLE_LABELS, HEADER_OF, ALL_REGIONS_LABEL } = require('./accounts-sheet');

const MAX_ROWS = 500;
const ci = (s) => String(s == null ? '' : s).trim().toLowerCase();
const cap = (s, n = 200) => String(s == null ? '' : s).trim().slice(0, n);
const splitNames = (v) => String(v || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
const YES = new Set(['yes', 'y', 'true', '1', 'ya', 'x', '✓']);
const NO = new Set(['no', 'n', 'false', '0', 'tidak', '-', '']);
const ROLE_BY = new Map([
  ...Object.keys(ROLE_LABELS).map(k => [k, k]),
  ...Object.entries(ROLE_LABELS).map(([k, l]) => [ci(l), k])
]);

// Readable password for a new account whose Password cell was left blank.
function generatePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += abc[b % abc.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

// The fields an account carries, in the order a change list shows them.
const FIELDS = ['full_name', 'email', 'role', 'region', 'department', 'position', 'approver_ids', 'approver1_options',
  'managed_by', 'approval_limit', 'can_mark_paid', 'allow_advance', 'bank_name', 'recipient_name', 'bank_account_no', 'base', 'active'];

// rows: [{ row, values: { key: text } }] (readAccountsWorkbook)
// columns: the keys the file has a column for — a missing column keeps the
//   current value on an existing account; a blank cell in a present column clears it.
// ctx: { users, regions, departments: [{ name, region }], positions: [...],
//   bases: [{ id, region, name, lat, lng }], defaultRegion, actorId }
function planImport(rows, columns, ctx) {
  const issues = [];
  const has = new Set(columns);
  const byUsername = new Map(ctx.users.map(u => [String(u.username), u]));
  const byId = new Map(ctx.users.map(u => [Number(u.id), u]));
  const nameOf = (id) => (byId.get(Number(id)) || {}).username || '';
  const regionsCi = new Map(ctx.regions.map(r => [ci(r), r]));

  if (rows.length > MAX_ROWS) {
    return { creates: [], updates: [], unchanged: [], issues: [{ row: 0, username: '', msg: 'The file has more than {n} accounts — split it into smaller files', params: { n: MAX_ROWS } }] };
  }

  const items = [];
  const seen = new Map();
  for (const { row, values: v } of rows) {
    const username = cap(v.username, 60);
    const bad = (msg, params = {}) => issues.push({ row, username, msg, params });
    if (!username) { bad('Username is missing'); continue; }
    if (seen.has(username)) { bad('This username is also on row {other}', { other: seen.get(username) }); continue; }
    seen.set(username, row);
    const cur = byUsername.get(username) || null;
    // A column the file doesn't have keeps the account's current value.
    const keep = (k) => cur && !has.has(k);
    const f = {};

    // Required text.
    f.full_name = keep('full_name') ? cur.full_name : cap(v.full_name);
    if (!f.full_name) bad('Full name is missing');

    // Role (code or its label).
    if (keep('role')) f.role = cur.role;
    else if (!v.role) bad('Role is missing');
    else if (!(f.role = ROLE_BY.get(ci(v.role)))) bad('Unknown role "{value}" — pick one from the dropdown', { value: v.role });

    // Region: blank takes the market chosen for the import.
    if (keep('region')) f.region = cur.region;
    else {
      const raw = String(v.region || '').trim() || ctx.defaultRegion || '';
      if (!raw) bad('Region is missing');
      else if (raw === '*' || ci(raw) === ci(ALL_REGIONS_LABEL)) f.region = '*';
      else if (!(f.region = regionsCi.get(ci(raw)))) bad('Unknown region "{value}"', { value: raw });
    }
    const region = f.region;

    // Department / job position: from the region's own lists (any region's for
    // an All-regions account). An unchanged legacy value is let through.
    const pick = (key, list, msg) => {
      if (keep(key)) return cur[key];
      const val = cap(v[key]);
      if (!val) return '';
      if (cur && ci(cur[key]) === ci(val)) return cur[key];
      const hit = list.find(x => ci(x.name) === ci(val) && (region === '*' || x.region === region));
      if (!hit) { bad(msg, { value: val, region: region === '*' ? ALL_REGIONS_LABEL : region || '—' }); return val; }
      return hit.name;
    };
    f.department = pick('department', ctx.departments, 'Department "{value}" is not in the {region} list');
    f.position = pick('position', ctx.positions, 'Job position "{value}" is not in the {region} list');

    // Email.
    f.email = keep('email') ? cur.email : normEmail(v.email);
    if (f.email && !EMAIL_RE.test(f.email)) bad('Email "{value}" is not a valid address', { value: f.email });

    // Approvers / manager as usernames; checked against the whole file below.
    f.approver_ids = keep('approver_ids') ? (cur.approver_ids || []).map(nameOf).filter(Boolean) : [...new Set(splitNames(v.approver_ids))];
    f.approver1_options = keep('approver1_options') ? (cur.approver1_options || []).map(nameOf).filter(Boolean) : [...new Set(splitNames(v.approver1_options))];
    f.managed_by = keep('managed_by') ? (cur.managed_by == null ? null : nameOf(cur.managed_by) || null) : (cap(v.managed_by, 60) || null);

    // Approval limit (cents; null = unlimited).
    if (keep('approval_limit')) f.approval_limit = cur.approval_limit_cents == null ? null : Number(cur.approval_limit_cents);
    else {
      const raw = String(v.approval_limit || '').trim();
      if (!raw || /^(unlimited|tak terbatas|-)$/i.test(raw)) f.approval_limit = null;
      else if ((f.approval_limit = parseAmountToCents(raw)) === null) bad('Approval limit "{value}" is not an amount', { value: raw });
    }

    // Yes / No columns. Active left blank keeps the account as it is (new: Yes).
    const yn = (key, blank) => {
      if (keep(key)) return !!cur[key];
      const raw = ci(v[key]);
      if (raw === '' && blank !== undefined) return blank;
      if (YES.has(raw)) return true;
      if (NO.has(raw)) return false;
      bad('{column}: "{value}" should be Yes or No', { column: HEADER_OF[key], value: v[key] });
      return false;
    };
    f.can_mark_paid = yn('can_mark_paid');
    f.allow_advance = yn('allow_advance');
    f.active = yn('active', cur ? !!cur.active : true);

    // Bank details. Excel shows a long number typed into a General cell as
    // 1.23457E+15 and keeps only 15 digits — that can't be repaired here.
    f.bank_name = keep('bank_name') ? cur.bank_name : cap(v.bank_name);
    f.recipient_name = keep('recipient_name') ? cur.recipient_name : cap(v.recipient_name);
    f.bank_account_no = keep('bank_account_no') ? cur.bank_account_no : cap(v.bank_account_no, 60);
    if (!keep('bank_account_no') && /^\d(\.\d+)?e\+?\d+$/i.test(f.bank_account_no)) {
      bad('Bank account no. "{value}" was turned into a number by Excel — format the column as Text and type it again', { value: f.bank_account_no });
    }

    // Base: one of the region's bases, or "Name | lat, lng" of its own.
    if (keep('base')) {
      f.base = cur.base_lat == null ? null : { id: cur.base_id == null ? null : Number(cur.base_id), name: cur.base_name, lat: Number(cur.base_lat), lng: Number(cur.base_lng) };
    } else {
      const raw = cap(v.base, 300);
      f.base = null;
      if (raw.includes('|')) {
        const [n, ...rest] = raw.split('|');
        const parsed = parseBaseInput(n, rest.join('|'));
        if (parsed.error) bad(parsed.error);
        else if (parsed.base) f.base = { id: null, ...parsed.base };
      } else if (raw) {
        const b = ctx.bases.find(x => x.region === region && ci(x.name) === ci(raw));
        if (b) f.base = { id: Number(b.id), name: b.name, lat: Number(b.lat), lng: Number(b.lng) };
        else bad('Base "{value}" is not one of the {region} bases', { value: raw, region: region === '*' ? ALL_REGIONS_LABEL : region || '—' });
      }
    }

    // Password: blank keeps it (existing) or makes one (new).
    let password = String(v.password || '');
    let generated = false;
    if (password && password.length < 8) bad('Password must be at least 8 characters');
    if (!cur && !password) { password = generatePassword(); generated = true; }

    if (cur && Number(cur.id) === Number(ctx.actorId)) {
      if (!f.active) bad('You cannot disable your own account');
      if (f.role && f.role !== cur.role) bad('You cannot change your own role');
      if (password) bad('You cannot reset your own password from a file — use your profile');
    }
    items.push({ row, username, cur, f, password: password || null, generated });
  }

  // --- across the file: approvers, managers, emails -------------------------
  const finalRegion = new Map(ctx.users.map(u => [String(u.username), u.region]));
  const finalManager = new Map(ctx.users.map(u => [String(u.username), u.managed_by == null ? null : nameOf(u.managed_by) || null]));
  for (const it of items) { finalRegion.set(it.username, it.f.region); finalManager.set(it.username, it.f.managed_by); }
  const emailOwner = new Map();
  for (const u of ctx.users) if (u.email) emailOwner.set(ci(u.email), String(u.username));
  for (const it of items) if (it.cur && it.cur.email && emailOwner.get(ci(it.cur.email)) === it.username) emailOwner.delete(ci(it.cur.email));
  for (const it of items) {
    const bad = (msg, params = {}) => issues.push({ row: it.row, username: it.username, msg, params });
    const region = it.f.region;
    const refCheck = (key, names) => {
      for (const n of names) {
        if (n === it.username) { bad('{column}: an account cannot list itself', { column: HEADER_OF[key] }); continue; }
        if (!finalRegion.has(n)) { bad('{column}: no account with username "{value}"', { column: HEADER_OF[key], value: n }); continue; }
        const r = finalRegion.get(n);
        if (region && region !== '*' && r !== '*' && r !== region) {
          bad('{column}: {value} is in {other}, not {region}', { column: HEADER_OF[key], value: n, other: r || '—', region });
        }
      }
    };
    refCheck('approver_ids', it.f.approver_ids);
    refCheck('approver1_options', it.f.approver1_options);
    if (it.f.managed_by) {
      refCheck('managed_by', [it.f.managed_by]);
      // Follow the chain upward; coming back here would be a loop.
      const chain = [it.username];
      let at = it.f.managed_by;
      while (at && chain.length <= finalManager.size + 1) {
        if (at === it.username) { bad('Managed by: this would make a loop ({chain})', { chain: [...chain, at].join(' → ') }); break; }
        if (chain.includes(at)) break;
        chain.push(at);
        at = finalManager.get(at);
      }
    }
    if (it.f.email) {
      const owner = emailOwner.get(ci(it.f.email));
      if (owner && owner !== it.username) bad('Email {value} is already used by {username}', { value: it.f.email, username: owner });
      else emailOwner.set(ci(it.f.email), it.username);
    }
  }

  // --- creates / changes / unchanged ------------------------------------------
  const display = (key, f) => {
    const val = f[key];
    if (key === 'approver_ids' || key === 'approver1_options') return val.join(', ');
    if (key === 'base') return val ? (val.id == null ? `${val.name} (${val.lat}, ${val.lng})` : val.name) : '';
    if (key === 'approval_limit') return val == null ? null : val / 100;
    return val == null ? '' : val;
  };
  const same = (key, a, b) => {
    if (key === 'base') return (!a && !b) || (!!a && !!b && a.id === b.id && a.name === b.name && a.lat === b.lat && a.lng === b.lng);
    if (key === 'approver_ids' || key === 'approver1_options') return a.join(',') === b.join(',');
    return (a == null ? '' : a) === (b == null ? '' : b);
  };
  const creates = [], updates = [], unchanged = [];
  const badRows = new Set(issues.map(i => i.row));
  for (const it of items) {
    if (badRows.has(it.row)) continue;
    if (!it.cur) {
      creates.push({ row: it.row, username: it.username, fields: it.f, password: it.password, generated: it.generated,
        summary: { full_name: it.f.full_name, role: it.f.role, region: it.f.region, department: it.f.department, position: it.f.position } });
      continue;
    }
    const was = {
      full_name: it.cur.full_name, email: it.cur.email || '', role: it.cur.role, region: it.cur.region,
      department: it.cur.department || '', position: it.cur.position || '',
      approver_ids: (it.cur.approver_ids || []).map(nameOf).filter(Boolean),
      approver1_options: (it.cur.approver1_options || []).map(nameOf).filter(Boolean),
      managed_by: it.cur.managed_by == null ? null : nameOf(it.cur.managed_by) || null,
      approval_limit: it.cur.approval_limit_cents == null ? null : Number(it.cur.approval_limit_cents),
      can_mark_paid: !!it.cur.can_mark_paid, allow_advance: !!it.cur.allow_advance,
      bank_name: it.cur.bank_name || '', recipient_name: it.cur.recipient_name || '', bank_account_no: it.cur.bank_account_no || '',
      base: it.cur.base_lat == null ? null : { id: it.cur.base_id == null ? null : Number(it.cur.base_id), name: it.cur.base_name, lat: Number(it.cur.base_lat), lng: Number(it.cur.base_lng) },
      active: !!it.cur.active
    };
    const changes = FIELDS.filter(k => !same(k, was[k], it.f[k])).map(k => ({ key: k, from: display(k, was), to: display(k, it.f) }));
    if (it.password) changes.push({ key: 'password', from: '', to: '' });
    if (!changes.length) { unchanged.push({ row: it.row, username: it.username }); continue; }
    updates.push({ row: it.row, username: it.username, id: Number(it.cur.id), fields: it.f, password: it.password,
      full_name: it.f.full_name, changes, deactivates: was.active && !it.f.active });
  }
  issues.sort((a, b) => a.row - b.row);
  return { creates, updates, unchanged, issues };
}

module.exports = { planImport, generatePassword, MAX_ROWS };
