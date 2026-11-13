'use strict';

// Accounts in Excel (Super Admin → Settings → Accounts → Excel):
//   GET  /api/users/export.xlsx?region=R[&template=1]  a market's accounts, or a blank template
//   POST /api/users/import?region=R&mode=preview|apply  the workbook as the raw body
// Preview and apply run the same plan (lib/accounts-import.js); apply refuses a
// file with any problem and writes everything in one transaction, so a file is
// either imported whole or not at all.

const express = require('express');
const bcrypt = require('bcryptjs');
const { q, qq, transaction } = require('../db');
const { requireAuth, requireRole, SET_PASSWORD_SQL } = require('../lib/auth');
const { ah, asIntArray } = require('../lib/util');
const { normRegion, ALL_REGIONS } = require('../lib/settings');
const { openClaimsAwaitingApprover } = require('../lib/workflow');
const { XLSX_MIME } = require('../lib/xlsx');
const { buildAccountsWorkbook, readAccountsWorkbook } = require('../lib/accounts-sheet');
const { planImport } = require('../lib/accounts-import');

const router = express.Router();

const USER_COLS = `id, username, full_name, email, role, department, position, region, bank_name, recipient_name,
  bank_account_no, approver_ids, approver1_options, can_mark_paid, allow_advance, approval_limit_cents, active,
  base_name, base_lat, base_lng, base_id, managed_by`;
async function loadUsers() {
  return (await q(`SELECT ${USER_COLS} FROM users ORDER BY id`)).map(u => ({
    ...u, approver_ids: asIntArray(u.approver_ids), approver1_options: asIntArray(u.approver1_options),
    managed_by: u.managed_by == null ? null : Number(u.managed_by), base_id: u.base_id == null ? null : Number(u.base_id)
  }));
}
// The lookups a region's accounts are checked against ('' / '*' = every region).
async function loadLists(region) {
  const one = region && region !== ALL_REGIONS;
  const where = one ? 'AND region = $1' : '';
  const p = one ? [region] : [];
  const [regions, departments, positions, bases] = await Promise.all([
    q('SELECT name FROM regions WHERE active = TRUE ORDER BY name'),
    q(`SELECT name, region FROM departments WHERE active = TRUE ${where} ORDER BY name`, p),
    q(`SELECT name, region, rank FROM job_positions WHERE active = TRUE ${where} ORDER BY rank, name`, p),
    q(`SELECT id, region, name, lat, lng FROM bases ${one ? 'WHERE region = $1' : ''} ORDER BY lower(name)`, p)
  ]);
  return { regions: regions.map(r => r.name), departments, positions, bases };
}
const uniq = (a) => [...new Set(a)];
const fileStamp = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s || 'all').replace(/[^\w-]+/g, '-').toLowerCase();

