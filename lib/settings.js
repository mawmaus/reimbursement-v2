'use strict';

// Regions, the app_settings key/value store (cached), per-region currency /
// time zone / bank defaults and meal-allowance rates.

const { q } = require('../db');

// --- Regions (data-access scoping) ------------------------------------------
// An account belongs to one region (a regions.name value) or the sentinel '*'
// = All regions. Data is hidden outside the account's region; super admins and
// '*' accounts see everything. Regions are a managed lookup (Settings).
const ALL_REGIONS = '*';
function seesAllRegions(user) {
  return !!user && (user.role === 'superadmin' || user.role === 'vp' || user.region === ALL_REGIONS);
}
// Resolve a requested region to its canonical stored value: '*' stays '*'; a
// known active region name is returned with the lookup's casing; '' stays '';
// anything else -> null (invalid). Used when assigning a region to an account
// or an All-regions submitter's claim.
async function normRegion(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === ALL_REGIONS) return ALL_REGIONS;
  if (!s) return '';
  const rows = await q('SELECT name FROM regions WHERE lower(name) = lower($1) AND active = TRUE', [s]);
  return rows[0] ? rows[0].name : null;
}

// Which region a data read (claim lists, summaries, insights) is scoped to for
// this request. Region-locked accounts are always pinned to their own region.
// All-region viewers (Super Admins, VPs, '*' accounts) see every region by
// default, but the top-bar region picker can narrow the view to one region via
// ?region=Name. Returns the region name to filter by (may be '' for a
// blank-region account), or null to apply NO region filter (see everything). A
// blank / '*' / unknown ?region from an all-region viewer keeps the full view.
async function viewRegionFilter(req) {
  if (!seesAllRegions(req.user)) return String(req.user.region || '');
  const raw = req.query && req.query.region != null ? String(req.query.region).trim() : '';
  if (!raw || raw === ALL_REGIONS) return null;
  const r = await normRegion(raw);
  return (!r || r === ALL_REGIONS) ? null : r;
}

// --- App-wide settings (key/value store) -----------------------------------
// Every authenticated request needs these (for the role matrix), so they are
// held in memory briefly instead of re-read on each call. A save on this
// instance drops the copy at once; other warm instances pick a change up within
// SETTINGS_TTL_MS. Read-modify-write handlers pass { fresh: true } so they never
// build an update on top of a stale copy and overwrite someone else's change.
const SETTINGS_TTL_MS = 30 * 1000;
let settingsCache = null; // { at, promise }
async function loadAppSettings({ fresh = false } = {}) {
  if (fresh || !settingsCache || Date.now() - settingsCache.at > SETTINGS_TTL_MS) {
    const promise = q('SELECT key, value FROM app_settings').then(rows => {
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    });
    const entry = { at: Date.now(), promise };
    settingsCache = entry;
    // A failed read must not stay cached.
    promise.catch(() => { if (settingsCache === entry) settingsCache = null; });
  }
  // Callers get their own copy, so nothing can mutate the shared one.
  return { ...(await settingsCache.promise) };
}
async function setAppSetting(key, value) {
  settingsCache = null;
  await q(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value == null ? '' : value)]);
  settingsCache = null;
}

// --- Per-region defaults: currency + time zone ------------------------------
// Each region has a default currency (stamped onto new claims when the client
// doesn't specify one) and a default time zone (governs what counts as "today"
// for a claim's date and the claim-window floor). Stored as JSON in
// app_settings under `region_prefs_by_region`: { [regionName]: { currency, timezone } }.
// Regions without an entry — and All-regions/blank accounts — use the globals.
const DEFAULT_CURRENCY = 'IDR';
const DEFAULT_TIMEZONE = 'Asia/Jakarta';
// The currencies an admin may choose from (ISO 4217 codes for the countries the
// portal serves). The order is the display order in the settings dropdown.
const AVAILABLE_CURRENCIES = ['IDR', 'USD', 'THB', 'VND', 'KHR', 'MYR', 'KRW'];
const CURRENCY_SET = new Set(AVAILABLE_CURRENCIES);
// The time zones an admin may choose from. Kept to the regions the portal serves
// (plus USD/global) so the list stays short and every option is a valid IANA id.
const AVAILABLE_TIMEZONES = [
  // Ordered by UTC offset (ascending), Jakarta first as the default.
  'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Phnom_Penh', // GMT+7
  'Asia/Makassar', 'Asia/Kuala_Lumpur', 'Asia/Manila',                    // GMT+8
  'Asia/Jayapura', 'Asia/Seoul',                                          // GMT+9
  'UTC'                                                                    // GMT+0
];
const TIMEZONE_SET = new Set(AVAILABLE_TIMEZONES);
// Is `tz` a time zone the runtime accepts? (Defence in depth beyond the fixed
// list — an unknown id would throw when we format dates with it.)
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; }
  catch { return false; }
}
// Each region also configures its bank/payout policy: a "preferred" bank whose
// payouts carry no transfer fee, and a flat fee (in whole units of the region's
// currency) charged on payouts to any other bank. Shown on the profile bank
// picker. Regions without an entry fall back to these — the legacy Indonesian
// policy (BCA free, IDR 2,500 to others) — so existing installs are unchanged.
const DEFAULT_PREFERRED_BANK = 'BCA';
const DEFAULT_BANK_FEE = 2500;
const MAX_BANK_FEE = 1e9;      // sanity ceiling on the fee amount
const MAX_BANK_NAME_LEN = 60;  // keep the stored preferred-bank name short
// Parse the stored region-prefs map (tolerant of malformed JSON).
function regionPrefsMap(settings) {
  try { return settings.region_prefs_by_region ? JSON.parse(settings.region_prefs_by_region) : {}; }
  catch { return {}; }
}
// The effective { currency, timezone, preferredBank, bankFee } for a region,
// falling back to the global defaults. '*'/blank (All-regions accounts) always
// use the defaults.
function regionPrefs(settings, region) {
  const r = region && region !== ALL_REGIONS ? regionPrefsMap(settings)[region] : null;
  const currency = r && CURRENCY_SET.has(r.currency) ? r.currency : DEFAULT_CURRENCY;
  const timezone = r && isValidTimezone(r.timezone) ? r.timezone : DEFAULT_TIMEZONE;
  const preferredBank = r && typeof r.bank === 'string' && r.bank.trim()
    ? r.bank.trim() : DEFAULT_PREFERRED_BANK;
  const feeRaw = r ? Math.round(Number(r.bankFee)) : NaN;
  const bankFee = Number.isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : DEFAULT_BANK_FEE;
  return { currency, timezone, preferredBank, bankFee };
}
// Convenience: load settings and resolve a region's prefs in one call.
async function regionPrefsFor(region) {
  return regionPrefs(await loadAppSettings(), region);
}

