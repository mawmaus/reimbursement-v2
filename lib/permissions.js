'use strict';

// The per-region role-permission matrix and capabilities, plus job-position
// rank rules: account management, Insights visibility and cross-department
// reach.

const { q } = require('../db');
const { loadAppSettings, ALL_REGIONS, seesAllRegions } = require('./settings');

// --- Role permissions (editable capability matrix) --------------------------
// Beyond the fixed role (superadmin/admin/user), a super admin can grant each
// role extra capabilities. These are ADDITIVE: they only widen what a user may
// do on top of what their job position / department / flags already allow. The
// matrix is stored as JSON in app_settings under `role_permissions`; superadmin
// is always all-true and never stored. Defaults reproduce the pre-matrix
// behaviour (admins could export CSV; everyone else nothing extra).
const CAPABILITIES = [
  { key: 'view_all_claims',   label: 'View all claims',            desc: 'See every claim in the system, not only their own or ones they approve.' },
  { key: 'mark_paid',         label: 'Mark claims as paid',        desc: 'Record and revert payments on approved claims.' },
  { key: 'delete_claims',     label: 'Delete claims',              desc: 'Permanently delete reimbursement or meal allowance claims.' },
  { key: 'export_csv',        label: 'Export claims to CSV',       desc: 'Download reimbursement, meal and realized cash-advance claims as a CSV file.' },
  { key: 'create_accounts',   label: 'Create accounts',            desc: 'Add new user accounts.' },
  { key: 'manage_accounts',   label: 'Manage accounts',            desc: 'Reset passwords and enable or disable accounts.' },
  { key: 'manage_settings',   label: 'Manage settings',            desc: 'Edit departments, job positions, expense types, meal allowance amounts and the claim date limit.' },
  { key: 'view_insights_all', label: 'View company-wide insights', desc: 'Open expense insights across every department.' }
];
const CAPABILITY_KEYS = new Set(CAPABILITIES.map(c => c.key));
// Editable roles shown as rows in the region matrix (superadmin is implicit/all
// -on and never shown). Ordered senior → junior to match the workspace UI.
const EDITABLE_ROLES = ['vp', 'admin', 'manager', 'lowmgmt', 'finance', 'employee'];
// Super Admins may configure Vice President, Country Manager / Managing Director,
// Mid Management, Low Management, and Finance permissions for each region. The
// Employee baseline stays locked.
const REGION_EDITABLE_ROLES = ['vp', 'admin', 'manager', 'lowmgmt', 'finance'];
// A VP sits just below the Super Admin: they may open the region matrix and
// configure every role beneath them — CM/MD, Mid/Low Management and Finance —
// but never the Super Admin (implicit/all-on) or their own VP row.
const VP_EDITABLE_ROLES = ['admin', 'manager', 'lowmgmt', 'finance'];
// A CM/MD (admin) may also open the region matrix, but only for the rows below
// their own — Mid/Low/Finance — never the VP or admin rows (self-escalation) or
// the locked Employee baseline. Which rows an actor may toggle depends on role.
const CMMD_EDITABLE_ROLES = ['manager', 'lowmgmt', 'finance'];
function editableRolesFor(user) {
  if (!user) return [];
  if (user.role === 'superadmin') return REGION_EDITABLE_ROLES;
  if (user.role === 'vp') return VP_EDITABLE_ROLES;
  if (user.role === 'admin') return CMMD_EDITABLE_ROLES;
  return [];
}
// Only capabilities set true here are granted by default; everything else false.
// New roles start with nothing — configure them per region in the matrix.
const ROLE_DEFAULTS = { vp: { export_csv: true }, admin: { export_csv: true }, manager: {}, lowmgmt: {}, finance: {}, employee: {} };