router.get('/api/users/export.xlsx', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const region = await normRegion(req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  const template = req.query.template === '1';
  const one = region && region !== ALL_REGIONS ? region : '';
  const [allUsers, lists] = await Promise.all([loadUsers(), loadLists(one)]);
  const users = template ? [] : allUsers
    .filter(u => !one || u.region === one)
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
  const buf = buildAccountsWorkbook({
    users, allUsers, region: one,
    lists: { regions: lists.regions, departments: uniq(lists.departments.map(d => d.name)),
      positions: uniq(lists.positions.map(p => p.name)), bases: lists.bases }
  });
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="accounts-${slug(one)}${template ? '-template' : ''}-${fileStamp()}.xlsx"`);
  res.send(buf);
}));

// '{"a","b"}' — a Postgres text[] literal.
const textArray = (list) => '{' + list.map(s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
// Approvers / manager by username, so accounts made earlier in the same
// transaction can be named.
const LINK_SQL = `UPDATE users SET
    approver_ids = COALESCE((SELECT array_agg(u.id ORDER BY o.ord) FROM unnest($1::text[]) WITH ORDINALITY o(name, ord) JOIN users u ON u.username = o.name), '{}'),
    approver1_options = COALESCE((SELECT array_agg(u.id ORDER BY o.ord) FROM unnest($2::text[]) WITH ORDINALITY o(name, ord) JOIN users u ON u.username = o.name), '{}'),
    managed_by = (SELECT id FROM users WHERE username = $3)
  WHERE username = $4`;

router.post('/api/users/import', requireAuth, requireRole('superadmin'),
  express.raw({ type: () => true, limit: '4mb' }), ah(async (req, res) => {
    const apply = req.query.mode === 'apply';
    const defaultRegion = await normRegion(req.query.region);
    if (defaultRegion === null) return res.status(400).json({ error: 'Invalid region' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose an Excel file to import' });
    const read = readAccountsWorkbook(req.body);
    if (read.error === 'unreadable') return res.status(400).json({ error: 'This file could not be read. Save it as an Excel workbook (.xlsx) and try again.' });
    if (read.error) return res.status(400).json({ error: 'No accounts table found — the sheet needs a "Username" column header.' });
    if (!read.rows.length) return res.status(400).json({ error: 'The file has no account rows' });

    const [users, lists] = await Promise.all([loadUsers(), loadLists('')]);
    const plan = planImport(read.rows, read.columns, {
      users, regions: lists.regions, departments: lists.departments, positions: lists.positions, bases: lists.bases,
      defaultRegion, actorId: req.user.id
    });
    // Disabling someone who is the next approver on open claims would strand them.
    for (const u of plan.updates.filter(x => x.deactivates)) {
      const n = await openClaimsAwaitingApprover(u.id);
      if (n > 0) plan.issues.push({ row: u.row, username: u.username, msg: 'This user is the current approver on {n} open claims. Resolve or reassign those before deactivating.', params: { n } });
    }
    if (plan.issues.length) plan.issues.sort((a, b) => a.row - b.row);
    const summary = {
      creates: plan.creates.map(c => ({ row: c.row, username: c.username, ...c.summary, generated: c.generated })),
      updates: plan.updates.map(u => ({ row: u.row, username: u.username, full_name: u.full_name, changes: u.changes })),
      unchanged: plan.unchanged.length,
      issues: plan.issues
    };
    if (!apply) return res.json(summary);
    if (plan.issues.length) return res.status(400).json({ error: 'Fix the rows with problems, then import again', ...summary });
    if (!plan.creates.length && !plan.updates.length) return res.json({ created: 0, updated: 0, credentials: [] });

    const by = req.user.full_name || req.user.username || '';
    const base = (f) => f.base ? [f.base.name, f.base.lat, f.base.lng, f.base.id] : ['', null, null, null];
    const queries = [];
    for (const c of plan.creates) {
      const f = c.fields;
      queries.push(qq(
        `INSERT INTO users (username, password_hash, full_name, role, department, position, region, email, bank_name,
           recipient_name, bank_account_no, can_mark_paid, allow_advance, approval_limit_cents, active,
           base_name, base_lat, base_lng, base_id, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [c.username, bcrypt.hashSync(c.password, 10), f.full_name, f.role, f.department, f.position, f.region, f.email,
         f.bank_name, f.recipient_name, f.bank_account_no, f.can_mark_paid, f.allow_advance, f.approval_limit,
         f.active, ...base(f), req.user.id, by]));
    }
    for (const u of plan.updates) {
      const f = u.fields;
      queries.push(qq(
        `UPDATE users SET full_name=$1, role=$2, department=$3, position=$4, region=$5, email=$6, bank_name=$7,
           recipient_name=$8, bank_account_no=$9, can_mark_paid=$10, allow_advance=$11, approval_limit_cents=$12,
           active=$13, base_name=$14, base_lat=$15, base_lng=$16, base_id=$17 WHERE id=$18`,
        [f.full_name, f.role, f.department, f.position, f.region, f.email, f.bank_name, f.recipient_name,
         f.bank_account_no, f.can_mark_paid, f.allow_advance, f.approval_limit, f.active, ...base(f), u.id]));
      if (u.password) queries.push(qq(SET_PASSWORD_SQL, [bcrypt.hashSync(u.password, 10), u.id]));
    }
    for (const x of [...plan.creates, ...plan.updates]) {
      queries.push(qq(LINK_SQL, [textArray(x.fields.approver_ids), textArray(x.fields.approver1_options), x.fields.managed_by || '', x.username]));
    }
    await transaction(queries);
    res.json({
      created: plan.creates.length, updated: plan.updates.length,
      credentials: plan.creates.filter(c => c.generated).map(c => ({ username: c.username, full_name: c.fields.full_name, password: c.password }))
    });
  }));

module.exports = router;
