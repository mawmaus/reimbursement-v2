'use strict';

// Customer sites (Settings → Customer sites): pinned customer locations by DB
// number. Everyone reads their region's list — the GPS meal form and the bases
// map use it to show how far a site is from a base before anyone goes there.
// Settings managers keep it, so do the people they name as editors and anyone
// ranked Manager or above. A GPS meal day is measured from the base to its
// customer's pin, so a customer with no DB number is pinned too (db_no '').
//
// A claimant may register a site that isn't listed yet, picking its spot on a
// map (POST /api/customer-sites/register). It is usable on their claim at once
// but stays 'pending' until a site editor — or the approver of a claim that
// names it — verifies it or moves the pin; such a claim can't be approved
// until then (routes/meals.js). Moving a pin re-measures the open claims on it.

const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { ah, asIntArray } = require('../lib/util');
const { resolveLookupRegion, seesAllRegions, loadAppSettings, setAppSetting, resolveSettingsReadRegion, namesOtherRegion, OTHER_REGION_ERROR } = require('../lib/settings');
const { userCan, customerSiteEditors, mayEditCustomerSites, loadPositions } = require('../lib/permissions');
const { parseCoords, mayRaiseGps, distanceMeters } = require('../lib/meal-gps');
const { computePurposes, userCanApprove } = require('../lib/workflow');
const { logMealHistory } = require('../lib/documents');

const router = express.Router();

const siteRow = (s) => ({ id: Number(s.id), region: s.region, db_no: s.db_no, name: s.name, alias: s.alias || '', address: s.address,
  lat: Number(s.lat), lng: Number(s.lng), status: s.status || 'verified', proposed_by: s.proposed_by == null ? null : Number(s.proposed_by),
  proposed_by_name: s.proposed_by_name || '', verified_by_name: s.verified_by_name || '' });
const MAX_PENDING_PER_USER = 30;
const NOT_MIGRATED = 'Registering customer sites isn’t available yet — ask your administrator to update the database';
const notMigrated = (e) => e && e.code === '42703';
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
  const region = await resolveSettingsReadRegion(req.user, req.query.region);
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
  if (namesOtherRegion(req.user, b.region)) return res.status(403).json({ error: OTHER_REGION_ERROR });
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
  if (namesOtherRegion(req.user, b.region)) return res.status(403).json({ error: OTHER_REGION_ERROR });
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

// Who may check a site's pin: site editors, and the current approver of a
// submitted GPS meal claim that names it ('review'). Its registrant may still
// move it while it is pending ('owner'). Anyone else: null.
async function siteAccess(user, site) {
  const [settings, pos] = await Promise.all([loadAppSettings(), loadPositions(user.region)]);
  if (mayEditCustomerSites(user, settings, pos)) return 'review';
  const claims = await q(
    `SELECT DISTINCT c.* FROM meal_claims c JOIN meal_claim_lines l ON l.meal_claim_id = c.id
      WHERE l.site_id = $1 AND l.rejected_at IS NULL AND c.status = 'submitted' AND c.scheme = 'gps'`, [site.id]);
  if (claims.some(c => userCanApprove(user, c))) return 'review';
  if (site.status === 'pending' && site.proposed_by != null && Number(site.proposed_by) === Number(user.id)) return 'owner';
  return null;
}
const siteLabel = (s) => [s.db_no ? 'DB' + s.db_no : '', s.alias || s.name || ''].filter(Boolean).join(' · ');

// The open GPS days measured to a site follow it when it changes: their
// snapshot of the pin and the base → site distance are refreshed, and when the
// pin moved each claim's history says so. Decided (approved / paid) claims keep
// what they were judged on.
async function remeasureOpenLines(before, after, actor) {
  const moved = Number(before.lat) !== after.lat || Number(before.lng) !== after.lng;
  const rows = await q(
    `SELECT l.id, l.meal_claim_id, l.line_date, l.base_lat, l.base_lng, l.distance_m, c.status
       FROM meal_claim_lines l JOIN meal_claims c ON c.id = l.meal_claim_id
      WHERE l.site_id = $1 AND l.rejected_at IS NULL AND c.status IN ('submitted', 'rejected')`, [before.id]);
  const notes = new Map();
  for (const l of rows) {
    const dist = l.base_lat == null ? l.distance_m
      : Math.round(distanceMeters({ lat: Number(l.base_lat), lng: Number(l.base_lng) }, after));
    await q('UPDATE meal_claim_lines SET site_name = $1, site_lat = $2, site_lng = $3, distance_m = $4 WHERE id = $5',
      [after.alias || after.name || '', after.lat, after.lng, dist, l.id]);
    if (!moved) continue;
    const k = Number(l.meal_claim_id);
    if (!notes.has(k)) notes.set(k, { status: l.status, days: [] });
    const was = l.distance_m == null ? '' : `${(Number(l.distance_m) / 1000).toFixed(1)} → `;
    notes.get(k).days.push(`${l.line_date}: ${was}${dist == null ? '?' : (Number(dist) / 1000).toFixed(1)} km`);
  }
  for (const [claimId, n] of notes) {
    await logMealHistory(claimId, actor, 'customer site pin moved', n.status, n.status, `${siteLabel(after)} — ${n.days.join(', ')}`);
  }
}

