'use strict';

// Customer sites (Settings → Customer sites): pinned customer locations by DB
// number. Everyone reads their region's list — the GPS meal form and the bases
// map use it to show how far a site is from a base before anyone goes there.
// Settings managers keep it. A preview only: a GPS day is still measured from
// where the claimant actually recorded their location.

const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { ah } = require('../lib/util');
const { resolveLookupRegion, seesAllRegions } = require('../lib/settings');
const { parseCoords } = require('../lib/meal-gps');

const router = express.Router();

const siteRow = (s) => ({ id: Number(s.id), region: s.region, db_no: s.db_no, name: s.name, address: s.address,
  lat: Number(s.lat), lng: Number(s.lng) });
// "DB 500222", "db500222" or "500222" → "500222"; '' when there are no digits.
const dbDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(0, 20);

function parseSiteInput(b) {
  const db_no = dbDigits(b.db_no);
  if (!db_no) return { error: 'Enter the DB number' };
  const ll = parseCoords(b.coords);
  if (!ll) return { error: 'Site location: paste coordinates like "-6.2088, 106.8456" or a Google Maps link' };
  return { site: { db_no, name: String(b.name || '').trim().slice(0, 200), address: String(b.address || '').trim().slice(0, 500), lat: ll.lat, lng: ll.lng } };
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

router.get('/api/customer-sites', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  let rows;
  try {
    rows = await q(`SELECT * FROM customer_sites ${region ? 'WHERE region = $1' : ''} ORDER BY db_no`, region ? [region] : []);
  } catch (e) {
    // Before the migration the table doesn't exist yet: no sites, not an error.
    if (e && e.code === '42P01') rows = []; else throw e;
  }
  res.json({ region, sites: rows.map(siteRow) });
}));

router.post('/api/customer-sites', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  const parsed = parseSiteInput(b);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const s = parsed.site;
  try {
    const rows = await q('INSERT INTO customer_sites (region, db_no, name, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [region, s.db_no, s.name, s.address, s.lat, s.lng]);
    res.status(201).json({ site: siteRow(rows[0]) });
  } catch (e) {
    if (dupe(e)) return res.status(409).json({ error: `DB${s.db_no} is already pinned in ${region} — edit that one instead` });
    throw e;
  }
}));

router.put('/api/customer-sites/:id', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const site = await loadSiteOr404(req, res);
  if (!site) return;
  const parsed = parseSiteInput(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const s = parsed.site;
  try {
    const rows = await q('UPDATE customer_sites SET db_no = $1, name = $2, address = $3, lat = $4, lng = $5 WHERE id = $6 RETURNING *',
      [s.db_no, s.name, s.address, s.lat, s.lng, site.id]);
    res.json({ site: siteRow(rows[0] || { ...site, ...s }) });
  } catch (e) {
    if (dupe(e)) return res.status(409).json({ error: `DB${s.db_no} is already pinned in ${site.region} — edit that one instead` });
    throw e;
  }
}));

router.delete('/api/customer-sites/:id', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const site = await loadSiteOr404(req, res);
  if (!site) return;
  await q('DELETE FROM customer_sites WHERE id = $1', [site.id]);
  res.json({ ok: true });
}));

module.exports = router;
