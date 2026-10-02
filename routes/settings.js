'use strict';

// Claim window, region defaults, meal-allowance rates and the role-permission
// matrix.

const express = require('express');
const { requireAuth, requireCap } = require('../lib/auth');
const { ah, isISODate, isActive } = require('../lib/util');
const {
  resolveLookupRegion, loadAppSettings, setAppSetting, regionPrefs,
  AVAILABLE_CURRENCIES, AVAILABLE_TIMEZONES, CURRENCY_SET, TIMEZONE_SET,
  isValidTimezone, MAX_BANK_NAME_LEN, MAX_BANK_FEE, regionPrefsMap,
  mealRatesFor, MAX_MEAL_RATES, mealRatesMap, toMealAmount, MAX_MEAL_AMOUNT,
  seesAllRegions, normRegion, ALL_REGIONS
} = require('../lib/settings');
const { claimWindowView } = require('../lib/claim-window');
const {
  CAPABILITIES, EDITABLE_ROLES, editableRolesFor, loadRolePermsForRegion,
  CAPABILITY_KEYS
} = require('../lib/permissions');

const router = express.Router();

// Claim-date policy: how far back an expense may be dated and still be claimable.
// Scoped per region: a submitter reads their own region's policy (the claim form
// needs it to validate); a super admin reads/edits any region via ?region /
// body.region. Only accounts that can manage settings change it, and region
// -scoped managers only for their own region.
router.get('/api/claim-window', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  res.json(claimWindowView(await loadAppSettings(), region));
}));

router.put('/api/claim-window', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  // Rolling window in days: a positive integer, or blank/0 to disable.
  let days = '';
  if (b.max_age_days != null && String(b.max_age_days).trim() !== '') {
    const n = parseInt(b.max_age_days, 10);
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      return res.status(400).json({ error: 'Maximum age must be a whole number of days between 0 and 3650' });
    }
    days = n > 0 ? String(n) : '';
  }
  // Absolute earliest date (YYYY-MM-DD), or blank to disable.
  let earliest = '';
  if (b.earliest_date != null && String(b.earliest_date).trim() !== '') {
    if (!isISODate(String(b.earliest_date).trim())) {
      return res.status(400).json({ error: 'Earliest date must be a valid date' });
    }
    earliest = String(b.earliest_date).trim();
  }
  // Persist under the region's key, layered over the global defaults.
  const settings = await loadAppSettings({ fresh: true });
  let byRegion = {};
  try { byRegion = settings.claim_window_by_region ? JSON.parse(settings.claim_window_by_region) : {}; }
  catch { byRegion = {}; }
  byRegion[region] = { max_age_days: days, earliest_date: earliest };
  await setAppSetting('claim_window_by_region', JSON.stringify(byRegion));
  res.json(claimWindowView({ ...settings, claim_window_by_region: JSON.stringify(byRegion) }, region));
}));

// Per-region default currency + time zone. Read by any signed-in user for their
// own region (the claim form needs the default currency); a super admin may read
// any region via ?region. Edited by Super Admins (any region) and Country
// Managers / Managing Directors (their own region only) — the same audience as
// the region role matrix.
function canManageRegionPrefs(user) {
  return !!user && (user.role === 'superadmin' || user.role === 'admin');
}
// The response shape shared by GET/PUT: the region's effective prefs plus the
// option lists the settings dropdowns render from.
function regionPrefsView(settings, region) {
  const prefs = regionPrefs(settings, region);
  return { region, ...prefs, currencies: AVAILABLE_CURRENCIES, timezones: AVAILABLE_TIMEZONES };
}

router.get('/api/region-prefs', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  res.json(regionPrefsView(await loadAppSettings(), region));
}));

router.put('/api/region-prefs', requireAuth, ah(async (req, res) => {
  if (!canManageRegionPrefs(req.user)) return res.status(403).json({ error: 'You do not have permission for this action' });
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  const currency = String(b.currency || '').trim();
  if (!CURRENCY_SET.has(currency)) return res.status(400).json({ error: 'Choose a valid currency' });
  const timezone = String(b.timezone || '').trim();
  if (!TIMEZONE_SET.has(timezone) || !isValidTimezone(timezone)) return res.status(400).json({ error: 'Choose a valid time zone' });
  const bank = String(b.bank || '').trim().slice(0, MAX_BANK_NAME_LEN);
  if (!bank) return res.status(400).json({ error: 'Enter the preferred (no-fee) bank name' });
  const bankFee = Math.round(Number(b.bankFee));
  if (!Number.isFinite(bankFee) || bankFee < 0 || bankFee > MAX_BANK_FEE) {
    return res.status(400).json({ error: 'Enter a valid bank fee (0 or more)' });
  }
  const settings = await loadAppSettings({ fresh: true });
  const byRegion = regionPrefsMap(settings);
  byRegion[region] = { currency, timezone, bank, bankFee };
  await setAppSetting('region_prefs_by_region', JSON.stringify(byRegion));
  res.json(regionPrefsView({ ...settings, region_prefs_by_region: JSON.stringify(byRegion) }, region));
}));