// Fill a raw stored matrix into a complete { role: { cap: bool } }, taking each
// missing entry from `fallback` (another filled matrix) or, failing that, from
// ROLE_DEFAULTS. Lets a region matrix inherit from the global defaults.
function fillMatrix(stored, fallback) {
  const out = {};
  for (const role of EDITABLE_ROLES) {
    out[role] = {};
    const s = (stored && stored[role]) || {};
    const fb = (fallback && fallback[role]) || null;
    for (const c of CAPABILITIES) {
      out[role][c.key] = Object.prototype.hasOwnProperty.call(s, c.key) ? !!s[c.key]
        : fb ? !!fb[c.key]
        : !!ROLE_DEFAULTS[role][c.key];
    }
  }
  return out;
}
// The global default matrix (app_settings.role_permissions), normalised. Serves
// as the fallback for any region without its own overrides.
function loadGlobalRolePerms(settings) {
  let stored = {};
  try { stored = settings.role_permissions ? JSON.parse(settings.role_permissions) : {}; }
  catch { stored = {}; }
  return fillMatrix(stored, null);
}
// The effective matrix for one region: that region's stored overrides layered on
// top of the global defaults. '*'/blank (All-regions accounts) use the globals.
async function loadRolePermsForRegion(region, settings) {
  settings = settings || await loadAppSettings();
  const global = loadGlobalRolePerms(settings);
  if (!region || region === ALL_REGIONS) return global;
  let byRegion = {};
  try { byRegion = settings.role_permissions_by_region ? JSON.parse(settings.role_permissions_by_region) : {}; }
  catch { byRegion = {}; }
  return fillMatrix(byRegion[region], global);
}
// Flatten the matrix into this user's own capability map. Superadmins get all.
function capsFor(user, perms) {
  const isSuper = user && user.role === 'superadmin';
  const out = {};
  for (const c of CAPABILITIES) out[c.key] = isSuper ? true : !!(perms[user.role] && perms[user.role][c.key]);
  return out;
}
// Attach the computed capability map to a user object so the sync helpers below
// and the client payload can read it; returns the map. Caps come from the
// account's own region matrix (falling back to the global defaults).
async function attachCaps(user, settings) {
  if (!user) return {};
  user.caps = capsFor(user, await loadRolePermsForRegion(user.region, settings));
  return user.caps;
}
// Does this user hold a capability? Relies on caps being attached (attachCaps /
// requireAuth). Superadmin always passes even if caps were not attached.
function userCan(user, cap) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  return !!(user.caps && user.caps[cap]);
}

// --- Job-position ranking & department-scoped account management -------------
// Job positions form an ordered ladder (job_positions.rank, 1 = most senior),
// editable by super admins in Settings. Account management is scoped to the
// actor's OWN department, and an actor may manage only positions ranked strictly
// below their own (higher number = more junior = fewer rights). Superadmins are
// unrestricted (all departments; they use full Settings). Positions are matched
// case-insensitively by name against job_positions.
//
// The ladder helpers below are PURE: each takes a `pos` map (from loadPositions)
// so a request loads the ranking once and threads it through. `pos` maps
// lower(name) → { rank, can_manage }.
async function loadPositions(region) {
  // Ranks are per region now: load the ladder for a concrete region, or every
  // row (All-regions / unspecified — names collide, last wins) otherwise.
  const concrete = region && region !== ALL_REGIONS;
  const rows = concrete
    ? await q('SELECT name, rank, can_manage FROM job_positions WHERE region = $1', [region])
    : await q('SELECT name, rank, can_manage FROM job_positions');
  const byName = new Map();
  for (const r of rows) {
    byName.set(String(r.name).trim().toLowerCase(),
      { name: String(r.name).trim(), rank: r.rank || Infinity, can_manage: !!r.can_manage });
  }
  return byName;
}
// 1-based rank; Infinity for a position not found (weakest — manages nobody, and
// is itself not manageable by rank).
function positionRank(name, pos) {
  const rec = pos.get(String(name || '').trim().toLowerCase());
  return rec ? rec.rank : Infinity;
}
// Whether a user may delegate account management at all. Superadmins and admins
// always may (department- and rank-limited elsewhere); a plain user may only if
// their job position is flagged can_manage. NOTE: this now gates only *team
// account management* (reset password / enable-disable) — account CREATION is
// super-admin only (see POST /api/users). The 'admin' role is no longer special
// here; management is governed purely by the position flag.
function hasDelegation(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (userCan(user, 'manage_accounts')) return true;
  const rec = pos.get(String(user.position || '').trim().toLowerCase());
  return !!(rec && rec.can_manage);
}

// The canonical position names a user may create accounts for: every position
// ranked strictly below their own. Empty unless they hold delegation rights and
// their own position is on the ladder. Returned most-senior-first by rank.
function creatablePositions(user, pos) {
  if (!hasDelegation(user, pos)) return [];
  const rank = positionRank(user.position, pos);
  if (rank === Infinity) return [];
  return [...pos.values()]
    .filter((rec) => rec.rank > rank)
    .sort((a, b) => a.rank - b.rank)
    .map((rec) => rec.name);
}

