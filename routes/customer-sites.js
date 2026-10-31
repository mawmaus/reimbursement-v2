'use strict';

// Customer sites (Settings → Customer sites): pinned customer locations by DB
// number. Everyone reads their region's list — the GPS meal form and the bases
// map use it to show how far a site is from a base before anyone goes there.
// Settings managers keep it, so do the people they name as editors and anyone
// ranked Manager or above. A GPS meal day is measured from the base to its
// customer's pin, so a customer with no DB number is pinned too (db_no '').

const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { ah, asIntArray } = require('../lib/util');
const { resolveLookupRegion, seesAllRegions, loadAppSettings, setAppSetting } = require('../lib/settings');
const { userCan, customerSiteEditors, mayEditCustomerSites, loadPositions } = require('../lib/permissions');
const { parseCoords } = require('../lib/meal-gps');

const router = express.Router();

const siteRow = (s) => ({ id: Number(s.id), region: s.region, db_no: s.db_no, name: s.name, alias: s.alias || '', address: s.address,
  lat: Number(s.lat), lng: Number(s.lng) });
// "DB 500222", "db500222" or "500222" → "500222"; '' when there are no digits.
const dbDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(0, 20);

function parseSiteInput(b) {
  const db_no = dbDigits(b.db_no);
  const name = String(b.name || '').trim().slice(0, 200), alias = String(b.alias || '').trim().slice(0, 200);
  if (!db_no && !name && !alias) return { error: 'Enter the DB number, or the customer’s name when they have none' };
  const ll = parseCoords(b.coords);
  if (!ll) return { error: 'Site location: paste coordinates like "-6.2088, 106.8456" or a Google Maps link' };
  return { site: { db_no, name, alias, address: String(b.address || '').trim().slice(0, 500), lat: ll.lat, lng: ll.lng } };
}
async function loadSiteOr404(req, res) {
  const s = (await q('SELECT * FROM customer_sites WHERE id = $1', [Number(req.params.id) || 0]))[0];
  if (!s) { res.status(404).json({ error: 'Customer site not found' }); return null; }
  if (!seesAllRegions(req.user) && s.region !== String(req.user.region || '')) {
    res.status(403).json({ error: 'You can only manage customer sites in your own region' }); return null;
  }
  return s;
}
const dupe = (e) => e && e.code === '23505';
// Settings managers, the people named in customer_site_editors, and managers.
const requireSiteEditor = ah(async (req, res, next) => {
  const [settings, pos] = await Promise.all([loadAppSettings(), loadPositions(req.user.region)]);
  if (mayEditCustomerSites(req.user, settings, pos)) return next();
  res.status(403).json({ error: 'You don’t have permission to edit customer sites' });
});

router.get('/api/customer-sites', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  let rows;
  try {
    rows = await q(`SELECT * FROM customer_sites ${region ? 'WHERE region = $1' : ''} ORDER BY db_no = '', db_no, lower(name)`, region ? [region] : []);
  } catch (e) {
    // Before the migration the table doesn't exist yet: no sites, not an error.
    if (e && e.code === '42P01') rows = []; else throw e;
  }
  const out = { region, sites: rows.map(siteRow) };
  // ?manage=1 from a settings manager: the region's active accounts and which
  // of them may edit the sites (the editors picker).
  if (req.query.manage === '1' && userCan(req.user, 'manage_settings') && region) {
    const editors = new Set(customerSiteEditors(await loadAppSettings()));
    const accounts = await q(
      `SELECT id, full_name, username, department, position FROM users WHERE region = $1 AND active = TRUE ORDER BY lower(full_name)`, [region]);
    out.accounts = accounts.map(a => ({ id: Number(a.id), name: a.full_name || a.username, department: a.department || '',
      position: a.position || '', editor: editors.has(Number(a.id)) }));
  }
  res.json(out);
}));

// Set who in a region may edit its customer sites. Only that region's accounts
// change; editors named for other regions stay as they are.
router.put('/api/customer-sites/editors', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  const ids = [...new Set(asIntArray(b.user_ids))];
  const inRegion = new Set((await q('SELECT id FROM users WHERE region = $1', [region])).map(r => Number(r.id)));
  if (ids.some(id => !inRegion.has(id))) return res.status(400).json({ error: `Only accounts in ${region} can edit its customer sites` });
  const current = customerSiteEditors(await loadAppSettings({ fresh: true }));
  const next = current.filter(id => !inRegion.has(id)).concat(ids);
  await setAppSetting('customer_site_editors', JSON.stringify(next));
  res.json({ ok: true, editors: ids.length });
}));

router.post('/api/customer-sites', requireAuth, requireSiteEditor, ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  const parsed = parseSiteInput(b);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const s = parsed.site;
  try {
    const rows = await q('INSERT INTO customer_sites (region, db_no, name, alias, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [region, s.db_no, s.name, s.alias, s.address, s.lat, s.lng]);
    res.status(201).json({ site: siteRow(rows[0]) });
  } catch (e) {
    if (dupe(e)) return res.status(409).json({ error: `DB${s.db_no} is already pinned in ${region} — edit that one instead` });
    throw e;
  }
}));

router.put('/api/customer-sites/:id', requireAuth, requireSiteEditor, ah(async (req, res) => {
  const site = await loadSiteOr404(req, res);
  if (!site) return;
  const parsed = parseSiteInput(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const s = parsed.site;
  try {
    const rows = await q('UPDATE customer_sites SET db_no = $1, name = $2, alias = $3, address = $4, lat = $5, lng = $6 WHERE id = $7 RETURNING *',
      [s.db_no, s.name, s.alias, s.address, s.lat, s.lng, site.id]);
    res.json({ site: siteRow(rows[0] || { ...site, ...s }) });
  } catch (e) {
    if (dupe(e)) return res.status(409).json({ error: `DB${s.db_no} is already pinned in ${site.region} — edit that one instead` });
    throw e;
  }
}));

router.delete('/api/customer-sites/:id', requireAuth, requireSiteEditor, ah(async (req, res) => {
  const site = await loadSiteOr404(req, res);
  if (!site) return;
  await q('DELETE FROM customer_sites WHERE id = $1', [site.id]);
  res.json({ ok: true });
}));

module.exports = router;