// Per-region meal-allowance rate presets. Read by any signed-in user for their
// own region (the meal form needs the dropdown options); a super admin may read
// any region via ?region. Edited by anyone with the manage_settings capability
// (same audience as departments / expense types / the claim window).
router.get('/api/meal-rates', requireAuth, ah(async (req, res) => {
  const region = await resolveLookupRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  res.json({ region, rates: mealRatesFor(await loadAppSettings(), region) });
}));

router.put('/api/meal-rates', requireAuth, requireCap('manage_settings'), ah(async (req, res) => {
  const b = req.body || {};
  const region = await resolveLookupRegion(req.user, b.region);
  if (region === null || !region) return res.status(400).json({ error: 'Choose a region' });
  if (!Array.isArray(b.rates)) return res.status(400).json({ error: 'Rates must be a list' });
  if (b.rates.length > MAX_MEAL_RATES) return res.status(400).json({ error: `Add at most ${MAX_MEAL_RATES} amounts` });
  const rates = [];
  for (const item of b.rates) {
    const amount = toMealAmount(item);
    if (amount === null || amount > MAX_MEAL_AMOUNT) {
      return res.status(400).json({ error: 'Every amount must be a positive whole number' });
    }
    rates.push(amount);
  }
  const settings = await loadAppSettings({ fresh: true });
  const byRegion = mealRatesMap(settings);
  byRegion[region] = rates;
  await setAppSetting('meal_rates_by_region', JSON.stringify(byRegion));
  res.json({ region, rates: mealRatesFor({ ...settings, meal_rates_by_region: JSON.stringify(byRegion) }, region) });
}));

// --- Role permissions matrix (region-scoped) --------------------------------
// The capability matrix is configured per region by Super Admins only. Super
// Admin is implicitly all-true and omitted from `matrix`; only Mid Management /
// Low Management / Finance rows are editable.
function canAccessRoleMatrix(user) {
  return !!user && (user.role === 'superadmin' || user.role === 'vp' || user.role === 'admin');
}
// Which region a request may act on. Non-superadmins are pinned to their own
// region whatever they ask for; super admins / All-regions accounts may target
// any region they name. Returns null for a named-but-unknown region.
async function resolveMatrixRegion(user, requested) {
  if (!seesAllRegions(user)) return String(user.region || '');
  return normRegion(requested);
}

// Read the editable capability matrix for a region (?region=Name).
router.get('/api/role-permissions', requireAuth, ah(async (req, res) => {
  if (!canAccessRoleMatrix(req.user)) return res.status(403).json({ error: 'You do not have permission for this action' });
  const region = await resolveMatrixRegion(req.user, req.query.region);
  if (region === null) return res.status(400).json({ error: 'Invalid region' });
  res.json({
    capabilities: CAPABILITIES,
    roles: EDITABLE_ROLES,
    editableRoles: editableRolesFor(req.user),
    region,
    matrix: await loadRolePermsForRegion(region),
    superadminLocked: true
  });
}));
// Toggle one capability for one editable role in one region. A CM/MD may only
// touch their own region and only the Mid/Low/Finance rows — never their own
// (admin) row or the Employee baseline — so they cannot self-escalate. Overrides
// are stored sparsely so unset capabilities keep tracking the global defaults.
router.put('/api/role-permissions', requireAuth, ah(async (req, res) => {
  if (!canAccessRoleMatrix(req.user)) return res.status(403).json({ error: 'You do not have permission for this action' });
  const { role, cap, value } = req.body || {};
  const region = await resolveMatrixRegion(req.user, (req.body || {}).region);
  if (!region || region === ALL_REGIONS) return res.status(400).json({ error: 'Choose a region' });
  if (!editableRolesFor(req.user).includes(role)) return res.status(400).json({ error: 'This role is not editable' });
  if (!CAPABILITY_KEYS.has(cap)) return res.status(400).json({ error: 'Invalid capability' });

  const settings = await loadAppSettings({ fresh: true });
  let byRegion = {};
  try { byRegion = settings.role_permissions_by_region ? JSON.parse(settings.role_permissions_by_region) : {}; }
  catch { byRegion = {}; }
  const store = byRegion[region] || {};
  if (!store[role]) store[role] = {};
  store[role][cap] = isActive(value);
  byRegion[region] = store;
  await setAppSetting('role_permissions_by_region', JSON.stringify(byRegion));
  res.json({ ok: true, region, matrix: await loadRolePermsForRegion(region, { ...settings, role_permissions_by_region: JSON.stringify(byRegion) }) });
}));

module.exports = router;