router.put('/api/customer-sites/:id', requireAuth, ah(async (req, res) => {
  const site = await loadSiteOr404(req, res);
  if (!site) return;
  const access = await siteAccess(req.user, site);
  if (!access) return res.status(403).json({ error: 'You don’t have permission to edit customer sites' });
  const parsed = parseSiteInput(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const s = parsed.site;
  // A reviewer's save is a check of the pin: it verifies a pending site.
  const verify = access === 'review';
  const actor = String(req.user.full_name || '').trim();
  let rows;
  try {
    try {
      rows = await q(
        `UPDATE customer_sites SET db_no = $1, name = $2, alias = $3, address = $4, lat = $5, lng = $6,
            verified_by_name = CASE WHEN $8 AND status = 'pending' THEN $9 ELSE verified_by_name END,
            verified_at = CASE WHEN $8 AND status = 'pending' THEN now() ELSE verified_at END,
            status = CASE WHEN $8 THEN 'verified' ELSE status END
          WHERE id = $7 RETURNING *`,
        [s.db_no, s.name, s.alias, s.address, s.lat, s.lng, site.id, verify, actor]);
    } catch (e) {
      if (!notMigrated(e)) throw e;
      // Before the 2026-11-27 migration there is no status to keep.
      rows = await q('UPDATE customer_sites SET db_no = $1, name = $2, alias = $3, address = $4, lat = $5, lng = $6 WHERE id = $7 RETURNING *',
        [s.db_no, s.name, s.alias, s.address, s.lat, s.lng, site.id]);
    }
  } catch (e) {
    if (dupe(e)) return res.status(409).json({ error: `DB${s.db_no} is already pinned in ${site.region} — edit that one instead` });
    throw e;
  }
  await remeasureOpenLines(site, { ...s, id: site.id }, req.user);
  res.json({ site: siteRow(rows[0] || { ...site, ...s, status: verify ? 'verified' : site.status }) });
}));

// Verify a pending site as it is (its pin looked right).
router.post('/api/customer-sites/:id/verify', requireAuth, ah(async (req, res) => {
  const site = await loadSiteOr404(req, res);
  if (!site) return;
  if (await siteAccess(req.user, site) !== 'review') {
    return res.status(403).json({ error: 'Only a manager, a customer-site editor or the claim’s approver can verify this site' });
  }
  let rows;
  try {
    rows = await q(`UPDATE customer_sites SET status = 'verified', verified_by_name = $1, verified_at = now() WHERE id = $2 RETURNING *`,
      [String(req.user.full_name || '').trim(), site.id]);
  } catch (e) { if (notMigrated(e)) return res.status(503).json({ error: NOT_MIGRATED }); throw e; }
  res.json({ site: siteRow(rows[0] || { ...site, status: 'verified' }) });
}));

// A claimant registers a customer site that isn't listed, from the GPS meal
// form: in their own region, pending until someone verifies it (a site
// editor's own registration is verified straight away). A DB number that is
// already pinned answers with that site, which the claimant then just uses.
router.post('/api/customer-sites/register', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const [settings, pos] = await Promise.all([loadAppSettings(), loadPositions(req.user.region)]);
  const editor = mayEditCustomerSites(req.user, settings, pos);
  if (!editor && !mayRaiseGps(req.user, await computePurposes(req.user), settings)) {
    return res.status(403).json({ error: 'The GPS meal allowance is not switched on for your region' });
  }
  if (namesOtherRegion(req.user, b.region)) return res.status(403).json({ error: OTHER_REGION_ERROR });
  const region = (await resolveLookupRegion(req.user, b.region)) || String(req.user.region || '');
  if (!region || region === '*') return res.status(400).json({ error: 'Choose a region' });
  const parsed = parseSiteInput(b);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const s = parsed.site;
  if (!s.name && !s.alias) return res.status(400).json({ error: 'Enter the customer’s name' });
  const existing = async () => s.db_no ? (await q('SELECT * FROM customer_sites WHERE region = $1 AND db_no = $2', [region, s.db_no]))[0] : null;
  const have = await existing();
  if (have) return res.json({ site: siteRow(have), existing: true });
  const actor = String(req.user.full_name || '').trim();
  try {
    if (!editor) {
      const n = (await q(`SELECT COUNT(*)::int AS n FROM customer_sites WHERE proposed_by = $1 AND status = 'pending'`, [req.user.id]))[0];
      if (n && n.n >= MAX_PENDING_PER_USER) {
        return res.status(429).json({ error: `You have ${MAX_PENDING_PER_USER} sites waiting for verification — ask your manager to check them first` });
      }
    }
    const rows = await q(
      `INSERT INTO customer_sites (region, db_no, name, alias, address, lat, lng, status, proposed_by, proposed_by_name, verified_by_name, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $8 = 'verified' THEN now() END) RETURNING *`,
      [region, s.db_no, s.name, s.alias, s.address, s.lat, s.lng, editor ? 'verified' : 'pending', req.user.id, actor, editor ? actor : '']);
    res.status(201).json({ site: siteRow(rows[0]) });
  } catch (e) {
    if (notMigrated(e)) return res.status(503).json({ error: NOT_MIGRATED });
    if (dupe(e)) { const again = await existing(); if (again) return res.json({ site: siteRow(again), existing: true }); }
    throw e;
  }
}));

