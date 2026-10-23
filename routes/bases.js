'use strict';

// Bases (Settings → Bases): the places a region's accounts work from, measured
// against by the GPS meal allowance. A settings manager keeps the list and
// assigns accounts to each base; the account editor picks from it.

const express = require('express');
const { q, qq, transaction } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { ah, asIntArray, intArrayLiteral } = require('../lib/util');
const { userCan } = require('../lib/permissions');
const { resolveLookupRegion, seesAllRegions } = require('../lib/settings');
const { parseBaseInput } = require('../lib/meal-gps');

const router = express.Router();

const baseRow = (b) => ({ id: Number(b.id), region: b.region, name: b.name, lat: Number(b.lat), lng: Number(b.lng) });
async function loadBaseOr404(req, res) {
  const b = (await q('SELECT * FROM bases WHERE id = $1', [Number(req.params.id) || 0]))[0];
  if (!b) { res.status(404).json({ error: 'Base not found' }); return null; }
  if (!seesAllRegions(req.user) && b.region !== String(req.user.region || '')) {
    res.status(403).json({ error: 'You can only manage bases in your own region' }); return null;
  }
  return b;
}
// The unique (region, name) index answers a duplicate name.
const dupeName = (e) => e && e.code === '23505';

// List a region's bases. `?manage=1` from a settings manager also returns how
// many active accounts sit on each, and the region's active accounts with
// their base (for the assign screen).
router.get('/api/bases', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  const rows = await q(`SELECT * FROM bases ${region ? 'WHERE region = $1' : ''} ORDER BY lower(name)`, region ? [region] : []);
  const out = { region, bases: rows.map(baseRow) };
  if (req.query.manage === '1' && userCan(req.user, 'manage_settings') && region) {
    const accounts = await q(
      `SELECT id, full_name, username, department, position, base_id, base_name, base_lat
         FROM users WHERE region = $1 AND active = TRUE ORDER BY lower(full_name)`, [region]);
    const count = new Map();
    for (const a of accounts) if (a.base_id != null) count.set(Number(a.base_id), (count.get(Number(a.base_id)) || 0) + 1);
    out.bases = out.bases.map(b => ({ ...b, members: count.get(b.id) || 0 }));
    out.accounts = accounts.map(a => ({
      id: Number(a.id), name: a.full_name || a.username, department: a.department || '', position: a.position || '',
      base_id: a.base_id == null ? null : Number(a.base_id),
      // A base typed onto the account by hand, not one from this list.
      custom_base: a.base_id == null && a.base_lat != null ? (a.base_name || '') : null
    }));
  }
  res.json(out);
}));

router.post('/api/bases', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  const parsed = parseBaseInput(b.name, b.coords);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!parsed.base) return res.status(400).json({ error: 'Give the base a name and its location' });
  try {
    const rows = await q('INSERT INTO bases (region, name, lat, lng) VALUES ($1,$2,$3,$4) RETURNING *',
      [region, parsed.base.name, parsed.base.lat, parsed.base.lng]);
    res.status(201).json({ base: baseRow(rows[0]) });
  } catch (e) {
    if (dupeName(e)) return res.status(409).json({ error: `${region} already has a base called "${parsed.base.name}"` });
    throw e;
  }
}));

// Rename or move a base. Every account on it follows (their copied base fields
// are rewritten in the same transaction).
router.put('/api/bases/:id', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const base = await loadBaseOr404(req, res);
  if (!base) return;
  const b = req.body || {};
  const parsed = parseBaseInput(b.name, b.coords);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!parsed.base) return res.status(400).json({ error: 'Give the base a name and its location' });
  const { name, lat, lng } = parsed.base;
  try {
    await transaction([
      qq('UPDATE bases SET name = $1, lat = $2, lng = $3 WHERE id = $4', [name, lat, lng, base.id]),
      qq('UPDATE users SET base_name = $1, base_lat = $2, base_lng = $3 WHERE base_id = $4', [name, lat, lng, base.id])
    ]);
  } catch (e) {
    if (dupeName(e)) return res.status(409).json({ error: `${base.region} already has a base called "${name}"` });
    throw e;
  }
  res.json({ base: { ...baseRow(base), name, lat, lng } });
}));

// Delete a base no account is on any more (accounts keep a claimable base
// otherwise; move them first).
router.delete('/api/bases/:id', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const base = await loadBaseOr404(req, res);
  if (!base) return;
  const used = (await q('SELECT COUNT(*)::int AS n FROM users WHERE base_id = $1', [base.id]))[0].n;
  if (used) return res.status(409).json({ error: `${used} account${used === 1 ? ' is' : 's are'} still on ${base.name} — move ${used === 1 ? 'it' : 'them'} to another base first` });
  await q('DELETE FROM bases WHERE id = $1', [base.id]);
  res.json({ ok: true });
}));

// Set exactly which of the region's accounts are on this base: `user_ids` join
// it (leaving whatever base they had), anyone on it not listed leaves it.
router.put('/api/bases/:id/accounts', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const base = await loadBaseOr404(req, res);
  if (!base) return;
  const ids = [...new Set(asIntArray((req.body || {}).user_ids))];
  if (ids.length) {
    const found = await q('SELECT id FROM users WHERE id = ANY($1::int[]) AND region = $2', [intArrayLiteral(ids), base.region]);
    if (found.length !== ids.length) return res.status(400).json({ error: `Only accounts in ${base.region} can be put on this base` });
  }
  const list = intArrayLiteral(ids);
  await transaction([
    qq(`UPDATE users SET base_id = NULL, base_name = '', base_lat = NULL, base_lng = NULL
         WHERE base_id = $1 AND NOT (id = ANY($2::int[]))`, [base.id, list]),
    qq(`UPDATE users SET base_id = $1, base_name = $2, base_lat = $3, base_lng = $4 WHERE id = ANY($5::int[])`,
      [base.id, base.name, base.lat, base.lng, list])
  ]);
  res.json({ ok: true, members: ids.length });
}));

module.exports = router;