// Whether `actor` may manage (reset password / enable-disable) the account
// `target`. Superadmins may manage anyone. Everyone else (admins and delegated
// seniors) may manage any account below Super Admin / VP in their OWN department
// whose position ranks strictly below their own — regardless of the target's
// role. This keeps management purely rank + department based (a Manager can
// reset/disable a more junior Supervisor whether that Supervisor is an employee
// or an admin), while still protecting superadmins, VPs, and anyone at or above
// the actor's own rank.
// (Account *creation* is gated by the create_accounts capability — see POST.)
function canManageAccount(actor, target, pos) {
  if (actor.role === 'superadmin') return true;
  if (!hasDelegation(actor, pos)) return false;
  if (target.role === 'superadmin') return false;
  // A VP outranks everyone but the Super Admin — only a Super Admin may act on
  // one (reset its password, enable/disable it). CM/MD and seniors never can.
  if (target.role === 'vp') return false;
  // Region isolation: a region-scoped actor manages only same-region accounts.
  if (!seesAllRegions(actor) && String(target.region || '') !== String(actor.region || '')) return false;
  // Department scope: normally an actor manages only their own department, but
  // Director-and-above positions reach across every department (still rank- and
  // region-bounded by the checks around this one).
  if (!accountsSeeAllDepts(actor, pos)) {
    const aDept = String(actor.department || '').trim().toLowerCase();
    const tDept = String(target.department || '').trim().toLowerCase();
    if (!aDept || aDept !== tDept) return false;
  }
  const tRank = positionRank(target.position, pos);
  if (tRank === Infinity) return false;
  return positionRank(actor.position, pos) < tRank;
}

// --- Expense-insights visibility -------------------------------------------
// Who may see company-wide expense insights vs. only their own department's:
// super admins always; anyone in a Finance department (any position); and anyone
// whose job position ranks at General Manager or above (rank <= GM's rank, since
// rank 1 is the most senior). Everyone else is scoped to their own department.
// GM's rank is read live from the ladder (super admins can reorder it); if no
// "General Manager" position exists, fall back to the seeded GM rank (5).
const GM_FALLBACK_RANK = 5;
const SUPERVISOR_FALLBACK_RANK = 10;
const DIRECTOR_FALLBACK_RANK = 3;
const isFinanceDept = (dept) => /financ/i.test(String(dept || ''));
// True when `user`'s position ranks at or above `posName` (or the given fallback
// rank if that position isn't on the ladder). rank 1 is the most senior, so
// "at or above" means a rank number <= the threshold.
function rankAtLeast(user, pos, posName, fallbackRank) {
  const t = positionRank(posName, pos);
  const threshold = t === Infinity ? fallbackRank : t;
  const r = positionRank(user.position, pos);
  return r !== Infinity && r <= threshold;
}
// Who may open the Insights view at all: super admins, anyone in a Finance
// department (any position), and any position ranked Supervisor or above.
function insightsCanView(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (userCan(user, 'view_insights_all')) return true;
  if (isFinanceDept(user.department)) return true;
  return rankAtLeast(user, pos, 'supervisor', SUPERVISOR_FALLBACK_RANK);
}
// Of those who can view, who sees company-wide data vs. only their own
// department: super admins, Finance, and any position ranked General Manager or
// above. Everyone else (Supervisor .. below-GM) is scoped to their department.
function insightsSeeAll(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (userCan(user, 'view_insights_all')) return true;
  if (isFinanceDept(user.department)) return true;
  return rankAtLeast(user, pos, 'general manager', GM_FALLBACK_RANK);
}

// --- Cross-department account reach -----------------------------------------
// The Manage-accounts list and canManageAccount are normally scoped to the
// actor's OWN department. This override lifts the department wall for the most
// senior positions: super admins always, plus any position ranked Director or
// above (rank <= Director's rank; rank 1 is most senior). Such actors may view —
// and, subject to the usual rank/role/region guards in canManageAccount, manage —
// accounts in ANY department. Region isolation is unchanged: a region-scoped
// Director still sees only their own region. Director's rank is read live from
// the ladder (super admins can reorder it), falling back to the seeded rank 3.
function accountsSeeAllDepts(user, pos) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  return rankAtLeast(user, pos, 'director', DIRECTOR_FALLBACK_RANK);
}
const ROLES = ['superadmin', 'vp', 'admin', 'manager', 'lowmgmt', 'finance', 'employee'];
// Roles a delegated (non-superadmin) creator may assign: every role strictly
// more junior than their own in the ROLES ladder (index 0 = most senior). This
// keeps a create_accounts holder from minting peers or seniors — no
// self-escalation. Super admins are unrestricted and handled at the call site.
function creatableRolesFor(user) {
  if (!user) return [];
  if (user.role === 'superadmin') return ROLES.filter(r => r !== 'superadmin');
  const i = ROLES.indexOf(user.role);
  return i < 0 ? [] : ROLES.slice(i + 1);
}

module.exports = {
  attachCaps, userCan, loadPositions, creatablePositions, hasDelegation,
  insightsCanView, accountsSeeAllDepts, CAPABILITIES, EDITABLE_ROLES,
  editableRolesFor, loadRolePermsForRegion, CAPABILITY_KEYS, insightsSeeAll,
  ROLES, creatableRolesFor, canManageAccount, fillMatrix, capsFor
};