// --- Place search for the site picker --------------------------------------------
// The map picker's "find a place" box, answered from OpenStreetMap's Nominatim
// through this server, so the browser's connect-src stays 'self'. Nominatim's
// usage policy: an identifying User-Agent, at most one request a second, no
// search-as-you-type (the picker searches on Enter / the button only), and
// cache what you can. One instance spaces its own calls; a busy moment answers
// 429 rather than queueing.
const PLACE_UA = 'CibesReimbursement/1.0 (customer site picker)';
const REGION_COUNTRY = { Indonesia: 'id', Thailand: 'th', Malaysia: 'my', Vietnam: 'vn', Cambodia: 'kh', Philippines: 'ph', Singapore: 'sg' };
const placeCache = new Map(); // key → { at, places }
let placeNextAt = 0;
router.get('/api/place-search', requireAuth, ah(async (req, res) => {
  const text = String(req.query.q || '').trim().slice(0, 200);
  if (text.length < 3) return res.status(400).json({ error: 'Type at least 3 characters to search' });
  const near = parseCoords(req.query.near);
  const cc = REGION_COUNTRY[String(req.user.region || '')] || '';
  const lang = /^[a-z]{2,3}$/.test(String(req.query.lang || '')) ? String(req.query.lang) : 'en';
  const key = [text.toLowerCase(), cc, lang, near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : ''].join('|');
  const hit = placeCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return res.json({ places: hit.places });
  const now = Date.now();
  if (now < placeNextAt) {
    const wait = placeNextAt - now;
    if (wait > 2500) return res.status(429).json({ error: 'The place search is busy — try again in a moment' });
    await new Promise(r => setTimeout(r, wait));
  }
  placeNextAt = Math.max(now, placeNextAt) + 1100;
  const params = new URLSearchParams({ q: text, format: 'jsonv2', limit: '8', addressdetails: '0', 'accept-language': lang });
  if (cc) params.set('countrycodes', cc);
  // Prefer places around the claimant's base (not a hard limit).
  if (near) params.set('viewbox', [near.lng - 1.5, near.lat + 1.5, near.lng + 1.5, near.lat - 1.5].join(','));
  let list;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': PLACE_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(String(r.status));
    list = await r.json();
  } catch {
    return res.status(502).json({ error: 'The place search isn’t answering right now — move the map by hand, or paste a Google Maps link' });
  }
  const places = (Array.isArray(list) ? list : []).map(p => ({ name: String(p.name || ''), label: String(p.display_name || ''),
    lat: Number(p.lat), lng: Number(p.lon) })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (placeCache.size > 300) placeCache.delete(placeCache.keys().next().value);
  placeCache.set(key, { at: Date.now(), places });
  res.json({ places });
}));

router.delete('/api/customer-sites/:id', requireAuth, requireSiteEditor, ah(async (req, res) => {
  const site = await loadSiteOr404(req, res);
  if (!site) return;
  await q('DELETE FROM customer_sites WHERE id = $1', [site.id]);
  res.json({ ok: true });
}));

module.exports = router;