// --- Meal allowance rates (per-region dropdown amounts) ---------------------
// The Meal Allowance form's Amount field is a dropdown of preset amounts an
// admin configures per region (Settings → Meal allowance). Stored as JSON in
// app_settings under `meal_rates_by_region`: { [region]: [amount, ...] } where
// each amount is a whole currency unit (e.g. 75000, later ×100 into cents on
// submit). A region without an entry falls back to DEFAULT_MEAL_RATES — the two
// legacy Indonesian rates so existing installs keep working unchanged.
const DEFAULT_MEAL_RATES = [75000, 120000];
// A generous cap so the editor and stored JSON stay small.
const MAX_MEAL_RATES = 20;
const MAX_MEAL_AMOUNT = 1e12; // sanity ceiling on a single amount
function mealRatesMap(settings) {
  try { return settings.meal_rates_by_region ? JSON.parse(settings.meal_rates_by_region) : {}; }
  catch { return {}; }
}
// Normalise one stored entry to a positive integer amount, or null when invalid.
// Tolerates a bare number, a numeric string, or a legacy { amount } object from
// the earlier label+amount shape.
function toMealAmount(item) {
  const n = Math.round(Number(item && typeof item === 'object' ? item.amount : item));
  return Number.isFinite(n) && n > 0 ? n : null;
}
// The configured amount list for a region, normalised to positive integers.
// Falls back to the defaults when a region has no saved list (blank/All-regions
// accounts always get the defaults).
function mealRatesFor(settings, region) {
  const raw = region && region !== ALL_REGIONS ? mealRatesMap(settings)[region] : null;
  if (!Array.isArray(raw)) return [...DEFAULT_MEAL_RATES];
  const out = [];
  for (const item of raw) { const n = toMealAmount(item); if (n !== null) out.push(n); }
  return out;
}

// ---------------------------------------------------------------------------
// Settings: simple lookups (departments, job positions, expense types)
// ---------------------------------------------------------------------------
// Table names and flag column names are hard-coded (never user input), so
// interpolation is safe. `flags` lists extra BOOLEAN columns (e.g. the purpose
// gates allow_claim / allow_meal) that admins can toggle per row.
// Which region a lookup request targets. Region-scoped users are pinned to their
// own region; super admins / All-regions accounts may name any region (query for
// reads, body for writes). Returns a concrete region name, '' (no region named —
// on a read, means "every region"), or null when `requested` names an unknown
// region. '*' is never a lookup region of its own.
async function resolveLookupRegion(user, requested) {
  if (!seesAllRegions(user)) return String(user.region || '');
  const raw = requested == null ? '' : String(requested).trim();
  if (!raw) return '';
  const r = await normRegion(raw);
  return r === ALL_REGIONS ? '' : r;
}

module.exports = {
  DEFAULT_TIMEZONE, loadAppSettings, ALL_REGIONS, seesAllRegions, regionPrefs,
  regionPrefsFor, resolveLookupRegion, setAppSetting, AVAILABLE_CURRENCIES,
  AVAILABLE_TIMEZONES, CURRENCY_SET, TIMEZONE_SET, isValidTimezone,
  MAX_BANK_NAME_LEN, MAX_BANK_FEE, regionPrefsMap, mealRatesFor,
  MAX_MEAL_RATES, mealRatesMap, toMealAmount, MAX_MEAL_AMOUNT, normRegion,
  viewRegionFilter, DEFAULT_CURRENCY
};
