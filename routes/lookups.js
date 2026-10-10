'use strict';

// Departments, job positions, expense types and regions (generic CRUD per
// lookup table).

const express = require('express');
const { q, qq, transaction } = require('../db');
const { seesAllRegions, resolveLookupRegion } = require('../lib/settings');
const { requireAuth, requireCap, requireRole } = require('../lib/auth');
const { userCan } = require('../lib/permissions');
const { OPEN_CLAIM_SQL, OPEN_ADVANCE_SQL } = require('../lib/workflow');
const { ah, iso, isActive } = require('../lib/util');

const router = express.Router();

// May this user edit a lookup row that belongs to `region`? Super admins / All
// -regions accounts may edit any; everyone else only their own region's rows.
function canEditLookupRegion(user, region) {
  if (seesAllRegions(user)) return true;
  return String(region || '') === String(user.region || '');
}

function lookupRoutes(pathName, table, flags = [], opts = {}) {
  // `opts.ranked` adds a `rank` column (a reorderable seniority ladder) — it is
  // selected, ordered by, and gets its own POST /reorder endpoint below.
  // `opts.regional` scopes the lookup to a region (see resolveLookupRegion).
  const ranked = !!opts.ranked;
  const regional = !!opts.regional;
  const orderBy = ranked ? 'rank, name' : 'name';
  const extraCols = [...(ranked ? ['rank'] : []), ...(regional ? ['region'] : [])];
  // List — any signed-in user may read (the claim form needs departments and
  // expense types). Non-admins receive only the active entries. Regional lookups
  // are filtered to the resolved region (a super admin with no ?region sees all).
  // `?manage=1` from a settings manager (the Settings tab) also returns disabled
  // entries — so they can be re-enabled — and, for lookups an account points at
  // (`opts.memberCol`), how many active accounts in the region use each one;
  // for expense types (`opts.usage`), how many claim and cash-advance lines in
  // the region carry each one, and the latest such line's date.
  router.get(`/api/${pathName}`, requireAuth, ah(async (req, res) => {
    const managing = req.query.manage === '1' && userCan(req.user, 'manage_settings');
    const onlyActive = req.user.role !== 'superadmin' && !managing;
    const cols = ['id', 'name', 'active', ...flags, ...extraCols, 'created_at'].join(', ');
    const region = regional ? await resolveLookupRegion(req.user, req.query.region) : null;
    if (regional && region === null) return res.status(400).json({ error: 'Invalid region' });
    const wheres = [];
    const params = [];
    if (onlyActive) wheres.push('active = TRUE');
    if (regional && region) { params.push(region); wheres.push(`region = $${params.length}`); }
    const whereSql = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const items = await q(`SELECT ${cols} FROM ${table} ${whereSql} ORDER BY ${orderBy}`, params);
    let members = null;
    if (managing && opts.memberCol && region) {
      const rows = await q(
        `SELECT lower(trim(${opts.memberCol})) AS k, COUNT(*)::int AS n FROM users WHERE active = TRUE AND region = $1 GROUP BY 1`, [region]);
      members = new Map(rows.map(r => [r.k, r.n]));
    }
    let usage = null;
    if (managing && opts.usage && region) {
      const rows = await q(
        `SELECT k, SUM(n)::int AS n, MAX(d) AS last FROM (
           SELECT lower(trim(l.expense_type)) AS k, COUNT(*) AS n, MAX(l.line_date) AS d
             FROM claim_lines l JOIN claims c ON c.id = l.claim_id WHERE c.region = $1 GROUP BY 1
           UNION ALL
           SELECT lower(trim(l.expense_type)), COUNT(*), MAX(l.line_date)
             FROM cash_advance_lines l JOIN cash_advances a ON a.id = l.advance_id WHERE a.region = $1 GROUP BY 1
         ) u GROUP BY k`, [region]);
      usage = new Map(rows.map(r => [r.k, { uses: r.n || 0, last_used: r.last || null }]));
    }
    const key = (i) => String(i.name).trim().toLowerCase();
    res.json({ items: items.map(i => ({ ...i, created_at: iso(i.created_at),
      ...(members ? { members: members.get(key(i)) || 0 } : {}),
      ...(usage ? (usage.get(key(i)) || { uses: 0, last_used: null }) : {}) })) });
  }));

  // Reorder one region's ladder: body { region, order: [id, …] } sets rank =
  // position + 1 for the listed ids, atomically. Only defined for ranked lookups.
  if (ranked) {
    router.post(`/api/${pathName}/reorder`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
      const order = (req.body && req.body.order) || [];
      if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order must be a non-empty array of ids' });
      const ids = [];
      for (const v of order) { const n = Number(v); if (Number.isInteger(n) && n > 0) ids.push(n); }
      if (!ids.length) return res.status(400).json({ error: 'order must contain valid ids' });
      if (regional) {
        const region = await resolveLookupRegion(req.user, (req.body || {}).region);
        if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
        // Scope every update to the region so a stray cross-region id is a no-op.
        await transaction(ids.map((id, i) => qq(`UPDATE ${table} SET rank = $1 WHERE id = $2 AND region = $3`, [i + 1, id, region])));
      } else {
        await transaction(ids.map((id, i) => qq(`UPDATE ${table} SET rank = $1 WHERE id = $2`, [i + 1, id])));
      }
      res.json({ ok: true });
    }));
  }

  router.post(`/api/${pathName}`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    let region = '';
    if (regional) {
      region = await resolveLookupRegion(req.user, (req.body || {}).region);
      if (region === null) return res.status(400).json({ error: 'Invalid region' });
      if (!region) return res.status(400).json({ error: 'Choose a region' });
    }
    const exists = await q(
      `SELECT 1 FROM ${table} WHERE lower(name) = lower($1)${regional ? ' AND region = $2' : ''}`,
      regional ? [name, region] : [name]);
    if (exists[0]) return res.status(409).json({ error: 'That name already exists' });
    let rows;
    if (regional && ranked) {
      // New ranked rows drop to the bottom of that region's ladder.
      rows = await q(
        `INSERT INTO ${table} (name, region, rank)
           VALUES ($1, $2, (SELECT COALESCE(MAX(rank), 0) + 1 FROM ${table} WHERE region = $2)) RETURNING id`,
        [name, region]);
    } else if (regional) {
      rows = await q(`INSERT INTO ${table} (name, region) VALUES ($1, $2) RETURNING id`, [name, region]);
    } else {
      rows = await q(`INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [name]);
    }
    res.status(201).json({ id: rows[0].id });
  }));

  router.put(`/api/${pathName}/:id`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
    const rows = await q(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (regional && !canEditLookupRegion(req.user, item.region)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    const { name, active } = req.body || {};
    const newName = name != null ? String(name).trim() : item.name;
    if (!newName) return res.status(400).json({ error: 'Name is required' });
    if (newName.toLowerCase() !== item.name.toLowerCase()) {
      const dupe = await q(
        `SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND id <> $2${regional ? ' AND region = $3' : ''}`,
        regional ? [newName, item.id, item.region] : [newName, item.id]);
      if (dupe[0]) return res.status(409).json({ error: 'That name already exists' });
    }
    // Build the SET clause dynamically so a caller can update just a flag.
    const sets = [];
    const params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    push('name', newName);
    push('active', active != null ? isActive(active) : item.active);
    for (const f of flags) {
      if (req.body && req.body[f] !== undefined) push(f, isActive(req.body[f]));
    }
    params.push(item.id);
    const updateSql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${params.length}`;
    // Accounts point at a department / position by name, and their claim rights
    // and rank are looked up by that name — so a rename carries the region's
    // accounts along with it, in the same transaction.
    if (opts.memberCol && newName !== item.name) {
      const [, moved] = await transaction([qq(updateSql, params), qq(
        `UPDATE users SET ${opts.memberCol} = $1 WHERE region = $2 AND lower(trim(${opts.memberCol})) = lower(trim($3)) RETURNING id`,
        [newName, item.region || '', item.name])]);
      return res.json({ ok: true, moved: (moved || []).length });
    }
    await q(updateSql, params);
    res.json({ ok: true });
  }));

  router.delete(`/api/${pathName}/:id`, requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
    if (regional) {
      const rows = await q(`SELECT region FROM ${table} WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      if (!canEditLookupRegion(req.user, rows[0].region)) {
        return res.status(403).json({ error: 'You do not have permission for this action' });
      }
    }
    const rows = await q(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));
}
// `allow_advance` is deliberately absent from both flag lists: cash advance is a
// per-account grant now (users.allow_advance), so these lookups neither return
// nor accept it — the columns are inert leftovers the migration backfill read.
lookupRoutes('departments', 'departments', ['allow_claim', 'allow_meal'], { regional: true, memberCol: 'department' });
lookupRoutes('positions', 'job_positions', ['allow_claim', 'allow_meal', 'can_manage'], { ranked: true, regional: true, memberCol: 'position' });
lookupRoutes('expense-types', 'expense_types', [], { regional: true, usage: true });
// Regions landing (super admin): per-region headcount and open workload, so the
// list shows what each region holds — and what a delete would orphan.
router.get('/api/regions/overview', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const [accounts, open] = await Promise.all([
    q(`SELECT region, COUNT(*)::int AS n FROM users WHERE active = TRUE GROUP BY region`),
    q(`SELECT region, SUM(n)::int AS n FROM (
         SELECT region, COUNT(*) AS n FROM claims WHERE ${OPEN_CLAIM_SQL} GROUP BY region
         UNION ALL SELECT region, COUNT(*) AS n FROM meal_claims WHERE ${OPEN_CLAIM_SQL} GROUP BY region
         UNION ALL SELECT region, COUNT(*) AS n FROM cash_advances WHERE ${OPEN_ADVANCE_SQL} GROUP BY region
       ) t GROUP BY region`)
  ]);
  const items = {};
  const at = (r) => (items[r] = items[r] || { accounts: 0, open: 0 });
  for (const r of accounts) at(r.region).accounts = r.n;
  for (const r of open) at(r.region).open = r.n;
  res.json({ items });
}));

lookupRoutes('regions', 'regions');

module.exports = router;
