'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  user: null, claims: [], filters: { status: '', department: '', claimant: '', q: '' },
  // Which list is open: 'home' (clean landing, no list), 'mine' (claims I
  // submitted), 'approval' (awaiting my decision), 'approved' (claims I approved
  // that I can still revert), or 'all' (super admin only).
  view: 'home',
  // Active column sort for the ledger. key '' = server default (newest first);
  // dir 1 = ascending, -1 = descending.
  sort: { key: '', dir: 1 },
  lookups: { departments: [], expense_types: [], regions: [] },
  // Claim-date policy (from GET /api/claim-window). `earliest` is the computed
  // earliest expense date a claim may carry, or null when unrestricted.
  claimLimit: { max_age_days: null, earliest_date: null, earliest: null },
  // Preset meal-allowance amounts for the signed-in user's region (from GET
  // /api/meal-rates). The Meal Allowance form's Amount dropdown lists these.
  mealRates: [],
  // Insights view: active filters, the "monthly vs yearly" trend toggle, and the
  // last payload from /api/insights (kept so the trend toggle re-renders without
  // a refetch).
  insights: { year: '', month: '', department: '', db: '', name: '', status: 'approved,paid', trend: 'month', drill: null, data: null },
  // Ticked claims for PDF export, keyed "type:id" (the two claim types can
  // share numeric ids, so the type must be part of the key).
  selected: new Set(),
  // Top-bar region picker: which region an all-region viewer (Super Admin / VP /
  // '*' account) has scoped the dashboard to. '' = all regions. Region-locked
  // accounts ignore this (they only ever see their own region). Reset on login.
  viewRegion: ''
};
const claimKey = (type, id) => `${type}:${id}`;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(pathName, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  // A rejected fetch() is always a network-level failure (offline, a dropped
  // connection, a DNS/TLS blip) surfacing as an opaque "Failed to fetch" — never
  // an HTTP error, which resolves normally and is handled below. Those blips are
  // transient, so retry a couple of times with a short backoff. Only GETs are
  // safe to replay; retrying a POST/PUT/DELETE could double-submit (e.g. approve
  // or mark-paid twice), so those surface the failure on the first miss.
  const retries = method === 'GET' ? 2 : 0;
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch('/api' + pathName, {
        credentials: 'same-origin',
        headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
        ...opts
      });
      break;
    } catch {
      if (attempt >= retries) {
        throw new Error(navigator.onLine === false
          ? t('You appear to be offline. Check your connection and try again.')
          : t('Network error — could not reach the server. Please try again.'));
      }
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
// Always show the ISO currency code (IDR, USD, THB, VND, …) rather than a
// locale symbol like "Rp" or "$", so amounts read the same for every user and
// currency. currencyDisplay: 'code' forces the code prefix.
function money(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'IDR', currencyDisplay: 'code' }).format(amount);
  } catch { return `${currency || ''} ${Number(amount).toLocaleString()}`; }
}
// Compact currency for chart axes / KPI headline numbers, e.g. "IDR 84.2M".
// Matches money()'s currency-code convention so the Insights view reads the
// same as the rest of the app. Amounts are in whole currency units (not cents).
function moneyShort(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency || 'IDR', currencyDisplay: 'code', notation: 'compact', maximumFractionDigits: 1
    }).format(amount || 0);
  } catch { return `${currency || ''} ${Number(amount || 0).toLocaleString()}`; }
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
// The time zone to render dates in: the signed-in user's region default (set in
// Settings → Currency & time zone), falling back to Jakarta before login / for
// All-regions accounts.
function regionTimezone() {
  return (state.user && state.user.timezone) || 'Asia/Jakarta';
}
// The region's default currency (Settings → Currency & time zone). Used to stamp
// new claims; falls back to IDR before login / for All-regions accounts.
function regionCurrency() {
  return (state.user && state.user.currency) || 'IDR';
}
// A time zone's current UTC offset as "GMT+7", for display labels. Returns ''
// if the runtime can't produce a short offset (older engines) so callers can
// simply omit the label.
function tzOffsetLabel(tz) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName');
    return part ? part.value : '';
  } catch { return ''; }
}
// Render a timestamp in the region's time zone as "YYYY-MM-DD HH:MM GMT+7".
// Server timestamps arrive as UTC ISO strings; anything unparseable falls back
// to a plain trim so we never render "Invalid Date".
function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.replace('T', ' ').slice(0, 16);
  const tz = regionTimezone();
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const zone = tzOffsetLabel(tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${zone ? ' ' + zone : ''}`;
}
// Today's date (YYYY-MM-DD) in the region's time zone — used to default date
// pickers so a late-evening entry doesn't roll to "tomorrow" via UTC.
function todayWIB() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: regionTimezone(), year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
// English status labels — the source of truth for sorting and for the PDF
// (whose font can't render non-Latin scripts). The UI uses statusLabel() so it
// shows the active language instead.
const STATUS_LABEL = { submitted: 'Pending review', approved: 'Approved', rejected: 'Rejected', paid: 'Paid' };
// Cash-advance statuses reuse the four pill colours (base status) but read
// differently. 'paid' on an advance means "disbursed — awaiting realization".
const ADV_STATUS_LABEL = {
  paid: 'Advance paid', realize_submitted: 'Realization pending',
  realize_approved: 'Realization approved', rejected_realize: 'Realization returned',
  settled: 'Settled'
};
const ADV_PILL_BASE = { realize_submitted: 'submitted', realize_approved: 'approved', rejected_realize: 'rejected', settled: 'paid' };
const statusLabel = (s) => t(STATUS_LABEL[s] || s || '');
// Status label that knows the row type (advances relabel some shared statuses).
function statusLabelFor(c) {
  if (c && c.type === 'advance' && ADV_STATUS_LABEL[c.status]) return t(ADV_STATUS_LABEL[c.status]);
  return statusLabel(c ? c.status : '');
}
// CSS pill class for a status — maps advance-only statuses onto a base colour.
const pillClass = (c) => (c && c.type === 'advance' && ADV_PILL_BASE[c.status]) || (c ? c.status : '');

// Group an amount's integer part with thousands separators for readability as
// the user types, e.g. "1000000" → "1,000,000". Commas are stripped again by
// the server's amount parser, so submitting grouped values is safe. A trailing
// decimal part (rare for IDR) is preserved.
function groupAmount(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9.]/g, '');
  if (!s) return '';
  const dot = s.indexOf('.');
  let intp = (dot === -1 ? s : s.slice(0, dot)).replace(/^0+(?=\d)/, '');
  if (intp === '') intp = '0';
  const grouped = intp.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dot === -1 ? grouped : grouped + '.' + s.slice(dot + 1).replace(/\./g, '').slice(0, 2);
}
// Reformat an amount <input> with separators on every keystroke.
function attachAmountGrouping(input) {
  if (!input) return;
  const reformat = () => { input.value = groupAmount(input.value); };
  reformat();
  input.addEventListener('input', reformat);
}

// ---------------------------------------------------------------------------
// Auth / boot
// ---------------------------------------------------------------------------
async function boot() {
  initLangUI();          // populate + wire the language switchers, apply chrome
  try {
    const { user } = await api('/me');
    state.user = user;
    adoptAccountLang(user); // the account's saved language is authoritative
    showApp();
  } catch {
    showLogin();
  }
}

// ---------------------------------------------------------------------------
// Language switching
// ---------------------------------------------------------------------------
// Adopt the language stored on the account (the cross-device default). Called
// after /login and /me: the account wins over the local cache, so signing in on
// a new device switches to the user's saved language.
function adoptAccountLang(user) {
  const lang = user && I18N.normalize(user.language);
  if (lang && lang !== I18N.getLang()) I18N.setLangLocal(lang);
  applyLangChrome();
}

// Re-translate the static chrome (top bar, list head, filters, login) and keep
// both switchers showing the active language.
function applyLangChrome() {
  I18N.applyStatic();
  syncLangSelectors();
  renderLoginHint();
}

function renderLoginHint() {
  const el = $('#loginHint');
  if (el) el.textContent = t('Need an account or forgot your password? Contact your manager');
}

// Fill both <select>s with the language list (labelled by native name) and wire
// their change handlers. The login switcher only affects the local cache; the
// top-bar switcher also persists the choice to the signed-in account.
function initLangUI() {
  const fill = (sel) => {
    if (!sel) return;
    sel.innerHTML = I18N.LANGS.map(l =>
      `<option value="${l.code}">${esc(I18N.NATIVE[l.code] || l.label)}</option>`).join('');
    sel.value = I18N.getLang();
    // These selects are upgraded to the custom dropdown; nudge its trigger to
    // reflect the freshly-filled options/value (a programmatic .value = fires no change).
    if (sel._mselRefresh) sel._mselRefresh();
  };
  const login = $('#loginLang'), top = $('#topLang');
  fill(login); fill(top);
  if (login) login.addEventListener('change', () => {
    I18N.setLangLocal(login.value);
    applyLangChrome();
  });
  if (top) top.addEventListener('change', () => changeLanguage(top.value));
  applyLangChrome();
}

function syncLangSelectors() {
  const cur = I18N.getLang();
  const login = $('#loginLang'), top = $('#topLang');
  if (login && login.value !== cur) { login.value = cur; if (login._mselRefresh) login._mselRefresh(); }
  if (top && top.value !== cur) { top.value = cur; if (top._mselRefresh) top._mselRefresh(); }
}

// A signed-in user picks a language: apply it instantly (chrome + whatever view
// is open), then persist it to their account so it becomes their default across
// devices. The account save is best-effort — the local switch already happened.
async function changeLanguage(code) {
  const next = I18N.normalize(code);
  I18N.setLangLocal(next);
  applyLangChrome();
  rerenderDynamic();
  try {
    const { user } = await api('/me', { method: 'PUT', body: JSON.stringify({ language: next }) });
    if (user) state.user = { ...state.user, ...user };
    toast(t('Language updated'));
  } catch (ex) { toast(ex.message, true); }
}

// Re-render the dynamic view currently on screen so its generated text picks up
// the new language. Modals and the drawer overlay the top-bar switcher, so only
// the home / list / insights surfaces can be visible when this runs.
function rerenderDynamic() {
  if (!state.user) return;
  renderHome();
  if (state.view === 'insights') { if (state.insights.data) renderInsights(); }
  else if (state.view && state.view !== 'home') {
    const title = $('#listTitle');
    if (title) title.textContent = viewLabel(state.view);
    renderClaims();
  }
}

function showLogin() {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginForm').hidden = false;
  renderLoginHint();
}

// Client mirrors of the server capability checks (userCan / canMarkPaid). caps
// is the per-role matrix sent with the user; superadmin implicitly holds all.
function uCan(cap) {
  const u = state.user;
  return !!(u && (u.role === 'superadmin' || (u.caps && u.caps[cap])));
}
function canPay(u) {
  return !!(u && (u.role === 'superadmin' || u.can_mark_paid || (u.caps && u.caps.mark_paid)));
}
// Advance oversight: Finance and CM/MD (admin) roles, plus super admin (who sits
// above them) and Finance-AP (anyone who records payments — canPay). These track
// every cash advance's disbursement vs settlement, so the Realized/Unrealized
// tiles show them ALL advances and are always visible; everyone else sees only
// their own, gated on advance access.
function seesAllAdvances(u) {
  return !!(u && (u.role === 'admin' || u.role === 'finance' || canPay(u)));
}
// All-region viewers (Super Admins, VPs and '*' accounts) see every region and
// get the top-bar region picker to narrow the view. Mirrors the server's
// seesAllRegions. Region-locked accounts only ever see their own region.
function seesAllRegionsUI(u) {
  return !!(u && (u.role === 'superadmin' || u.role === 'vp' || u.region === '*'));
}
// Top-bar region picker: populate its options and toggle visibility for the
// signed-in user. All-region viewers pick "All regions" or a single region; the
// choice scopes the home tiles, claim lists and insights. Hidden for everyone
// else. Called on login (visibility) and after lookups load (to fill options).
function renderRegionPicker() {
  const wrap = $('#regionPicker');
  const sel = $('#regionSelect');
  if (!wrap || !sel) return;
  const show = seesAllRegionsUI(state.user);
  wrap.hidden = !show;
  if (!show) return;
  const cur = state.viewRegion || '';
  sel.innerHTML = `<option value="">${esc(t('All regions'))}</option>`
    + (state.lookups.regions || []).map(r =>
        `<option value="${esc(r)}"${r === cur ? ' selected' : ''}>${esc(r)}</option>`).join('');
  sel.value = cur;
  // The select is upgraded to the custom dropdown; refresh its trigger label.
  if (sel._mselRefresh) sel._mselRefresh();
}
// Switching region re-scopes the whole dashboard: reload the ledger (which also
// refreshes the home tiles + summary cards) and, if Insights is open, refetch it.
$('#regionSelect').addEventListener('change', (e) => {
  state.viewRegion = e.target.value || '';
  loadClaims();
  if (!$('#insightsView').hidden) loadInsights();
});
// Role ladder, most senior → most junior. Mirrors the server's ROLES.
const ROLES_ORDER = ['superadmin', 'vp', 'admin', 'manager', 'lowmgmt', 'finance', 'employee'];
// Roles the signed-in user may assign when creating an account: every role
// strictly below their own (super admins get all but superadmin here; they use
// the full list directly in the form). Mirrors the server's creatableRolesFor.
function creatableRoles() {
  const u = state.user;
  if (!u) return [];
  const i = ROLES_ORDER.indexOf(u.role);
  return i < 0 ? [] : ROLES_ORDER.slice(i + 1);
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  const u = state.user;
  // Role is intentionally not shown in the UI after login.
  $('#userBadge').innerHTML = `${esc(u.full_name)}`;
  // "Purpose" buttons are gated per department + job position (see Settings).
  const purposes = u.purposes || { claim: false, meal: false, advance: false };
  $('#newClaimBtn').hidden = !purposes.claim;
  $('#newMealBtn').hidden = !purposes.meal;
  $('#newAdvanceBtn').hidden = !purposes.advance;
  // Light up a "draft waiting" dot on any New button that has a saved draft.
  refreshDraftBadges();
  const isSuper = u.role === 'superadmin';
  // Buttons follow the role-capability matrix (Settings → Roles).
  $('#exportBtn').hidden = !uCan('export_csv');
  // Settings opens for super admins, VP / CM/MD (who always get the Roles tab), or
  // anyone who can manage settings.
  $('#settingsBtn').hidden = !(isSuper || u.role === 'vp' || u.role === 'admin' || uCan('manage_settings'));
  // "Manage accounts": shown to non-superadmins who may manage their team's
  // accounts (reset password / enable-disable) OR who hold the create_accounts
  // capability (so the delegated "+ Add user" form is reachable). Superadmins use
  // full Settings instead.
  $('#accountsBtn').hidden = !(!isSuper && (u.can_manage_accounts || uCan('create_accounts')));
  // Deleting claims (used to clear out test data) follows the matrix.
  $('#deleteSelBtn').hidden = !uCan('delete_claims');
  // Bulk "Mark as paid" / "Revert payment" — both shown to anyone who may
  // record payments.
  $('#markPaidSelBtn').hidden = !canPay(u);
  $('#revertPaidSelBtn').hidden = !canPay(u);
  // Land on the clean menu; a tile opens the corresponding list. Reset the
  // Insights view and its state too — this runs on every login, and in the SPA a
  // logout→login in the same tab must never leave the previous user's Insights
  // (data scoped to *them*) on screen for the next account.
  state.view = 'home';
  $('#homeView').hidden = false;
  $('#listView').hidden = true;
  $('#insightsView').hidden = true;
  state.insights = { year: '', month: '', department: '', db: '', name: '', status: 'approved,paid', trend: 'month', drill: null, data: null };
  // Reset the region scope on every login so a same-tab account switch never
  // carries the previous user's chosen region; then show/hide + fill the picker.
  state.viewRegion = '';
  renderRegionPicker();
  loadLookups();
  loadAll(); // populates state.claims, then renderHome fills in the menu + badge
}

// Show/hide password toggle for any .pw-toggle button next to a password input.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle');
  if (!btn) return;
  const input = btn.parentElement.querySelector('input');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

// Active departments + expense types drive the claim form dropdowns.
async function loadLookups() {
  try {
    const [d, e, r] = await Promise.all([api('/departments'), api('/expense-types'), api('/regions')]);
    // Lookups come scoped to the signed-in user's region; an All-regions account
    // gets every region's rows, so de-duplicate names for the pickers.
    const uniqNames = (items) => [...new Set((items || []).filter(i => i.active).map(i => i.name))];
    state.lookups.departments = uniqNames(d.items);
    state.lookups.expense_types = uniqNames(e.items);
    state.lookups.regions = uniqNames(r.items);
    // Now that the region list is known, fill the top-bar picker's options.
    renderRegionPicker();
  } catch { /* form falls back to free text */ }
  // The claim-date policy gates how old an expense may be; the form uses it to
  // set the date picker's min and to validate before submit.
  try { state.claimLimit = await api('/claim-window'); } catch { /* no limit enforced client-side */ }
  // Preset meal-allowance amounts for the meal form's Amount dropdown.
  try { state.mealRates = (await api('/meal-rates')).rates || []; } catch { state.mealRates = []; }
}
// The earliest expense date a claim may carry, or '' when unrestricted.
const claimEarliest = () => (state.claimLimit && state.claimLimit.earliest) || '';
// A small note under a date field stating the policy floor (blank when none).
function claimLimitNote() {
  const e = claimEarliest();
  return e ? `<p class="form-note" style="margin-top:4px">${esc(t('Only expenses dated {date} or later can be claimed.', { date: e }))}</p>` : '';
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginError'); err.hidden = true;
  const fd = new FormData(e.target);
  try {
    const { user } = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
    });
    state.user = user;
    e.target.reset();
    adoptAccountLang(user);
    showApp();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch { /* clear the session locally regardless */ }
  // Hard reload on sign-out rather than a client-side view swap. This wipes all
  // in-memory DOM/state so nothing from the previous account (e.g. their Insights
  // charts) can linger into the next login, and it guarantees the next session
  // loads the latest app.js instead of running a stale bundle in the same tab.
  window.location.replace('/');
});
$('#backHome').addEventListener('click', goHome);

// Manual refresh: reload the ledger so statuses reflect any decisions made
// elsewhere since the view was opened. Spins the icon while fetching and stamps
// the time it last synced.
const refreshBtn = $('#refreshBtn');
if (refreshBtn) refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('is-loading');
  try { await loadClaims(); }
  catch (ex) { /* surfaced by api()'s own error handling */ }
  finally { refreshBtn.classList.remove('is-loading'); }
});

// Show when the ledger was last synced, next to the Refresh button.
function stampRefreshed() {
  const el = $('#refreshStamp');
  if (!el) return;
  const now = new Date();
  el.textContent = t('Updated {time}', { time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Load + render
// ---------------------------------------------------------------------------
async function loadAll() {
  // The summary cards are derived from the loaded claims (see renderSummaryCards
  // in renderClaims), so loading the claims is all that's needed.
  await loadClaims();
}

// True when any filter narrows the ledger away from the full set.
function anyFilterActive() {
  const f = state.filters;
  return !!(f.status || f.department || f.q || f.claimant);
}

const totalCardLabel = () => anyFilterActive() ? t('Filtered total') : t('Total value');

// The summary cards describe exactly the rows currently in view, so they track
// every active filter (status, department, search, claimant). Both claim types
// share one ledger, so visibleClaims already spans reimbursement + meal.
function renderSummaryCards() {
  const claims = visibleClaims();
  const count = st => claims.filter(c => c.status === st).length;
  const total = claims.reduce((sum, c) => sum + Number(rowView(c).amount || 0), 0);
  // status key doubles as the filter value; the total card is display-only.
  const cards = [
    { k: 'submitted', l: t('Pending'), n: count('submitted'), status: 'submitted' },
    { k: 'approved', l: t('Approved'), n: count('approved'), status: 'approved' },
    { k: 'rejected', l: t('Rejected'), n: count('rejected'), status: 'rejected' },
    { k: 'paid', l: t('Paid'), n: count('paid'), status: 'paid' },
    // Headline reads compact (e.g. IDR 123.3M) so it fits on one line even at
    // billions; the exact figure sits just below for anyone who needs it.
    { k: 'total', l: totalCardLabel(), n: moneyShort(total, regionCurrency()), sub: money(total, regionCurrency()) }
  ];
  $('#summaryCards').innerHTML = cards.map(c => {
    if (!c.status) {
      const sub = c.sub ? `<div class="card-sub">${esc(c.sub)}</div>` : '';
      return `<div class="card ${c.k}"><div class="card-n">${esc(c.n)}</div>${sub}<div class="card-l">${esc(c.l)}</div></div>`;
    }
    const active = state.filters.status === c.status;
    const hint = active ? t('Clear {label} filter', { label: c.l }) : t('Show only {label} claims', { label: c.l });
    return `<div class="card ${c.k} card-filter${active ? ' active' : ''}" data-status="${c.status}"
      role="button" tabindex="0" aria-pressed="${active}" title="${esc(hint)}">
      <div class="card-n">${esc(c.n)}</div><div class="card-l">${esc(c.l)}</div></div>`;
  }).join('');
  $$('.card-filter', $('#summaryCards')).forEach(el => {
    const toggle = () => setStatusFilter(el.dataset.status);
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

// Clicking a status card filters the ledger to that status; clicking the
// already-active card clears it. Keeps the status dropdown in sync.
function setStatusFilter(status) {
  state.filters.status = state.filters.status === status ? '' : status;
  const sel = $('#statusFilter');
  if (sel) { sel.value = state.filters.status; if (sel._mselRefresh) sel._mselRefresh(); }
  loadClaims();
}

async function loadClaims() {
  const p = new URLSearchParams();
  if (state.filters.status) p.set('status', state.filters.status);
  if (state.filters.department) p.set('department', state.filters.department);
  if (state.filters.q) p.set('q', state.filters.q);
  // All-region viewers may scope the ledger (and thus the home tiles) to one region.
  if (state.viewRegion) p.set('region', state.viewRegion);
  const qs = p.toString();
  // Reimbursement + meal allowance claims share one ledger. Tag each with a
  // type so rows, the drawer, and actions can branch to the right endpoints.
  const [r, m, a] = await Promise.all([api('/claims?' + qs), api('/meal-claims?' + qs), api('/cash-advances?' + qs)]);
  const reimb = (r.claims || []).map(c => ({ ...c, type: 'reimbursement' }));
  const meal = (m.claims || []).map(c => ({ ...c, type: 'meal' }));
  const adv = (a.claims || []).map(c => ({ ...c, type: 'advance' }));
  state.claims = [...reimb, ...meal, ...adv].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  // Drop selections for claims no longer in the current view.
  const avail = new Set(state.claims.map(c => claimKey(c.type, c.id)));
  [...state.selected].forEach(k => { if (!avail.has(k)) state.selected.delete(k); });
  renderDeptOptions();
  renderClaimantOptions();
  renderClaims();
  renderHome(); // keep the landing menu counts / approval badge in sync
  stampRefreshed();
}

// Uniform row display fields for the two claim types.
function rowView(c) {
  if (c.type === 'meal') {
    const first = (c.lines && c.lines[0] && c.lines[0].line_date) || (c.created_at || '').slice(0, 10);
    // Meal claims carry a "DB number site" per line; surface the first one.
    const site = (c.lines && c.lines[0] && c.lines[0].site) || '';
    return { typeLabel: t('Meal allowance'), date: first, amount: c.total_amount, db: site };
  }
  if (c.type === 'advance') {
    // The ledger amount is the requested/disbursed advance; the date is when it
    // was requested (an advance has no single expense date).
    return { typeLabel: t('Cash advance'), date: (c.created_at || '').slice(0, 10), amount: c.amount, db: '' };
  }
  return { typeLabel: c.expense_type, date: c.expense_date, amount: c.amount, db: c.db_no || '' };
}

function renderDeptOptions() {
  const sel = $('#deptFilter');
  const current = sel.value;
  const depts = [...new Set(state.claims.map(c => c.department).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All departments</option>' +
    depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  sel.value = current;
  if (sel._mselRefresh) sel._mselRefresh();
}

// Claimant dropdown mirrors the department one; filtering is applied client-side
// (see renderClaims) since the full set is already loaded.
function renderClaimantOptions() {
  const sel = $('#claimantFilter');
  const names = [...new Set(state.claims.map(c => c.claimant_name).filter(Boolean))].sort();
  // Drop a stale selection if that claimant no longer has any claims.
  if (state.filters.claimant && !names.includes(state.filters.claimant)) state.filters.claimant = '';
  sel.innerHTML = '<option value="">All claimants</option>' +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = state.filters.claimant;
  if (sel._mselRefresh) sel._mselRefresh();
}

// Replace a native <select> with a modern custom dropdown. The native element
// stays in the DOM (visually hidden) so its value + change events keep driving
// the existing filter logic; the custom UI just mirrors and updates it. Reads
// options live, so dynamically-populated selects work. Adds a search box once a
// list grows past 8 items (handy for the 100+ claimants).
function enhanceSelect(sel) {
  if (!sel || sel.dataset.msel) return;
  sel.dataset.msel = '1';
  const wrap = document.createElement('div');
  wrap.className = 'msel';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('msel-native');
  sel.setAttribute('tabindex', '-1'); sel.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'msel-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'msel-menu'; menu.setAttribute('role', 'listbox'); menu.hidden = true;
  // The menu is portaled onto <body> only while open (see open/close) so no
  // scrolling table or transformed modal can clip it; it's fixed-positioned
  // against the trigger and removed on close to avoid orphaned nodes.
  wrap.appendChild(trigger);

  let activeIdx = -1;
  // A long list gets a search box automatically; `data-search="always"` forces
  // one even for short lists (e.g. the employee filter, where typing a name is
  // the point regardless of how many people currently have expenses).
  // `data-freetext="always"` makes it a hybrid: besides the listed options, the
  // typed text can be committed as-is (a partial-name filter), and always shows
  // a search box.
  const freetext = () => sel.dataset.freetext === 'always';
  const searchable = () => sel.dataset.search !== 'never'
    && (freetext() || sel.dataset.search === 'always' || sel.options.length > 8);
  const refreshTrigger = () => {
    const o = sel.options[sel.selectedIndex];
    const placeholder = sel.selectedIndex <= 0 && !sel.value;
    // Optional leading icon (data-icon="🌐") — used by the compact top-bar
    // language / region pickers so they keep their glyph while using this menu.
    const icon = sel.dataset.icon ? `<span class="msel-icon" aria-hidden="true">${esc(sel.dataset.icon)}</span>` : '';
    trigger.innerHTML = icon + `<span class="msel-val${placeholder ? ' placeholder' : ''}">${esc(o ? o.textContent : '')}</span>`;
  };
  const optsBox = () => menu.querySelector('.msel-opts');
  const renderOpts = (filter) => {
    const raw = String(filter || '').trim();
    const f = raw.toLowerCase();
    const matches = [...sel.options].filter(o => !f || o.textContent.toLowerCase().includes(f));
    let html = matches.map(o =>
      `<div class="msel-opt${o.value === sel.value ? ' sel' : ''}" role="option" data-val="${esc(o.value)}" aria-selected="${o.value === sel.value}"><span class="msel-lab">${esc(o.textContent)}</span><span class="msel-check" aria-hidden="true">✓</span></div>`).join('');
    // Hybrid: offer the typed text itself as a filter value, unless it already
    // matches a listed option exactly.
    if (freetext() && raw && !matches.some(o => o.textContent.toLowerCase() === f)) {
      html = `<div class="msel-opt msel-free" role="option" data-free="1" data-val="${esc(raw)}"><span class="msel-lab">${esc(t('Search for “{q}”', { q: raw }))}</span></div>` + html;
    }
    optsBox().innerHTML = html || `<div class="msel-empty">${esc(t('No matches'))}</div>`;
    activeIdx = -1;
  };
  const optEls = () => [...menu.querySelectorAll('.msel-opt')];
  const setActive = (i) => {
    const els = optEls(); if (!els.length) return;
    activeIdx = (i + els.length) % els.length;
    els.forEach((e, idx) => e.classList.toggle('active', idx === activeIdx));
    els[activeIdx].scrollIntoView({ block: 'nearest' });
  };
  const onDocDown = (e) => { if (!wrap.contains(e.target) && !menu.contains(e.target)) close(); };
  // Anchor the fixed menu under (or above, if short on space) the trigger.
  // The menu grows to fit its widest option (so long names / DB numbers show in
  // full) but never shrinks below the trigger, and stays on-screen. Re-run on
  // scroll/resize while open.
  const place = () => {
    // The whole UI runs at :root { zoom }, which scales this body-portaled menu
    // too. getBoundingClientRect(), innerWidth/innerHeight are all in VISUAL
    // (post-zoom) px, but a CSS length set on the menu is multiplied by the zoom
    // when rendered — so left/top/size we assign must be divided by the zoom to
    // land where getBoundingClientRect says. offsetWidth/Height are in the menu's
    // own (zoomed) units, so multiply them back up to compare in visual px.
    // Without this the menu lands up-and-left of its field. Reduces to the plain
    // math when zoom is 1.
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const r = trigger.getBoundingClientRect();
    menu.style.width = 'auto';
    menu.style.minWidth = (r.width / z) + 'px';
    menu.style.maxWidth = (Math.min(440, window.innerWidth - 16) / z) + 'px';
    const mw = menu.offsetWidth * z;
    const left = Math.min(Math.round(r.left), window.innerWidth - 8 - mw);
    menu.style.left = (Math.max(8, left) / z) + 'px';
    menu.style.top = ((r.bottom + 5) / z) + 'px';
    menu.style.maxHeight = '';
    const mh = menu.offsetHeight * z;
    const below = window.innerHeight - r.bottom - 10;
    const above = r.top - 10;
    if (mh > below && above > below) {
      const h = Math.min(mh, above);
      menu.style.maxHeight = (h / z) + 'px';
      menu.style.top = ((r.top - h - 5) / z) + 'px';
    } else if (mh > below) {
      menu.style.maxHeight = (below / z) + 'px';
    }
  };
  const onScroll = () => { if (!trigger.isConnected) { close(); return; } place(); };
  const onKey = (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const els = optEls();
      if (activeIdx >= 0 && els[activeIdx]) commitEl(els[activeIdx]);
      else if (freetext()) { const inp = menu.querySelector('.msel-input'); const v = inp ? inp.value.trim() : ''; if (v) chooseFree(v); }
    }
  };
  function open() {
    if (!menu.hidden) return;
    menu.innerHTML = (searchable() ? `<div class="msel-search"><input type="text" class="msel-input" placeholder="${esc(t('Search…'))}" aria-label="${esc(t('Search…'))}"></div>` : '') + `<div class="msel-opts"></div>`;
    renderOpts('');
    document.body.appendChild(menu);
    menu.hidden = false; wrap.classList.add('open'); trigger.setAttribute('aria-expanded', 'true');
    place();
    const inp = menu.querySelector('.msel-input');
    if (inp) { inp.addEventListener('input', () => renderOpts(inp.value)); setTimeout(() => inp.focus(), 0); }
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }
  function close() {
    if (menu.hidden) return;
    menu.hidden = true; wrap.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false');
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  }
  function choose(val) {
    if (sel.value !== val) { sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    refreshTrigger(); close(); trigger.focus();
  }
  // Commit a free-typed value: back it with a real <option> (a select can only
  // hold values it owns), pruning any earlier synthetic one, then select it.
  function chooseFree(text) {
    const v = String(text).trim();
    if (!v) return;
    [...sel.options].forEach(o => { if (o.dataset.free === '1' && o.value !== v) o.remove(); });
    if (![...sel.options].some(o => o.value === v)) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v; opt.dataset.free = '1';
      sel.appendChild(opt);
    }
    choose(v);
  }
  const commitEl = (o) => (o.dataset.free === '1' ? chooseFree(o.dataset.val) : choose(o.dataset.val));
  trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
  trigger.addEventListener('keydown', (e) => {
    if (menu.hidden && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); setActive(0); }
  });
  menu.addEventListener('click', (e) => { const o = e.target.closest('.msel-opt'); if (o) commitEl(o); });
  sel.addEventListener('change', refreshTrigger);
  sel._mselRefresh = refreshTrigger;
  refreshTrigger();
}

// Is it currently THIS user's turn to approve claim c? (The pending approver at
// the current step.) Role-agnostic: a super admin only matches claims where
// they are explicitly the current approver, not every claim.
function isMyTurn(c) {
  // A cash advance awaits an approver in either the request ('submitted') or the
  // realization ('realize_submitted') cycle.
  const awaiting = c.status === 'submitted' || (c.type === 'advance' && c.status === 'realize_submitted');
  if (!state.user || !awaiting) return false;
  const ids = (c.approvers || []).map(a => a.id);
  if (!ids.length) return false;
  return ids[(c.current_step || 1) - 1] === state.user.id;
}
const myClaims = () => state.claims.filter(c => c.employee_id === (state.user && state.user.id));
const approvalQueue = () => state.claims.filter(isMyTurn);

// Claims I have already approved and can still revert (undo my approval).
// After I approve, a claim leaves my "Needs my approval" queue, so this is where
// I find it again if I approved by mistake. Mirrors the server's planRevert for
// the two "I approved this" cases: a submitted claim that has advanced past me
// (I signed off the immediately-previous step), or a fully approved claim where
// I was the final approver. Role-agnostic, like isMyTurn.
function approvedByMe(c) {
  if (!state.user) return false;
  const uid = state.user.id;
  const ids = (c.approvers || []).map(a => a.id);
  const step = c.current_step || 0;
  if (c.status === 'submitted' && step > 1) return ids[step - 2] === uid;
  if (c.status === 'approved') return c.manager_id === uid;
  // Cash-advance realization cycle mirrors the same two "I approved this" cases.
  if (c.type === 'advance' && c.status === 'realize_submitted' && step > 1) return ids[step - 2] === uid;
  if (c.type === 'advance' && c.status === 'realize_approved') return c.manager_id === uid;
  return false;
}
const approvedByMeQueue = () => state.claims.filter(approvedByMe);

// Every claim that came into my queue and that I actually decided on — approved
// (at any step) or rejected — regardless of where the claim sits now. Derived
// from the claim's own history (actions logged against my user id), so it stays
// correct after the claim advances, gets paid, or is reverted. This is a
// read-only record of my decisions; the row's status column shows each claim's
// current state, so a Refresh reflects any change others have made since.
function reviewedByMe(c) {
  if (!state.user) return false;
  const uid = state.user.id;
  return (c.history || []).some(h =>
    h.actor_id === uid && /\b(approved|rejected)\b/.test(String(h.action)));
}
const reviewedByMeQueue = () => state.claims.filter(reviewedByMe);

// Claims already marked as paid — the payer's revert queue. A can_mark_paid
// account (Finance AP) sits in the approver chain, so paid claims it recorded
// stay visible in state.claims; this surfaces them so a mistaken payment can be
// reverted (canRevert lets the payer unpay any paid claim).
const paidQueue = () => state.claims.filter(c => c.status === 'paid');

// Cash-advance realization tiles. A disbursed advance ('paid') is UNREALIZED
// until its realization is approved; once approved (and through settlement) it
// is REALIZED. A returned realization ('rejected_realize') is still unrealized
// (the claimant must resubmit). Request-stage advances (submitted/approved/
// rejected — not yet disbursed) belong to the claim queues, not here.
const ADV_UNREALIZED = ['paid', 'realize_submitted', 'rejected_realize'];
const ADV_REALIZED = ['realize_approved', 'settled'];
// Oversight roles see every advance; everyone else only their own.
function advanceScope() {
  const u = state.user;
  const all = seesAllAdvances(u);
  return state.claims.filter(c => c.type === 'advance' && (all || c.employee_id === (u && u.id)));
}
const unrealizedQueue = () => advanceScope().filter(c => ADV_UNREALIZED.includes(c.status));
const realizedQueue = () => advanceScope().filter(c => ADV_REALIZED.includes(c.status));

// Claims for the open view, before the client-side claimant filter.
function viewClaims() {
  if (state.view === 'mine') return myClaims();
  if (state.view === 'approval') return approvalQueue();
  if (state.view === 'approved') return approvedByMeQueue();
  if (state.view === 'reviewed') return reviewedByMeQueue();
  if (state.view === 'paid') return paidQueue();
  if (state.view === 'unrealized') return unrealizedQueue();
  if (state.view === 'realized') return realizedQueue();
  return state.claims; // 'all' / 'home'
}

// Rows currently shown, after the client-side claimant filter.
function visibleClaims() {
  const cl = state.filters.claimant;
  const base = viewClaims();
  return cl ? base.filter(c => c.claimant_name === cl) : base;
}

// --- Home menu (clean landing) ----------------------------------------------
// English source maps; viewLabel()/viewEmpty() translate at render time so a
// language switch updates them without reloading the constant.
const VIEW_LABEL = { mine: 'My claims', approval: 'Needs my approval', approved: 'Approved by me', reviewed: 'Reviewed by me', paid: 'Paid claims', unrealized: 'Unrealized cash advances', realized: 'Realized cash advances', all: 'All activities' };
const VIEW_EMPTY = {
  mine: 'You have not submitted any claims yet.',
  approval: 'Nothing is waiting for your approval right now.',
  approved: 'You have not approved any claims that are still open to revert.',
  reviewed: 'No claims have come to you for a decision yet.',
  paid: 'No claims have been marked as paid yet.',
  unrealized: 'No cash advances are awaiting realization right now.',
  realized: 'No cash advances have had their realization approved yet.',
  all: 'No claims in the system yet.'
};
const viewLabel = (k) => t(VIEW_LABEL[k] || 'Claims');
const viewEmpty = (k) => t(VIEW_EMPTY[k] || 'No claims yet.');
function renderHome() {
  const menu = $('#homeMenu');
  if (!menu || !state.user) return;
  const u = state.user;
  $('#homeGreeting').textContent = u.full_name ? t('Hi {name} — what would you like to open?', { name: u.full_name.split(' ')[0] }) : '';
  const need = approvalQueue().length;
  const mine = myClaims().length;
  const approved = approvedByMeQueue().length;
  const reviewed = reviewedByMeQueue().length;
  // Am I an approver on any claim? Gates the approver-facing "Reviewed by me"
  // tile so pure submitters (never in an approval chain) don't see an empty one.
  const iAmApprover = state.claims.some(c => (c.approvers || []).some(a => a.id === u.id));
  const tiles = [
    { key: 'mine', title: t('My claims'), desc: t('Claims you have submitted'), count: mine },
    { key: 'approval', title: t('Needs my approval'), desc: t('Claims waiting for your decision'), count: need, badge: true },
    // The revert safety net: claims I signed off that I can still undo. Shown
    // alongside "Needs my approval" (both are approver-facing) so a mis-approval
    // is always one click away from being reverted.
    { key: 'approved', title: t('Approved by me'), desc: t('Claims you approved — revert if needed'), count: approved }
  ];
  // The full decision record: every claim that came to me and that I approved or
  // rejected, with each row showing the claim's current status.
  if (iAmApprover || reviewed) {
    tiles.push({ key: 'reviewed', title: t('Reviewed by me'), desc: t('Claims you approved or rejected'), count: reviewed });
  }
  // Finance AP (can_mark_paid) needs a home for claims already marked paid, so a
  // mistaken payment can be found and reverted. Same permission gate as the
  // "Mark as paid" / unpay actions.
  if (canPay(u)) {
    tiles.push({ key: 'paid', title: t('Paid claims'), desc: t('Claims marked as paid — revert if needed'), count: paidQueue().length });
  }
  // Cash-advance realization tiles: disbursed-but-unrealized vs realized. Finance
  // and CM/MD (which track disbursement vs settlement across everyone) always see
  // them; other users only when cash advance is part of their menu, scoped to own.
  if (seesAllAdvances(u) || (u.purposes && u.purposes.advance)) {
    tiles.push({ key: 'unrealized', title: t('Unrealized cash advances'), desc: t('Advances paid — awaiting realization'), count: unrealizedQueue().length });
    tiles.push({ key: 'realized', title: t('Realized cash advances'), desc: t('Advances with realization approved'), count: realizedQueue().length });
  }
  if (uCan('view_all_claims')) tiles.push({ key: 'all', title: t('All activities'), desc: t('Every claim in the system'), count: state.claims.length });
  // Insights is gated to Supervisor-and-above plus all of Finance (see
  // insightsCanView on the server). Among those, the backend scopes the data:
  // company-wide for super admins / Finance / GM-and-above, own department for
  // everyone else.
  if (u.can_view_insights) {
    tiles.push({ key: 'insights', title: t('Insights'), desc: t('Expense trends by type, month and year'), link: t('View charts') });
  }
  menu.innerHTML = tiles.map(tile => `
    <button class="home-tile${tile.key === 'insights' ? ' home-tile-insights' : ''}" data-view="${tile.key}" type="button">
      ${tile.badge && tile.count > 0 ? `<span class="tile-badge" aria-label="${esc(t('{count} awaiting approval', { count: tile.count }))}">${tile.count > 99 ? '99+' : tile.count}</span>` : ''}
      <span class="tile-title">${esc(tile.title)}</span>
      <span class="tile-desc">${esc(tile.desc)}</span>
      <span class="tile-count">${tile.link ? esc(tile.link) + ' →' : esc(tile.count === 1 ? t('{n} claim', { n: tile.count }) : t('{n} claims', { n: tile.count }))}</span>
    </button>`).join('');
  $$('.home-tile', menu).forEach(el => el.addEventListener('click', () => {
    const v = el.dataset.view;
    if (v === 'insights') openInsights(); else openView(v);
  }));
}

// Open one list view; go back to the clean menu.
function openView(key) {
  state.view = key;
  state.selected.clear();
  $('#homeView').hidden = true;
  $('#listView').hidden = false;
  $('#listTitle').textContent = viewLabel(key);
  renderClaims();
}
function goHome() {
  state.view = 'home';
  // Clean slate: clear filters so the menu counts reflect everything.
  state.filters = { status: '', department: '', claimant: '', q: '' };
  const si = $('#searchInput'); if (si) si.value = '';
  const sf = $('#statusFilter'); if (sf) { sf.value = ''; if (sf._mselRefresh) sf._mselRefresh(); }
  $('#listView').hidden = true;
  const iv = $('#insightsView'); if (iv) iv.hidden = true;
  $('#homeView').hidden = false;
  loadClaims(); // refetch unfiltered, then renderHome via loadClaims
}

// ---------------------------------------------------------------------------
// Insights (expense charts)
// ---------------------------------------------------------------------------
$('#backHomeInsights').addEventListener('click', goHome);

// Status presets offered in the Insights filter. "Approved + paid" is the
// default — it reflects real outflow (money that's been committed or moved).
const INSIGHT_STATUS_PRESETS = [
  { v: 'approved,paid', l: 'Approved + paid' },
  { v: 'paid', l: 'Paid only' },
  { v: 'approved', l: 'Approved only' },
  { v: 'submitted,approved,paid', l: 'All except rejected' },
  { v: 'submitted,approved,rejected,paid', l: 'All statuses' }
];

function openInsights() {
  state.view = 'insights';
  $('#homeView').hidden = true;
  $('#listView').hidden = true;
  $('#insightsView').hidden = false;
  loadInsights();
}

async function loadInsights() {
  const body = $('#insightsBody');
  body.innerHTML = `<p class="muted" style="padding:28px 4px">${esc(t('Loading…'))}</p>`;
  const f = state.insights;
  const params = new URLSearchParams();
  if (f.year) params.set('year', f.year);
  if (f.month) params.set('month', f.month);
  if (f.department) params.set('department', f.department);
  if (f.db) params.set('db', f.db);
  if (f.name) params.set('name', f.name);
  if (f.status) params.set('status', f.status);
  if (state.viewRegion) params.set('region', state.viewRegion);
  try {
    const data = await api('/insights?' + params.toString());
    state.insights.data = data;
    state.insights.year = data.year || ''; // server may resolve to the latest year
    // Server echoes the month it applied ('' when the chosen month has no data in
    // the resolved year, e.g. after switching years), so mirror it back.
    state.insights.month = data.month || '';
    // Drop a department filter that isn't in this viewer's scope any more.
    if (f.department && !data.departments.includes(f.department)) state.insights.department = '';
    renderInsights();
  } catch (ex) {
    body.innerHTML = `<p class="form-error" style="margin:16px 0">${esc(ex.message)}</p>`;
  }
}

function renderInsights() {
  const d = state.insights.data;
  if (!d) return;
  const f = state.insights;
  const cur = d.currency || 'IDR';
  // A fresh dataset invalidates any open drill-down.
  f.drill = null;

  // Scope note in the header: a chosen department wins; otherwise it reflects the
  // viewer's remit (whole company vs. the claims they approve).
  const scopeEl = $('#insightsScope');
  const remit = d.scope.department
    ? d.scope.department
    : (d.scope.mode === 'all' ? t('Company-wide') : t('Claims you approve'));
  // Lead with the active region when an all-region viewer has narrowed the scope.
  scopeEl.textContent = state.viewRegion ? `${state.viewRegion} · ${remit}` : remit;

  const yearOpts = (d.years.length ? d.years : [d.year])
    .map(y => `<option value="${esc(y)}"${y === d.year ? ' selected' : ''}>${esc(y)}</option>`).join('');
  // Month filter — lists only the months that have data in the selected year.
  const monthNames = I18N.months();
  const monthOpts = [`<option value="">${esc(t('All months'))}</option>`]
    .concat((d.months || []).map(m => {
      const nm = monthNames[parseInt(m, 10) - 1] || m;
      return `<option value="${esc(m)}"${m === d.month ? ' selected' : ''}>${esc(nm)}</option>`;
    })).join('');
  // Period label for the breakdown card's subtitle: month + year, or just year.
  const periodLabel = d.month ? `${monthNames[parseInt(d.month, 10) - 1] || d.month} ${d.year}` : String(d.year);
  const deptOpts = [`<option value="">${esc(t('All departments'))}</option>`]
    .concat(d.departments.map(x => `<option value="${esc(x)}"${x === f.department ? ' selected' : ''}>${esc(x)}</option>`)).join('');
  const statusOpts = INSIGHT_STATUS_PRESETS
    .map(o => `<option value="${o.v}"${o.v === f.status ? ' selected' : ''}>${esc(t(o.l))}</option>`).join('');
  const empList = d.employees || [];
  // A free-typed employee filter (not one of the listed names) is kept as a
  // synthetic option so the active filter still shows after a refetch.
  const nameExtra = (f.name && !empList.includes(f.name))
    ? `<option value="${esc(f.name)}" data-free="1" selected>${esc(f.name)}</option>` : '';
  const nameOpts = `<option value="">${esc(t('All employees'))}</option>` + nameExtra
    + empList.map(x => `<option value="${esc(x)}"${x === f.name ? ' selected' : ''}>${esc(x)}</option>`).join('');
  const dbOpts = [`<option value="">${esc(t('All DB numbers'))}</option>`]
    .concat((d.dbNos || []).map(x => `<option value="${esc(x)}"${x === f.db ? ' selected' : ''}>${esc(dbFmt(x))}</option>`)).join('');

  const k = d.kpis;
  const kpiCards = [
    { l: t('Total spend'), v: moneyShort(k.total_cents / 100, cur) },
    { l: t('Claims'), v: String(k.claims) },
    { l: t('Top category'), v: k.top_type ? `${esc(k.top_type)} <span class="kpi-sub">${k.top_share}%</span>` : '—' },
    { l: t('Avg per claim'), v: k.claims ? moneyShort(k.avg_cents / 100, cur) : '—' }
  ].map(c => `<div class="kpi"><div class="kpi-l">${esc(c.l)}</div><div class="kpi-v">${c.v}</div></div>`).join('');

  $('#insightsBody').innerHTML = `
    <div class="insights-filters">
      <label>${esc(t('Year'))}<select id="inYear" class="input">${yearOpts}</select></label>
      <label>${esc(t('Month'))}<select id="inMonth" class="input" data-search="never">${monthOpts}</select></label>
      ${d.departments.length ? `<label>${esc(t('Department'))}<select id="inDept" class="input">${deptOpts}</select></label>` : ''}
      <label>${esc(t('DB No'))}<select id="inDb" class="input" data-search="always">${dbOpts}</select></label>
      <label>${esc(t('Status'))}<select id="inStatus" class="input">${statusOpts}</select></label>
      <label>${esc(t('Employee'))}<select id="inName" class="input" data-freetext="always">${nameOpts}</select></label>
    </div>
    <div class="insights-kpis">${kpiCards}</div>
    <div class="insights-charts">
      <div class="chart-card">
        <div class="chart-head"><div>
          <div class="chart-title">${esc(t('Spend by expense type'))}</div>
          <div class="chart-sub">${esc(periodLabel)} · ${esc(currentStatusLabel(f.status))} · ${esc(t('Click a type to see its expenses'))}</div>
        </div></div>
        <div id="typeBars" class="type-bars"></div>
      </div>
      <div class="chart-card">
        <div class="chart-head">
          <div>
            <div class="chart-title">${esc(t('Total over time'))}</div>
            <div class="chart-sub" id="trendSub"></div>
          </div>
          <div class="seg" id="trendSeg">
            <button type="button" data-trend="month"${f.trend === 'month' ? ' class="on"' : ''}>${esc(t('Monthly'))}</button>
            <button type="button" data-trend="year"${f.trend === 'year' ? ' class="on"' : ''}>${esc(t('Yearly'))}</button>
          </div>
        </div>
        <div id="trendChart" class="trend-chart"></div>
      </div>
    </div>`;

  renderTypeBars();
  renderTrend();

  // Filters — every one is a dropdown now, so all refetch on change.
  $('#inYear').addEventListener('change', e => { f.year = e.target.value; loadInsights(); });
  $('#inMonth').addEventListener('change', e => { f.month = e.target.value; loadInsights(); });
  const dept = $('#inDept'); if (dept) dept.addEventListener('change', e => { f.department = e.target.value; loadInsights(); });
  $('#inStatus').addEventListener('change', e => { f.status = e.target.value; loadInsights(); });
  $('#inDb').addEventListener('change', e => { const v = e.target.value.trim(); if (v !== f.db) { f.db = v; loadInsights(); } });
  $('#inName').addEventListener('change', e => { const v = e.target.value.trim(); if (v !== f.name) { f.name = v; loadInsights(); } });

  $$('#trendSeg button').forEach(b => b.addEventListener('click', () => {
    if (f.trend === b.dataset.trend) return;
    f.trend = b.dataset.trend;
    $$('#trendSeg button').forEach(x => x.classList.toggle('on', x.dataset.trend === f.trend));
    renderTrend();
  }));
}

function currentStatusLabel(v) {
  const p = INSIGHT_STATUS_PRESETS.find(o => o.v === v);
  return p ? t(p.l) : v;
}

// Horizontal bars for spend-by-type. Long tails past 10 rows fold into "Other".
// Each bar is clickable (pivot-style): it drills into the individual expense
// lines that make up that type. `typeGroups` maps each visible bar to the real
// expense type(s) it stands for (the "Other" bar covers the folded tail).
function renderTypeBars() {
  const d = state.insights.data;
  const cur = d.currency || 'IDR';
  const wrap = $('#typeBars');
  const items = d.byType.slice();
  // A fresh render of the bars starts with no open drill-down (the detail window,
  // if any, was already closed — it blocks the page while open), so clear any
  // stale selection before we paint the highlight below.
  state.insights.drill = null;
  if (!items.length) {
    wrap.innerHTML = `<p class="muted chart-empty">${esc(t('No expenses match these filters.'))}</p>`;
    return;
  }
  // Build the visible bars and, alongside, the label→real-types grouping used by
  // the drill-down. Fold everything past the top 9 into a single "Other" bar.
  let bars;
  if (items.length > 10) {
    const head = items.slice(0, 9).map(x => ({ label: x.type, cents: x.cents, types: [x.type] }));
    const tail = items.slice(9);
    head.push({ label: t('Other'), cents: tail.reduce((s, x) => s + x.cents, 0), types: tail.map(x => x.type) });
    bars = head;
  } else {
    bars = items.map(x => ({ label: x.type, cents: x.cents, types: [x.type] }));
  }
  state.insights.typeGroups = bars;

  const max = Math.max(...bars.map(i => i.cents), 1);
  wrap.innerHTML = bars.map((i, idx) => {
    const pct = Math.max(2, Math.round((i.cents / max) * 100));
    const on = state.insights.drill === i.label;
    return `<button type="button" class="bar-row${on ? ' on' : ''}" data-bar="${idx}"
      aria-pressed="${on ? 'true' : 'false'}" title="${esc(t('Show expenses'))}: ${esc(i.label)}">
      <span class="bar-label">${esc(i.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-val">${esc(moneyShort(i.cents / 100, cur))}</span>
    </button>`;
  }).join('');

  // Clicking a bar opens the drill-down as a modal window over the page. The
  // clicked bar stays highlighted underneath so it's clear which type is open;
  // the highlight is cleared when the window closes (see clearTypeDrill).
  $$('#typeBars .bar-row').forEach(b => b.addEventListener('click', () => {
    const idx = Number(b.dataset.bar);
    const bar = state.insights.typeGroups[idx];
    if (!bar) return;
    state.insights.drill = bar.label;
    $$('#typeBars .bar-row').forEach(x => {
      const on = Number(x.dataset.bar) === idx;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderTypeDetailModal();
  }));
}

// Active column sort for the drill-down table. Default: amount, largest first,
// which matches the server's default row ordering. dir 1 = ascending, -1 = desc.
let typeDetailSort = { key: 'amount', dir: -1 };
// Sort the drill-down rows in place by the active column, tie-breaking on the
// largest amount so equal keys stay in a stable, sensible order.
function sortTypeDetail(rows) {
  const { key, dir } = typeDetailSort;
  const val = {
    name: r => String(r.name || '').toLowerCase(),
    no:   r => String(r.no || '').toLowerCase(),
    date: r => String(r.date || ''),
    db:   r => String(r.db || '').toLowerCase(),
    type: r => String(r.type || '').toLowerCase(),
    amount: r => r.cents,
  }[key] || (r => r.cents);
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return b.cents - a.cents;
  });
}

// Clear the active drill-down: drop the highlighted bar and the selected type.
// Runs whenever the detail window closes (its × / the scrim / Escape), so the
// insights page returns to a clean, un-highlighted state.
function clearTypeDrill() {
  state.insights.drill = null;
  $$('#typeBars .bar-row').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
}

// Drill-down for the selected expense type — the individual expense lines behind
// that bar (employee, date, DB, amount) — shown in a modal window over the
// insights page rather than inline beneath the charts. Sortable by any column;
// each row opens its source claim. Rebuilt in place when a column is re-sorted.
function renderTypeDetailModal() {
  const d = state.insights.data;
  const label = state.insights.drill;
  const bar = (state.insights.typeGroups || []).find(g => g.label === label);
  if (!label || !bar) { closeModal(); return; }

  const cur = d.currency || 'IDR';
  const set = new Set(bar.types);
  const rows = (d.details || []).filter(r => set.has(r.type));
  const total = rows.reduce((s, r) => s + r.cents, 0);
  sortTypeDetail(rows); // apply the active column sort (defaults to amount desc)

  // The "Other" bar spans several types, so it gets an extra Type column.
  const showType = bar.types.length > 1;
  // A clickable header cell that sorts by `key` and shows the active arrow.
  const th = (key, label, numeric) => {
    const on = typeDetailSort.key === key;
    const arrow = on ? (typeDetailSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${numeric ? ' num' : ''}" data-sort="${key}" role="button" tabindex="0" aria-sort="${on ? (typeDetailSort.dir === 1 ? 'ascending' : 'descending') : 'none'}" style="cursor:pointer;user-select:none;white-space:nowrap">${esc(label)}<span class="sort-arrow">${arrow}</span></th>`;
  };
  const body = rows.length ? `
    <div class="type-detail-scroll">
      <table class="pivot-table">
        <thead><tr>
          ${th('name', t('Employee'))}
          ${th('no', t('Doc No'))}
          ${th('date', t('Date'))}
          ${th('db', t('DB No'))}
          ${showType ? th('type', t('Type')) : ''}
          ${th('amount', t('Amount'), true)}
        </tr></thead>
        <tbody>${rows.map(r => `<tr${r.cid ? ` class="row-open" data-cid="${esc(r.cid)}" tabindex="0" role="button" title="${esc(t('Open claim'))}"` : ''}>
          <td>${esc(r.name || '—')}</td>
          <td>${esc(r.no || '—')}</td>
          <td>${esc(r.date || '—')}</td>
          <td>${esc(dbFmt(r.db) || '—')}</td>
          ${showType ? `<td>${esc(r.type || '—')}</td>` : ''}
          <td class="num">${esc(money(r.cents / 100, cur))}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : `<p class="muted chart-empty">${esc(t('No expenses match these filters.'))}</p>`;

  openModal(`
    <div class="modal-head">
      <div>
        <h2>${esc(label)}</h2>
        <p class="muted" style="margin:4px 0 0;font-size:.85rem">${esc(t('{n} expenses', { n: rows.length }))} · ${esc(money(total / 100, cur))}</p>
      </div>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">${body}</div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  // Closing the window (×, scrim, or Escape) all route through closeModal, so
  // hook the highlight cleanup there rather than on the × alone.
  modalCloseHook = clearTypeDrill;
  $('#modal .x-btn').addEventListener('click', closeModal);

  // Clicking (or pressing Enter/Space on) a header sorts by that column; the same
  // header again flips the direction. Amount opens largest-first, text A→Z.
  const applySort = (key) => {
    if (typeDetailSort.key === key) typeDetailSort.dir *= -1;
    else typeDetailSort = { key, dir: key === 'amount' ? -1 : 1 };
    renderTypeDetailModal(); // rebuild the window in place with the new order
  };
  $$('#modal th[data-sort]').forEach(h => {
    h.addEventListener('click', () => applySort(h.dataset.sort));
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applySort(h.dataset.sort); } });
  });

  // Each detail row drills one level further: into the source claim itself. Close
  // this window first so the claim drawer opens cleanly on top of the page.
  // `cid` is prefixed by kind — c=reimbursement, m=meal, a=advance — mirroring
  // the insights SQL, so we split it back into (type, id) for the drawer.
  $$('#modal .row-open').forEach(tr => {
    const open = () => {
      const cid = tr.dataset.cid || '';
      const type = cid[0] === 'm' ? 'meal' : cid[0] === 'a' ? 'advance' : 'reimbursement';
      const id = cid.slice(1);
      if (!id) return;
      // Keep this drill-down window open behind the claim: open the drawer
      // elevated above the modal so closing it returns to the list.
      openDrawer(id, type).then(() => {
        $('#drawer').classList.add('over-modal');
        $('#drawerScrim').classList.add('over-modal');
      }).catch(ex => toast(ex.message, true));
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

// A dependency-free SVG line/area chart for the monthly / yearly trend, with a
// hover tooltip. Inline SVG inherits the theme CSS variables (var(--pine) etc.).
function renderTrend() {
  const d = state.insights.data;
  const cur = d.currency || 'IDR';
  const monthly = state.insights.trend === 'month';
  const monthNames = I18N.months();
  const points = monthly
    ? d.byMonth.map((m, i) => ({ label: monthNames[i], value: m.cents / 100 }))
    : d.byYear.map(y => ({ label: y.year, value: y.cents / 100 }));

  const sub = $('#trendSub');
  if (sub) sub.textContent = monthly ? t('{year} · by month', { year: d.year }) : t('All years');

  const host = $('#trendChart');
  const hasData = points.some(p => p.value > 0);
  if (!points.length || !hasData) {
    host.innerHTML = `<p class="muted chart-empty">${esc(t('No expenses to plot for this period.'))}</p>`;
    return;
  }

  const W = 720, H = 240, padL = 10, padR = 12, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...points.map(p => p.value), 1);
  const n = points.length;
  const xAt = i => padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yAt = v => padT + plotH * (1 - v / max);

  // Three light horizontal gridlines + the baseline.
  let grid = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (plotH * g) / 3;
    grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="grid" />`;
  }
  const line = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
  const area = `M ${xAt(0).toFixed(1)},${(padT + plotH).toFixed(1)} L ${line.split(' ').join(' L ')} L ${xAt(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  // Emphasise the month currently picked in the Month filter (monthly view only).
  const selMo = (monthly && state.insights.month) ? (parseInt(state.insights.month, 10) - 1) : -1;
  const dots = points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="${i === selMo ? 5.5 : 3.5}" class="dot${i === selMo ? ' dot-sel' : ''}" />`).join('');
  const xlabels = points.map((p, i) =>
    `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${esc(p.label)}</text>`).join('');
  // Larger transparent hit targets drive the hover tooltip.
  const hits = points.map((p, i) =>
    `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="16" fill="transparent"
       data-x="${((xAt(i) / W) * 100).toFixed(2)}" data-y="${((yAt(p.value) / H) * 100).toFixed(2)}"
       data-lab="${esc(p.label)}" data-val="${esc(money(p.value, cur))}" class="hit" />`).join('');

  host.innerHTML = `
    <div class="trend-tip" id="trendTip" hidden></div>
    <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="none" role="img"
         aria-label="${monthly ? 'Monthly' : 'Yearly'} expense total for ${esc(d.year)}">
      ${grid}
      <text x="${padL}" y="${padT - 4}" class="ax ax-max">${esc(moneyShort(max, cur))}</text>
      <path d="${area}" class="area" />
      <polyline points="${line}" class="line" />
      ${dots}
      ${xlabels}
      ${hits}
    </svg>`;

  const tip = $('#trendTip');
  $$('#trendChart .hit').forEach(h => {
    h.addEventListener('mouseenter', () => {
      tip.innerHTML = `<span class="tip-lab">${h.dataset.lab}</span><span class="tip-val">${h.dataset.val}</span>`;
      tip.style.left = h.dataset.x + '%';
      tip.style.top = h.dataset.y + '%';
      tip.hidden = false;
    });
    h.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

// Per-column sort value extractors (mirror the ledger columns). Numeric for
// amount; everything else compares as text (with numeric-aware collation so
// "DB 500 309" and claim numbers order naturally).
const SORT_VAL = {
  no: c => c.claim_no || '',
  name: c => c.claimant_name || '',
  db: c => rowView(c).db || '',
  type: c => rowView(c).typeLabel || '',
  date: c => rowView(c).date || '',
  amount: c => Number(rowView(c).amount) || 0,
  status: c => STATUS_LABEL[c.status] || c.status || ''
};
function sortClaims(claims) {
  const { key, dir } = state.sort;
  if (!key || !SORT_VAL[key]) return claims;
  const val = SORT_VAL[key];
  return [...claims].sort((a, b) => {
    const av = val(a), bv = val(b);
    const cmp = (typeof av === 'number' && typeof bv === 'number')
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return cmp * dir;
  });
}
// Reflect the active sort on the header (cursor + ▲/▼ via aria-sort in CSS).
function updateSortIndicators() {
  $$('.ledger-head [data-sort]').forEach(h => {
    if (h.dataset.sort === state.sort.key) h.setAttribute('aria-sort', state.sort.dir === 1 ? 'ascending' : 'descending');
    else h.removeAttribute('aria-sort');
  });
}
$$('.ledger-head [data-sort]').forEach(h => {
  const toggle = () => {
    const key = h.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: 1 };
    updateSortIndicators();
    renderClaims();
  };
  h.addEventListener('click', toggle);
  h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
});

function renderClaims() {
  const wrap = $('#claimRows');
  const claims = sortClaims(visibleClaims());
  if (!claims.length) {
    wrap.innerHTML = '';
    const empty = $('#emptyState');
    empty.textContent = anyFilterActive() ? t('No claims match your filters.') : viewEmpty(state.view);
    empty.hidden = false;
    updateSelectionUI(); renderSummaryCards(); return;
  }
  $('#emptyState').hidden = true;
  wrap.innerHTML = claims.map(c => {
    const v = rowView(c);
    const checked = state.selected.has(claimKey(c.type, c.id)) ? 'checked' : '';
    return `
    <div class="ledger-row" data-id="${c.id}" data-type="${c.type}" tabindex="0" role="button">
      <span class="row-spine ${pillClass(c)}"></span>
      <span class="col-check"><input type="checkbox" class="row-check" data-id="${c.id}" data-type="${c.type}" ${checked} aria-label="Select ${esc(c.claim_no)}" /></span>
      <span class="col-no">${esc(c.claim_no)}</span>
      <span class="col-name">${esc(c.claimant_name)}</span>
      <span class="col-db mono">${esc(dbFmt(v.db)) || '—'}</span>
      <span class="col-type">${esc(v.typeLabel)}</span>
      <span class="col-date mono">${esc(v.date)}</span>
      <span class="col-amt">${esc(money(v.amount, c.currency))}</span>
      <span class="col-status"><span class="pill ${pillClass(c)}">${esc(statusLabelFor(c))}</span></span>
    </div>`; }).join('');
  $$('.ledger-row', wrap).forEach(el => {
    const open = () => openDrawer(el.dataset.id, el.dataset.type);
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  // Checkboxes must not open the drawer; they only drive the selection.
  $$('.col-check', wrap).forEach(cell => cell.addEventListener('click', e => e.stopPropagation()));
  $$('.row-check', wrap).forEach(cb => cb.addEventListener('change', () => {
    const key = claimKey(cb.dataset.type, cb.dataset.id);
    if (cb.checked) state.selected.add(key); else state.selected.delete(key);
    updateSelectionUI();
  }));
  updateSelectionUI();
  renderSummaryCards();
}

// Reflect selection count in the bar and sync the header select-all box.
function updateSelectionUI() {
  const n = state.selected.size;
  $('#selectionBar').hidden = n === 0;
  $('#selCount').textContent = n === 1 ? t('{n} claim selected', { n }) : t('{n} claims selected', { n });
  const boxes = $$('.row-check');
  const all = $('#selectAll');
  if (all) {
    const checkedCount = boxes.filter(b => b.checked).length;
    all.checked = boxes.length > 0 && checkedCount === boxes.length;
    all.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  }
}

// filters
let qTimer;
$('#searchInput').addEventListener('input', e => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); loadClaims(); }, 250);
});
$('#statusFilter').addEventListener('change', e => { state.filters.status = e.target.value; loadClaims(); });
$('#deptFilter').addEventListener('change', e => { state.filters.department = e.target.value; loadClaims(); });
// Claimant filter is client-side, so just re-render (no server round-trip).
$('#claimantFilter').addEventListener('change', e => { state.filters.claimant = e.target.value; renderClaims(); });
// Upgrade every native <select> in the app to the modern custom dropdown —
// including ones added later by dynamic renders (modals, table rows). The
// language + region pickers are enhanced too (they carry data-icon for their
// glyph); opt out only with [data-no-msel].
function enhanceSelectsIn(root) {
  if (!root || root.nodeType !== 1) return;
  const list = root.matches && root.matches('select') ? [root]
    : (root.querySelectorAll ? [...root.querySelectorAll('select')] : []);
  list.forEach(sel => {
    if (sel.dataset.msel || sel.hasAttribute('data-no-msel')) return;
    enhanceSelect(sel);
  });
}
enhanceSelectsIn(document.body);
new MutationObserver(muts => {
  for (const m of muts) for (const node of m.addedNodes) enhanceSelectsIn(node);
}).observe(document.body, { childList: true, subtree: true });

// ---------------------------------------------------------------------------
// Selection + PDF export
// ---------------------------------------------------------------------------
$('#selectAll').addEventListener('change', e => {
  const on = e.target.checked;
  $$('.row-check').forEach(cb => {
    cb.checked = on;
    const key = claimKey(cb.dataset.type, cb.dataset.id);
    if (on) state.selected.add(key); else state.selected.delete(key);
  });
  updateSelectionUI();
});
$('#clearSelBtn').addEventListener('click', () => {
  state.selected.clear();
  $$('.row-check').forEach(cb => { cb.checked = false; });
  updateSelectionUI();
});
$('#genPdfBtn').addEventListener('click', generatePdf);
$('#deleteSelBtn').addEventListener('click', deleteSelected);
$('#markPaidSelBtn').addEventListener('click', markPaidSelected);
$('#revertPaidSelBtn').addEventListener('click', revertPaidSelected);

// Bulk revert payment — only paid claims are eligible; each goes back to
// Approved. Confirm once, then revert them all (no date needed).
async function revertPaidSelected() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  const paid = chosen.filter(c => c.status === 'paid');
  if (!paid.length) {
    toast(t('Only paid claims can have their payment reverted — none of the selected are paid.'), true);
    return;
  }
  const n = paid.length;
  const skipped = chosen.length - n;
  let msg = n === 1 ? t('Revert payment on 1 claim? It will go back to Approved.')
                    : t('Revert payment on {n} claims? They will go back to Approved.', { n });
  if (skipped) msg += '\n' + t('{n} selected not paid and will be skipped.', { n: skipped });
  if (!confirm(msg)) return;
  const btn = $('#revertPaidSelBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = t('Reverting…');
  try {
    let done = 0;
    for (const c of paid) {
      const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
      await api(`${base}${c.id}/revert`, { method: 'POST', body: JSON.stringify({}) });
      done++;
    }
    state.selected.clear();
    toast(done === 1 ? t('Reverted 1 payment') : t('Reverted {n} payments', { n: done }));
    loadAll();
  } catch (ex) { toast(ex.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// Bulk mark-paid — only approved claims are eligible; a payment date must be
// chosen (in the modal) before any claim is marked paid.
function markPaidSelected() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  const approved = chosen.filter(c => c.status === 'approved');
  if (!approved.length) {
    toast(t('Only approved claims can be marked as paid — none of the selected are approved.'), true);
    return;
  }
  openBulkPaidModal(approved, chosen.length);
}

// Choose one payment date, then mark every eligible (approved) selected claim
// paid with it. The confirm button stays disabled until a date is present.
function openBulkPaidModal(claims, totalSelected) {
  const today = todayWIB();
  const n = claims.length;
  const skipped = totalSelected - n;
  openModal(`
    <div class="modal-head"><h2>${esc(n === 1 ? t('Mark 1 claim as paid') : t('Mark {n} claims as paid', { n }))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="bulkPaidForm" class="form">
        <label>${esc(t('Payment date'))}
          <input type="date" name="payment_date" value="${today}" max="${today}" required /></label>
        <p class="muted" style="margin:2px 0 0;font-size:.85rem">${esc(t('The date the payment was actually made. Applied to all selected claims.'))}</p>
        ${skipped ? `<p class="muted" style="margin:8px 0 0;font-size:.85rem">${esc(t('{n} selected not approved and will be skipped.', { n: skipped }))}</p>` : ''}
        <p class="form-error" id="bulkPaidErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="bulkPaidCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary" id="bulkPaidConfirm">${esc(t('Mark as paid'))}</button>
        </div>
      </form>
    </div>`);
  const dateEl = $('#bulkPaidForm [name="payment_date"]');
  const confirmBtn = $('#bulkPaidConfirm');
  const sync = () => { confirmBtn.disabled = !dateEl.value; };
  dateEl.addEventListener('input', sync); sync();
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#bulkPaidCancel').addEventListener('click', closeModal);
  $('#bulkPaidForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payment_date = dateEl.value;
    if (!payment_date) return;
    confirmBtn.disabled = true; confirmBtn.textContent = t('Marking…');
    try {
      let done = 0;
      for (const c of claims) {
        const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
        await api(`${base}${c.id}/mark-paid`, { method: 'POST', body: JSON.stringify({ payment_date }) });
        done++;
      }
      state.selected.clear();
      toast(done === 1 ? t('Marked 1 claim as paid') : t('Marked {n} claims as paid', { n: done }));
      closeModal(); loadAll();
    } catch (ex) {
      const el = $('#bulkPaidErr'); el.textContent = ex.message; el.hidden = false;
      confirmBtn.disabled = false; confirmBtn.textContent = t('Mark as paid');
    }
  });
}

// Super-admin bulk delete — permanently removes the ticked claims (both types).
async function deleteSelected() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  if (!chosen.length) return;
  const dn = chosen.length;
  if (!confirm(dn === 1 ? t('Permanently delete {n} claim? This cannot be undone.', { n: dn })
    : t('Permanently delete {n} claims? This cannot be undone.', { n: dn }))) return;
  const btn = $('#deleteSelBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = t('Deleting…');
  try {
    for (const c of chosen) {
      const path = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
      await api(path + c.id, { method: 'DELETE' });
    }
    state.selected.clear();
    toast(dn === 1 ? t('Deleted {n} claim', { n: dn }) : t('Deleted {n} claims', { n: dn }));
    loadAll();
  } catch (ex) { toast(ex.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

async function generatePdf() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  if (!chosen.length) return;
  const btn = $('#genPdfBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = t('Preparing…');
  try {
    // Pull full details (approvers, history, attachment list) for each claim.
    const detailed = [];
    for (const c of chosen) {
      const path = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
      const { claim } = await api(path + c.id);
      claim.type = c.type;
      detailed.push(claim);
    }
    const bytes = await buildClaimsPdf(detailed);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = detailed.length === 1
      ? `${detailed[0].claim_no}.pdf`
      : `claims-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(detailed.length === 1 ? t('PDF ready — {n} claim', { n: detailed.length }) : t('PDF ready — {n} claims', { n: detailed.length }));
  } catch (ex) {
    toast(ex.message || t('Could not generate PDF'), true);
  } finally { btn.disabled = false; btn.textContent = orig; }
}

// --- PDF engine (pdf-lib, lazily loaded from the vendored bundle) -------------
let _pdfLibPromise;
function loadPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = new Promise((resolve, reject) => {
    if (window.PDFLib) return resolve(window.PDFLib);
    const s = document.createElement('script');
    s.src = 'vendor/pdf-lib.min.js';
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => reject(new Error('Could not load the PDF engine'));
    document.head.appendChild(s);
  });
  return _pdfLibPromise;
}

// --- HEIC decoder (heic2any, lazily loaded from the vendored bundle) ----------
// iPhones save photos as HEIC, which browsers can't draw to a canvas. We only
// pull in the ~1.3 MB decoder when someone actually uploads one.
let _heicPromise;
function loadHeic2any() {
  if (!_heicPromise) _heicPromise = new Promise((resolve, reject) => {
    if (window.heic2any) return resolve(window.heic2any);
    const s = document.createElement('script');
    s.src = 'vendor/heic2any.min.js';
    s.onload = () => resolve(window.heic2any);
    s.onerror = () => reject(new Error('Could not load the HEIC decoder'));
    document.head.appendChild(s);
  });
  return _heicPromise;
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(',')[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Rasterise the brand SVG to PNG bytes once, so the header logo is crisp.
let _logoPngPromise;
function getLogoPngBytes() {
  if (!_logoPngPromise) _logoPngPromise = (async () => {
    const svg = await (await fetch('logo.svg')).text();
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = () => rej(new Error('logo'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const W = 631, H = 213, scale = 4;
    const cnv = document.createElement('canvas');
    cnv.width = W * scale; cnv.height = H * scale;
    cnv.getContext('2d').drawImage(img, 0, 0, W * scale, H * scale);
    return dataUrlToBytes(cnv.toDataURL('image/png'));
  })();
  return _logoPngPromise;
}

// Decode any browser-supported image (jpg/png/gif/webp/heic) to PNG bytes so a
// single embed path covers every attachment image type.
async function rasterToPng(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode')); img.src = url; });
    const cnv = document.createElement('canvas');
    cnv.width = img.naturalWidth || img.width; cnv.height = img.naturalHeight || img.height;
    cnv.getContext('2d').drawImage(img, 0, 0);
    return { w: cnv.width, h: cnv.height, bytes: dataUrlToBytes(cnv.toDataURL('image/png')) };
  } finally { URL.revokeObjectURL(url); }
}

// Helvetica is WinAnsi-only; drop anything it can't encode and normalise the
// few smart-punctuation characters that show up in names/comments.
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/—/g, '-').replace(/…/g, '...').replace(/·/g, '-')
    .replace(/[^\x20-\xFF]/g, '');
}

async function buildClaimsPdf(claims) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo = null;
  try { logo = await pdf.embedPng(await getLogoPngBytes()); } catch { /* header falls back to text */ }

  const W = 595.28, H = 841.89, M = 48, CW = W - 2 * M;
  const ink = rgb(0.13, 0.13, 0.14), muted = rgb(0.5, 0.5, 0.55), rule = rgb(0.86, 0.86, 0.84);
  const orange = rgb(0.969, 0.596, 0.165);
  const stColor = {
    submitted: rgb(0.71, 0.47, 0.10), approved: rgb(0.18, 0.49, 0.33), rejected: rgb(0.75, 0.22, 0.17),
    paid: rgb(0.25, 0.35, 0.59), done: rgb(0.18, 0.49, 0.33), current: rgb(0.71, 0.47, 0.10), pending: muted
  };
  let page, y;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const need = (h) => { if (y - h < M) newPage(); };
  const wrap = (s, size, f, maxW) => {
    const words = pdfSafe(s).split(/\s+/); const out = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur); return out.length ? out : [''];
  };
  const line = (s, { x = M, size = 10, f = font, color = ink, gap = 5 } = {}) => {
    need(size + gap); y -= size; page.drawText(pdfSafe(s), { x, y, size, font: f, color }); y -= gap;
  };
  const section = (s) => { need(24); y -= 16; page.drawText(pdfSafe(s.toUpperCase()), { x: M, y, size: 8, font: bold, color: muted }); y -= 10; };
  // Two-column key/value row (v2/l2 optional).
  const kvRow = (l1, v1, l2, v2) => {
    need(20); y -= 11;
    page.drawText(pdfSafe(l1), { x: M, y, size: 8, font, color: muted });
    page.drawText(pdfSafe(v1 || '-'), { x: M + 84, y, size: 10, font, color: ink });
    if (l2 != null) {
      page.drawText(pdfSafe(l2), { x: M + 268, y, size: 8, font, color: muted });
      page.drawText(pdfSafe(v2 || '-'), { x: M + 350, y, size: 10, font, color: ink });
    }
    y -= 7;
  };
  const kvWide = (label, value) => {
    need(16); y -= 11;
    page.drawText(pdfSafe(label), { x: M, y, size: 8, font, color: muted });
    const lines = wrap(value || '-', 10, font, CW - 84);
    page.drawText(pdfSafe(lines[0]), { x: M + 84, y, size: 10, font, color: ink });
    y -= 7;
    for (let i = 1; i < lines.length; i++) { need(15); y -= 11; page.drawText(pdfSafe(lines[i]), { x: M + 84, y, size: 10, font, color: ink }); y -= 4; }
  };
  // Simple bordered table. cols: [{title,w,align}]. rows: array of cell arrays
  // where a cell is a string or {text,color,bold}. footer optional (same shape).
  const table = (cols, rows, footer) => {
    const hh = 19, lineH = 11;
    need(hh + lineH + 6);
    y -= hh;
    page.drawRectangle({ x: M, y, width: CW, height: hh, color: rgb(0.96, 0.96, 0.94) });
    let x = M;
    cols.forEach(c => { page.drawText(pdfSafe(c.title), { x: x + 5, y: y + 6, size: 7.5, font: bold, color: muted }); x += c.w; });
    const drawRow = (cells, bg) => {
      // Lay out each cell, wrapping its text to the column width so long expense
      // types / descriptions stack onto extra lines instead of being truncated.
      // A cell may set `span` to merge that many columns (used by total rows).
      const laid = [];
      for (let i = 0; i < cols.length;) {
        const cell = cells[i] == null ? '' : cells[i];
        const span = (typeof cell === 'object' && cell.span) ? cell.span : 1;
        let w = 0; for (let k = 0; k < span && cols[i + k]; k++) w += cols[i + k].w;
        const f = (typeof cell === 'object' && cell.bold) ? bold : font;
        const color = (typeof cell === 'object' && cell.color) || ink;
        const raw = typeof cell === 'object' ? (cell.text != null ? cell.text : '') : cell;
        laid.push({ w, align: cols[i].align, f, color, lines: wrap(String(raw), 9, f, w - 10) });
        i += span;
      }
      const nLines = laid.reduce((m, c) => Math.max(m, c.lines.length), 1);
      const rh = nLines * lineH + 6;
      need(rh); y -= rh;
      if (bg) page.drawRectangle({ x: M, y, width: CW, height: rh, color: bg });
      let cx = M;
      laid.forEach(({ w, align, f, color, lines }) => {
        lines.forEach((ln, li) => {
          const tx = align === 'right' ? cx + w - 5 - f.widthOfTextAtSize(ln, 9) : cx + 5;
          page.drawText(ln, { x: tx, y: y + rh - 11 - li * lineH, size: 9, font: f, color });
        });
        cx += w;
      });
      page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
    };
    rows.forEach(r => drawRow(r));
    if (footer) drawRow(footer, rgb(0.98, 0.965, 0.945));
  };

  const claimHeader = (c) => {
    newPage();
    const title = c.type === 'meal' ? 'Meal Allowance Claim' : c.type === 'advance' ? 'Cash Advance' : 'Reimbursement Claim';
    if (logo) { const lw = 104, lh = lw * 213 / 631; page.drawImage(logo, { x: M, y: H - M - lh, width: lw, height: lh }); }
    else page.drawText('Cibes', { x: M, y: H - M - 20, size: 22, font: bold, color: orange });
    const rx = M + 128;
    page.drawText(title, { x: rx, y: H - M - 8, size: 16, font: bold, color: ink });
    const stText = (c.type === 'advance' && ADV_STATUS_LABEL[c.status]) || STATUS_LABEL[c.status] || c.status;
    const stKey = (c.type === 'advance' && ADV_PILL_BASE[c.status]) || c.status;
    page.drawText(`${pdfSafe(c.claim_no)}   ${String(stText).toUpperCase()}`,
      { x: rx, y: H - M - 26, size: 9.5, font: bold, color: stColor[stKey] || muted });
    page.drawText(`Submitted ${fmtDateTime(c.created_at)}`, { x: rx, y: H - M - 40, size: 8.5, font, color: muted });
    y = H - M - 58;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.5, color: orange });
    y -= 6;
  };

  const drawDetails = (c) => {
    if (c.type === 'advance') {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      kvWide('Purpose', c.purpose);
      kvRow('Advance requested', money(c.amount, c.currency));
      section('Realization - actual transactions');
      const cols = [
        { title: 'Date', w: 66 }, { title: 'DB No.', w: 74 }, { title: 'Type of expense', w: 130 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Description', w: CW - 350 }
      ];
      const lines = c.lines || [];
      const rows = lines.map(l => [l.line_date, dbFmt(l.db_no), l.expense_type, money(l.amount, c.currency), l.description || '']);
      table(cols, rows.length ? rows : [['', '', 'No realization yet', '', '']],
        [{ text: 'TOTAL SPENT', bold: true, span: 3 }, '', '', { text: money(c.realized_total, c.currency), bold: true }, '']);
      // Settlement summary: advance vs actual spend, and which way the balance goes.
      if (lines.length) {
        const diff = (c.realized_total || 0) - (c.amount || 0);
        const dir = c.status === 'settled' ? c.settlement_direction : (diff > 0 ? 'topup' : diff < 0 ? 'return' : 'even');
        const amt = c.status === 'settled' ? c.settlement : Math.abs(diff);
        const msg = dir === 'topup' ? 'Top-up owed to employee: ' + money(amt, c.currency)
          : dir === 'return' ? 'Balance to be returned by employee: ' + money(amt, c.currency)
          : 'Advance and actual spend match exactly.';
        section(c.status === 'settled' ? 'Settlement' : 'Settlement (pending)');
        line(msg, { size: 10 });
        if (c.status === 'settled' && c.settlement_note) line(c.settlement_note, { size: 9, color: muted });
      }
    } else if (c.type === 'meal') {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      section('Meal allowance lines');
      const cols = [
        { title: 'Date', w: 66 }, { title: 'DB Number Site', w: 124 }, { title: 'Job Category', w: 90 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Description', w: CW - 360 }
      ];
      const rows = (c.lines || []).map(l => [l.line_date, dbFmt(l.site), l.job_category, money(l.amount, c.currency), l.description]);
      table(cols, rows.length ? rows : [['', '', 'No lines', '', '']],
        [{ text: 'TOTAL', bold: true, span: 3 }, '', '', { text: money(c.total_amount, c.currency), bold: true }, '']);
    } else {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      section('Expense lines');
      const cols = [
        { title: 'Date', w: 66 }, { title: 'DB No.', w: 74 }, { title: 'Type of expense', w: 130 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Description', w: CW - 350 }
      ];
      // Fall back to a single synthetic line for any legacy claim without lines.
      const lines = (c.lines && c.lines.length) ? c.lines : [{
        line_date: c.expense_date, db_no: c.db_no, expense_type: c.expense_type,
        amount: c.amount, description: c.description
      }];
      const rows = lines.map(l => [l.line_date, dbFmt(l.db_no), l.expense_type, money(l.amount, c.currency), l.description || '']);
      table(cols, rows.length ? rows : [['', '', 'No lines', '', '']],
        [{ text: 'TOTAL', bold: true, span: 3 }, '', '', { text: money(c.amount, c.currency), bold: true }, '']);
    }
  };

  const drawApprovals = (c) => {
    section('Approvals');
    if (!c.approvers || !c.approvers.length) { line('No approval chain - processed by a Super Admin.', { size: 9.5, color: muted }); return; }
    const cols = [{ title: 'Step', w: 42 }, { title: 'Approver', w: CW - 42 - 96 - 120 }, { title: 'Decision', w: 96 }, { title: 'Date', w: 120 }];
    const rows = c.approvers.map((a, i) => {
      const st = stepStateFor(c, i + 1);
      const date = st === 'done' ? approvalActionDate(c, a.name, 'approved')
        : st === 'rejected' ? approvalActionDate(c, a.name, 'rejected') : '';
      return [String(i + 1), a.name, { text: STEP_STATE_LABEL[st], color: stColor[st] || muted, bold: true }, date || '-'];
    });
    table(cols, rows);
  };

  const drawHistory = (c) => {
    if (!c.history || !c.history.length) return;
    section('History');
    c.history.forEach(h => {
      const head = `${h.action.charAt(0).toUpperCase() + h.action.slice(1)}  -  ${h.actor_name} · ${fmtDateTime(h.created_at)}`;
      line(head.replace(/·/g, '·'), { size: 9.5, f: bold });
      if (h.comment) wrap('"' + h.comment + '"', 9, font, CW - 14).forEach(ln => line(ln, { x: M + 14, size: 9, color: muted, gap: 3 }));
      y -= 3;
    });
  };

  // Pack up to 4 image attachments onto a single full page. One image fills the
  // page; two share it side by side; three or four fall into a 2x2 grid. Each
  // image is scaled to fit ("contain") inside its cell under a filename caption.
  const drawImageGrid = (c, items) => {
    const p = pdf.addPage([W, H]);
    p.drawText(pdfSafe(`Attachments · ${c.claim_no}`), { x: M, y: H - M - 6, size: 8, font, color: muted });
    const top = H - M - 22, availH = top - M;
    const n = items.length, gap = 14;
    const cols = n === 1 ? 1 : 2, rows = Math.ceil(n / cols);
    const cellW = (CW - gap * (cols - 1)) / cols;
    const cellH = (availH - gap * (rows - 1)) / rows;
    const capH = 13;
    items.forEach(({ att, img }, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const cx = M + col * (cellW + gap);
      const cellTop = top - row * (cellH + gap);
      let name = pdfSafe(att.original_name);
      while (name.length > 4 && font.widthOfTextAtSize(name, 8) > cellW) name = name.slice(0, -2);
      p.drawText(name, { x: cx, y: cellTop - 9, size: 8, font: bold, color: ink });
      const areaH = cellH - capH;
      const s = Math.min(cellW / img.width, areaH / img.height);
      const iw = img.width * s, ih = img.height * s;
      p.drawImage(img, {
        x: cx + (cellW - iw) / 2,
        y: cellTop - capH - (areaH - ih) / 2 - ih,
        width: iw, height: ih
      });
    });
  };
  const drawNotePage = (c, att, msg) => {
    const p = pdf.addPage([W, H]);
    p.drawText(pdfSafe(`Attachment · ${c.claim_no}`), { x: M, y: H - M - 6, size: 8, font, color: muted });
    p.drawText(pdfSafe(att.original_name), { x: M, y: H - M - 20, size: 11, font: bold, color: ink });
    p.drawText(pdfSafe(msg), { x: M, y: H - M - 44, size: 10, font, color: ink });
    p.drawText(pdfSafe(`${att.mime_type || 'unknown type'} · ${fmtBytes(att.size_bytes)}`), { x: M, y: H - M - 60, size: 9, font, color: muted });
  };
  // Render a claim's attachments: images are collected into `batch` and flushed
  // 4-to-a-page as grids; PDFs and load failures break the batch and take their
  // own full page(s), preserving the original attachment order.
  const appendAttachments = async (c, atts) => {
    let batch = [];
    const flush = () => { for (let i = 0; i < batch.length; i += 4) drawImageGrid(c, batch.slice(i, i + 4)); batch = []; };
    for (const att of atts) {
      let bytes, mime = att.mime_type || '';
      try {
        const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
        const res = await fetch(`/api${base}${c.id}/attachments/${att.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('http');
        bytes = new Uint8Array(await res.arrayBuffer());
        if (!mime) mime = res.headers.get('Content-Type') || '';
      } catch { flush(); drawNotePage(c, att, 'Could not load this attachment from storage.'); continue; }
      if (/pdf/i.test(mime) || /\.pdf$/i.test(att.original_name)) {
        flush();
        try {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const copied = await pdf.copyPages(src, src.getPageIndices());
          copied.forEach(p => pdf.addPage(p));
        } catch { drawNotePage(c, att, 'This PDF could not be embedded.'); }
        continue;
      }
      try {
        const png = await rasterToPng(bytes, mime);
        batch.push({ att, img: await pdf.embedPng(png.bytes) });
      } catch { flush(); drawNotePage(c, att, "This file type can't be shown inline - download it from the portal."); }
    }
    flush();
  };

  for (const c of claims) {
    claimHeader(c);
    drawDetails(c);
    drawApprovals(c);
    drawHistory(c);
    // Claims expose a flat top-level list; cash advances keep receipts per line,
    // so fall back to flattening the lines when there's no top-level list.
    const atts = (c.attachments && c.attachments.length)
      ? c.attachments
      : (c.lines || []).flatMap(l => l.attachments || []);
    if (atts.length) {
      section(`Attachments (${atts.length})`);
      atts.forEach(a => line(`- ${a.original_name}  (${fmtBytes(a.size_bytes)})`, { size: 9, gap: 3 }));
    }
    need(26); y -= 14;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
    y -= 11;
    page.drawText(pdfSafe(`Generated ${fmtDateTime(new Date().toISOString())}  ·  Cibes Reimbursement Portal`), { x: M, y, size: 7.5, font, color: muted });
    await appendAttachments(c, atts);
  }
  return pdf.save();
}

// Date shown on an approver step, pulled from the matching history entry.
function approvalActionDate(c, name, action) {
  const h = (c.history || []).find(x => x.actor_name === name && x.action === action);
  return h ? fmtDateTime(h.created_at) : '';
}

// ---------------------------------------------------------------------------
// Drawer (claim detail + actions)
// ---------------------------------------------------------------------------
function closeDrawer() {
  $('#drawer').hidden = true; $('#drawerScrim').hidden = true;
  $('#drawer').classList.remove('over-modal'); $('#drawerScrim').classList.remove('over-modal');
  syncScrollLock();
}
$('#drawerScrim').addEventListener('click', closeDrawer);
// Escape backs out one layer at a time, topmost first. When the drawer floats
// above the drill-down window (over-modal) it closes first, revealing the
// window; otherwise a modal — which normally stacks above the drawer for an
// edit/reject — takes priority, then the drawer.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const drawer = $('#drawer');
  if (!drawer.hidden && drawer.classList.contains('over-modal')) closeDrawer();
  else if (!$('#modal').hidden) closeModal();
  else if (!drawer.hidden) closeDrawer();
});

// Mirror of the server's userCanApprove — decides whether to show actions.
function canApprove(u, c) {
  if (u.role === 'superadmin') return true;
  const ids = (c.approvers || []).map(a => a.id);
  if (!ids.length) return false;
  return ids[(c.current_step || 1) - 1] === u.id;
}
// State of approver step n (1-based) given the claim's status/current step.
function stepStateFor(c, n) {
  if (c.status === 'approved' || c.status === 'paid') return 'done';
  if (c.status === 'rejected') return n < c.current_step ? 'done' : (n === c.current_step ? 'rejected' : 'pending');
  return n < c.current_step ? 'done' : (n === c.current_step ? 'current' : 'pending');
}
// English step-state labels (kept for the PDF). stepStateLabel() localises them
// for the on-screen approval chain.
const STEP_STATE_LABEL = { done: 'Approved', current: 'Pending', rejected: 'Rejected', pending: 'Upcoming' };
const stepStateLabel = (st) => t(STEP_STATE_LABEL[st] || st || '');

// --- Shared drawer builders (both claim types share these shapes) ------------
function renderChainProgress(c) {
  if (!c.approvers || !c.approvers.length) return '';
  return `
    <div class="section-label">${esc(t('Approval chain'))}</div>
    <ol class="chain-progress">
      ${c.approvers.map((a, idx) => {
        const st = stepStateFor(c, idx + 1);
        return `<li class="cp ${st}">
          <span class="cp-dot">${st === 'done' ? '✓' : (st === 'rejected' ? '×' : idx + 1)}</span>
          <div class="cp-body"><div class="cp-label">${esc(a.name)}</div></div>
          <span class="cp-state">${esc(stepStateLabel(st))}</span></li>`;
      }).join('')}
    </ol>`;
}
// History action verbs are stored as lowercase server enums. Map them to
// translatable Title-Case labels for the on-screen timeline. (The PDF keeps the
// raw English — its embedded font is Latin-only; see pdfSafe.) Unknown verbs
// fall back to a capitalised form so nothing renders blank.
const ACTION_LABEL = {
  submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected',
  resubmitted: 'Resubmitted', paid: 'Paid', settled: 'Settled',
  'realization submitted': 'Realization submitted',
  'realization rejected': 'Realization rejected',
  'realization resubmitted': 'Realization resubmitted',
  'reverted approval': 'Reverted approval',
  'reverted payment': 'Reverted payment',
  'reverted realization approval': 'Reverted realization approval',
  'reverted settlement': 'Reverted settlement'
};
const actionLabel = (a) => {
  const s = String(a || '');
  return t(ACTION_LABEL[s] || (s.charAt(0).toUpperCase() + s.slice(1)));
};
function renderHistory(c) {
  return `
    <div class="section-label">${esc(t('History'))}</div>
    <ul class="timeline">
      ${c.history.map(h => `
        <li><span class="t-action">${esc(actionLabel(h.action))}</span>
          <div class="t-meta">${esc(h.actor_name)} · ${fmtDateTime(h.created_at)}</div>
          ${h.comment ? `<div class="t-comment">${esc(h.comment)}</div>` : ''}</li>`).join('')}
    </ul>`;
}
// Whether the current user may revert (undo one step of) this claim, mirroring
// the server's planRevert: the payer can unpay, the final approver can unapprove,
// the previous-step approver can undo their approval, and the claimant can cancel
// a still-pending submission back to an editable state.
// The set of statuses in which a document is awaiting an approver's decision. For
// cash advances this covers both the request and the realization approval cycle.
const inApprovalStage = (c) => c.status === 'submitted' || (c.type === 'advance' && c.status === 'realize_submitted');

function canRevert(c, u, isOwner) {
  const ids = (c.approvers || []).map(a => a.id);
  const step = c.current_step || 0;
  const isSuper = u.role === 'superadmin';
  // Cash-advance realization phase mirrors the request phase one status set up.
  if (c.type === 'advance') {
    if (c.status === 'settled') return canPay(u);
    if (c.status === 'realize_approved') return isSuper || c.manager_id === u.id;
    if (c.status === 'realize_submitted') {
      if (step > 1) return isSuper || ids[step - 2] === u.id;
      return isOwner || isSuper;
    }
  }
  if (c.status === 'paid') return canPay(u);
  if (c.status === 'approved') return isSuper || c.manager_id === u.id;
  if (c.status === 'submitted') {
    if (step > 1) return isSuper || ids[step - 2] === u.id;
    return isOwner || isSuper; // claimant cancels a not-yet-approved submission
  }
  return false;
}
// Contextual label + confirmation copy for the revert button.
function revertInfo(c) {
  const step = c.current_step || 0;
  if (c.type === 'advance' && c.status === 'settled') return { label: t('Revert settlement'), confirm: t('Revert this settlement? The realization will go back to Approved.') };
  if (c.type === 'advance' && c.status === 'realize_approved') return { label: t('Revert approval'), confirm: t('Revert your approval? The realization will go back to pending review.') };
  if (c.type === 'advance' && c.status === 'realize_submitted') {
    if (step > 1) return { label: t('Revert approval'), confirm: t('Revert your approval? The realization will return to the previous approver.') };
    return { label: t('Cancel to edit'), confirm: t('Cancel this realization so you can edit it? It will move back to editable.') };
  }
  if (c.status === 'paid') return { label: t('Revert payment'), confirm: t('Revert this payment? The claim will go back to Approved.') };
  if (c.status === 'approved') return { label: t('Revert approval'), confirm: t('Revert your approval? The claim will go back to pending review.') };
  if (c.status === 'submitted' && step > 1) return { label: t('Revert approval'), confirm: t('Revert your approval? The claim will return to the previous approver.') };
  return { label: t('Cancel to edit'), confirm: t('Cancel this submission so you can edit it? It will move to Rejected, ready to edit and resubmit.') };
}
function buildActions(c, u, isOwner) {
  const btns = [];
  if (inApprovalStage(c) && canApprove(u, c)) {
    btns.push(`<button class="btn btn-approve" data-act="approve">${esc(t('Approve'))}</button>`);
    btns.push(`<button class="btn btn-danger" data-act="reject">${esc(t('Reject & return'))}</button>`);
  }
  if (canPay(u) && c.status === 'approved') {
    btns.push(`<button class="btn btn-primary" data-act="paid">${esc(t('Mark as paid'))}</button>`);
  }
  // Cash-advance-only actions.
  if (c.type === 'advance') {
    if (isOwner && (c.status === 'paid' || c.status === 'rejected_realize')) {
      btns.push(`<button class="btn btn-primary" data-act="realize">${esc(c.status === 'paid' ? t('Realize advance') : t('Edit & resubmit realization'))}</button>`);
    }
    if (canPay(u) && c.status === 'realize_approved') {
      btns.push(`<button class="btn btn-primary" data-act="settle">${esc(t('Settle'))}</button>`);
    }
  }
  if (isOwner && c.status === 'rejected') {
    btns.push(`<button class="btn btn-primary" data-act="edit">${esc(t('Edit & resubmit'))}</button>`);
  }
  if (canRevert(c, u, isOwner)) {
    btns.push(`<button class="btn btn-ghost" data-act="revert">${esc(revertInfo(c).label)}</button>`);
  }
  return btns.join('\n            ');
}

// Body for a reimbursement claim: account/bank details + the itemised line table,
// each line showing its own receipts.
function reimbursementBody(c) {
  const receiptLinks = (atts) => (atts && atts.length)
    ? atts.map(a => `<a class="line-receipt" title="${esc(a.original_name)}" href="/api/claims/${c.id}/attachments/${a.id}" target="_blank" rel="noopener">📎 ${esc(a.original_name)}</a>`).join(' ')
    : `<span class="muted">${esc(t('—'))}</span>`;
  // Fall back to a single synthetic line for any legacy claim without lines.
  const lines = (c.lines && c.lines.length) ? c.lines : [{
    line_date: c.expense_date, db_no: c.db_no, expense_type: c.expense_type,
    amount: c.amount, description: c.description, attachments: c.attachments || []
  }];
  const rows = lines.map(l => `
    <tr>
      <td class="mono" data-label="${esc(t('Date'))}">${esc(l.line_date)}</td>
      <td data-label="${esc(t('DB No.'))}">${l.db_no ? esc(dbFmt(l.db_no)) : '<span class="muted">—</span>'}</td>
      <td data-label="${esc(t('Type of expense'))}">${esc(l.expense_type)}</td>
      <td class="meal-amt" data-label="${esc(t('Amount'))}">${esc(money(l.amount, c.currency))}</td>
      <td data-label="${esc(t('Description / purpose'))}">${l.description ? esc(l.description) : '<span class="muted">—</span>'}</td>
      <td data-label="${esc(t('Receipts'))}" class="line-receipts">${receiptLinks(l.attachments)}</td>
    </tr>`).join('');
  return `
    <dl class="kv">
      <dt>${esc(t('Claimant'))}</dt><dd>${esc(c.claimant_name)}</dd>
      ${c.department ? `<dt>${esc(t('Department'))}</dt><dd>${esc(c.department)}</dd>` : ''}
      <dt>${esc(t('Recipient'))}</dt><dd>${esc(c.recipient_name)}</dd>
      <dt>${esc(t('Bank'))}</dt><dd>${esc(c.bank_name)}</dd>
      <dt>${esc(t('Account no.'))}</dt><dd class="mono">${esc(c.bank_account_no)}</dd>
    </dl>
    <div class="section-label">${esc(t('Expense lines'))}</div>
    <div class="meal-table-wrap">
      <table class="meal-table rc-table">
        <thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('DB No.'))}</th><th>${esc(t('Type of expense'))}</th><th>${esc(t('Amount'))}</th><th>${esc(t('Description / purpose'))}</th><th>${esc(t('Receipts'))}</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td colspan="3" class="meal-total-label">${esc(t('TOTAL'))}</td>
          <td class="meal-total">${esc(money(c.amount, c.currency))}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
    </div>`;
}

// Body for a meal allowance claim: account/bank details + the line-item table.
function mealBody(c) {
  const rows = (c.lines || []).map(l => `
    <tr>
      <td class="mono" data-label="${esc(t('Date'))}">${esc(l.line_date)}</td>
      <td data-label="${esc(t('DB Number Site'))}">${esc(dbFmt(l.site))}</td>
      <td data-label="${esc(t('Job Category'))}">${esc(l.job_category)}</td>
      <td class="meal-amt" data-label="${esc(t('Amount'))}">${esc(money(l.amount, c.currency))}</td>
      <td data-label="${esc(t('Additional Description'))}">${esc(l.description)}</td>
    </tr>`).join('');
  return `
    <dl class="kv">
      <dt>${esc(t('Claimant'))}</dt><dd>${esc(c.claimant_name)}</dd>
      ${c.department ? `<dt>${esc(t('Department'))}</dt><dd>${esc(c.department)}</dd>` : ''}
      <dt>${esc(t('Recipient'))}</dt><dd>${esc(c.recipient_name)}</dd>
      <dt>${esc(t('Bank'))}</dt><dd>${esc(c.bank_name)}</dd>
      <dt>${esc(t('Account no.'))}</dt><dd class="mono">${esc(c.bank_account_no)}</dd>
    </dl>
    <div class="section-label">${esc(t('Meal allowance lines'))}</div>
    <div class="meal-table-wrap">
      <table class="meal-table">
        <thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('DB Number Site'))}</th><th>${esc(t('Job Category'))}</th><th>${esc(t('Amount'))}</th><th>${esc(t('Additional Description'))}</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="muted" style="padding:12px">${esc(t('No lines.'))}</td></tr>`}</tbody>
        <tfoot><tr>
          <td colspan="3" class="meal-total-label">${esc(t('TOTAL CLAIM MEAL ALLOWANCE'))}</td>
          <td class="meal-total">${esc(money(c.total_amount, c.currency))}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>`;
}

// Body for a cash advance: account/bank details, the purpose + requested amount,
// and — once realized — the itemised transactions with a settlement summary.
function advanceBody(c) {
  const receiptLinks = (atts) => (atts && atts.length)
    ? atts.map(a => `<a class="line-receipt" title="${esc(a.original_name)}" href="/api/cash-advances/${c.id}/attachments/${a.id}" target="_blank" rel="noopener">📎 ${esc(a.original_name)}</a>`).join(' ')
    : `<span class="muted">${esc(t('—'))}</span>`;
  const hasLines = (c.lines || []).length > 0;
  const linesTable = hasLines ? `
    <div class="section-label">${esc(t('Realization — actual transactions'))}</div>
    <div class="meal-table-wrap">
      <table class="meal-table rc-table">
        <thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('DB No.'))}</th><th>${esc(t('Type of expense'))}</th><th>${esc(t('Amount'))}</th><th>${esc(t('Description / purpose'))}</th><th>${esc(t('Receipts'))}</th></tr></thead>
        <tbody>${c.lines.map(l => `
          <tr>
            <td class="mono" data-label="${esc(t('Date'))}">${esc(l.line_date)}</td>
            <td data-label="${esc(t('DB No.'))}">${l.db_no ? esc(dbFmt(l.db_no)) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Type of expense'))}">${esc(l.expense_type)}</td>
            <td class="meal-amt" data-label="${esc(t('Amount'))}">${esc(money(l.amount, c.currency))}</td>
            <td data-label="${esc(t('Description / purpose'))}">${l.description ? esc(l.description) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Receipts'))}" class="line-receipts">${receiptLinks(l.attachments)}</td>
          </tr>`).join('')}</tbody>
        <tfoot><tr>
          <td colspan="3" class="meal-total-label">${esc(t('TOTAL SPENT'))}</td>
          <td class="meal-total">${esc(money(c.realized_total, c.currency))}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table>
    </div>` : `<p class="muted" style="margin:10px 0">${esc(t('Realization not submitted yet.'))}</p>`;
  // Settlement summary: the recorded outcome once settled, otherwise a live preview.
  let settleBox = '';
  if (hasLines) {
    const diff = (c.realized_total || 0) - (c.amount || 0);
    const dir = c.status === 'settled' ? c.settlement_direction : (diff > 0 ? 'topup' : diff < 0 ? 'return' : 'even');
    const amt = c.status === 'settled' ? c.settlement : Math.abs(diff);
    const msg = dir === 'topup' ? t('Top-up owed to employee: {amt}', { amt: money(amt, c.currency) })
      : dir === 'return' ? t('Balance to be returned by employee: {amt}', { amt: money(amt, c.currency) })
      : t('Advance and actual spend match exactly.');
    settleBox = `<div class="note-box adv-settle adv-diff-${dir}">
      <div class="nb-label">${esc(c.status === 'settled' ? t('Settlement') : t('Settlement (pending)'))}</div>
      <div>${esc(msg)}</div>
      ${c.status === 'settled' && c.settlement_note ? `<div class="muted" style="margin-top:4px">${esc(c.settlement_note)}</div>` : ''}
    </div>`;
  }
  return `
    <dl class="kv">
      <dt>${esc(t('Claimant'))}</dt><dd>${esc(c.claimant_name)}</dd>
      ${c.department ? `<dt>${esc(t('Department'))}</dt><dd>${esc(c.department)}</dd>` : ''}
      <dt>${esc(t('Recipient'))}</dt><dd>${esc(c.recipient_name)}</dd>
      <dt>${esc(t('Bank'))}</dt><dd>${esc(c.bank_name)}</dd>
      <dt>${esc(t('Account no.'))}</dt><dd class="mono">${esc(c.bank_account_no)}</dd>
      <dt>${esc(t('Purpose'))}</dt><dd>${esc(c.purpose)}</dd>
      <dt>${esc(t('Advance requested'))}</dt><dd><strong>${esc(money(c.amount, c.currency))}</strong></dd>
    </dl>
    ${linesTable}
    ${settleBox}`;
}

async function openDrawer(id, type = 'reimbursement') {
  const path = type === 'meal' ? '/meal-claims/' : type === 'advance' ? '/cash-advances/' : '/claims/';
  const { claim: c } = await api(path + id);
  c.type = type;
  const u = state.user;
  const isOwner = c.employee_id === u.id;

  const rejectedNote = (c.status === 'rejected' && c.manager_comment) ? `
    <div class="note-box"><div class="nb-label">${esc(t('Returned by manager'))}</div>
      <div>${esc(c.manager_comment)}</div></div>` : '';
  const body = type === 'meal' ? mealBody(c) : type === 'advance' ? advanceBody(c) : reimbursementBody(c);
  const actions = buildActions(c, u, isOwner);

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div><h2>${esc(c.claim_no)} <span class="pill ${pillClass(c)}">${esc(statusLabelFor(c))}</span></h2>
        <p class="muted" style="margin:4px 0 0;font-size:.85rem">${esc(t('Submitted {time}', { time: fmtDateTime(c.created_at) }))}</p></div>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="drawer-body">
      ${rejectedNote}
      ${body}
      ${renderChainProgress(c)}
      ${renderHistory(c)}
      <div class="drawer-actions">${actions || `<span class="muted" style="font-size:.85rem">${esc(t('No actions available for your role at this stage.'))}</span>`}</div>
    </div>`;

  $('#drawer .x-btn').addEventListener('click', closeDrawer);
  $$('#drawer [data-act]').forEach(b => b.addEventListener('click', () => handleAction(b.dataset.act, c)));

  $('#drawerScrim').hidden = false;
  $('#drawer').hidden = false;
  syncScrollLock();
}

async function handleAction(act, c) {
  const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
  try {
    if (act === 'approve') {
      await api(`${base}${c.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      toast(t('Claim approved'));
    } else if (act === 'paid') {
      return openPaidModal(c);
    } else if (act === 'realize') {
      return openRealizeModal(c);
    } else if (act === 'settle') {
      return openSettleModal(c);
    } else if (act === 'revert') {
      const info = revertInfo(c);
      if (!confirm(info.confirm)) return;
      await api(`${base}${c.id}/revert`, { method: 'POST', body: JSON.stringify({}) });
      toast(t('Reverted'));
    } else if (act === 'reject') {
      return openRejectModal(c);
    } else if (act === 'edit') {
      return c.type === 'meal' ? openMealAllowanceModal(c) : c.type === 'advance' ? openAdvanceRequestModal(c) : openClaimModal(c);
    }
    closeDrawer(); loadAll();
  } catch (ex) { toast(ex.message, true); }
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
// Freeze the page behind any open modal / drawer so the background can't scroll.
function syncScrollLock() {
  const m2 = $('#modal2');
  const open = !$('#modal').hidden || (m2 && !m2.hidden) || !$('#drawer').hidden;
  document.body.classList.toggle('no-scroll', !!open);
}
// A callback run once the next time #modal closes, then cleared. Lets a modal
// (e.g. the insights drill-down window) clean up page state on every close path
// — its ×, the scrim, or Escape — which all funnel through closeModal().
let modalCloseHook = null;
function openModal(html) {
  modalCloseHook = null; // a new modal supersedes any pending hook
  // If a modal opens while the drawer is floating above a previous one (the
  // insights drill-down window), that window is being replaced by a drawer
  // action (edit / mark-paid / reject). Drop the drawer's elevation so this new
  // modal stacks above the drawer as usual, and clear the now-gone window's
  // bar highlight.
  const drawer = $('#drawer');
  if (drawer.classList.contains('over-modal')) {
    drawer.classList.remove('over-modal');
    $('#drawerScrim').classList.remove('over-modal');
    clearTypeDrill();
  }
  $('#modal').innerHTML = html;
  $('#modalScrim').hidden = false;
  $('#modal').hidden = false;
  syncScrollLock();
}
function closeModal() {
  $('#modal').hidden = true; $('#modalScrim').hidden = true;
  $('#modal').classList.remove('modal-wide', 'modal-xwide', 'modal-flex');
  if (modalCloseHook) { const hook = modalCloseHook; modalCloseHook = null; hook(); }
  syncScrollLock();
}
$('#modalScrim').addEventListener('click', closeModal);

// Client-side filter for a settings table: hides rows that don't match the
// query. `listSel` scopes to the tab's scrolling list so tabs don't interfere.
function wireTableSearch(input, listSel) {
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    $$(`${listSel} tbody tr`).forEach(tr => {
      if (tr.querySelector('td[colspan]')) return; // empty-state row
      tr.hidden = !!q && !tr.textContent.toLowerCase().includes(q);
    });
  });
}

// Second modal layer — stacks over #modal for sub-forms (e.g. add/edit user).
function openModal2(html) {
  $('#modal2').innerHTML = html;
  $('#modal2Scrim').hidden = false;
  $('#modal2').hidden = false;
  syncScrollLock();
}
function closeModal2() { $('#modal2').hidden = true; $('#modal2Scrim').hidden = true; $('#modal2').classList.remove('modal-wide', 'modal-xwide', 'modal-flex'); syncScrollLock(); }
$('#modal2Scrim').addEventListener('click', closeModal2);

// ---------------------------------------------------------------------------
// New / Edit claim
// ---------------------------------------------------------------------------
let pendingFiles = [];
// On edit & resubmit, the receipts already on the claim, as { id, original_name }.
// The claimant can remove them in the form; whatever survives is sent back as
// keep_attachment_ids and the server drops the rest.
let keptAttachments = [];
let keptClaimId = null;   // claim being edited, for the kept chips' view links

// Render a <select> when the admin has configured options, otherwise a plain
// text input so claims can still be submitted before settings are populated.
function lookupField(name, label, value, options, attrs = '') {
  const cur = value || '';
  if (!options.length) {
    return `<label>${label}<input name="${name}" required ${attrs} value="${esc(cur)}" /></label>`;
  }
  const opts = [...options];
  if (cur && !opts.includes(cur)) opts.unshift(cur); // keep an existing value that was since removed
  return `<label>${label}
    <select name="${name}" required>
      <option value="" ${cur ? '' : 'selected'} disabled>${esc(t('Select…'))}</option>
      ${opts.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select></label>`;
}

// The claim's expense type: the configured list plus an "Others" option that
// reveals a free-text field. When settings have no expense types yet, fall back
// to a plain text input (same behaviour as lookupField). A stored value that
// isn't a configured option is treated as a previous "Others" entry so editing
// keeps it. Wiring (show/hide) is done by wireExpenseTypeField after render.
function expenseTypeField(value) {
  const options = state.lookups.expense_types;
  const cur = value || '';
  if (!options.length) {
    return `<label>${esc(t('Type of expense'))}<input name="expense_type" required placeholder="${esc(t('Travel, Meals, Supplies…'))}" value="${esc(cur)}" /></label>`;
  }
  const isOther = !!cur && !options.some(o => o.toLowerCase() === cur.toLowerCase());
  const selectVal = isOther ? 'Others' : cur;
  // A searchable combobox: a text box filters the list, and a hidden input holds
  // the chosen value (so form submission + the "Others" flow are unchanged). The
  // hidden field is validated in submitClaim, not via native `required`.
  return `<label>${esc(t('Type of expense'))}
      <div class="combo" id="expCombo">
        <input type="text" id="expSearch" class="combo-input" role="combobox"
               aria-autocomplete="list" aria-expanded="false" aria-controls="expList"
               autocomplete="off" placeholder="${esc(t('Search or select…'))}" value="${esc(selectVal)}" />
        <input type="hidden" name="expense_type" id="expType" value="${esc(selectVal)}" />
        <ul class="combo-list" id="expList" role="listbox" hidden></ul>
      </div></label>
    <label class="full" id="expOtherWrap" ${isOther ? '' : 'hidden'}>${esc(t('Please specify the expense type'))}
      <input name="expense_type_other" id="expOther" value="${isOther ? esc(cur) : ''}" placeholder="${esc(t('Enter the expense type'))}" /></label>`;
}
// Wire the expense-type combobox: filter-as-you-type, click/keyboard select, and
// the "Others" free-text reveal. Options are the configured types plus "Others".
function wireExpenseTypeField() {
  const search = $('#expSearch');
  if (!search) return; // no-options fallback renders a plain text input
  const hidden = $('#expType'), list = $('#expList'), combo = $('#expCombo');
  const wrap = $('#expOtherWrap'), other = $('#expOther');
  const OPTIONS = state.lookups.expense_types.concat(['Others']);
  let filtered = OPTIONS.slice();
  let active = -1;

  const syncOther = () => {
    const on = hidden.value === 'Others';
    wrap.hidden = !on;
    if (other) other.required = on;
  };
  const render = () => {
    list.innerHTML = filtered.length
      ? filtered.map((o, i) => `<li class="combo-item${i === active ? ' active' : ''}" role="option"
          data-val="${esc(o)}" aria-selected="${o === hidden.value}">${esc(o)}</li>`).join('')
      : `<li class="combo-empty" aria-disabled="true">${esc(t('No matches'))}</li>`;
  };
  const open = () => { list.hidden = false; search.setAttribute('aria-expanded', 'true'); combo.classList.add('open'); };
  const close = () => { list.hidden = true; search.setAttribute('aria-expanded', 'false'); combo.classList.remove('open'); active = -1; };
  const filter = (term) => {
    const t = term.trim().toLowerCase();
    filtered = t ? OPTIONS.filter(o => o.toLowerCase().includes(t)) : OPTIONS.slice();
    active = filtered.length ? 0 : -1;
    render();
  };
  const commit = (val) => {
    hidden.value = val; search.value = val;
    syncOther(); close();
    if (val === 'Others' && other) other.focus();
  };
  const scrollActive = () => { const el = list.querySelector('.combo-item.active'); if (el) el.scrollIntoView({ block: 'nearest' }); };

  search.addEventListener('focus', () => { filter(''); search.select(); open(); });
  search.addEventListener('input', () => { filter(search.value); open(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) { filter(search.value); open(); } else { active = Math.min(active + 1, filtered.length - 1); render(); }
      scrollActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); active = Math.max(active - 1, 0); render(); scrollActive();
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0 && filtered[active]) { e.preventDefault(); commit(filtered[active]); }
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); close(); }
    }
  });
  // mousedown (not click) so it fires before the input's blur, avoiding a race.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.combo-item');
    if (!li) return;
    e.preventDefault();
    commit(li.dataset.val);
  });
  // On blur, snap the visible text back to the committed value (never leave a
  // half-typed non-selection on screen).
  search.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== search) { search.value = hidden.value; close(); }
  }, 0));

  syncOther();
}

// Optional inline calculator on the claim form: a running tally that lets a
// claimant add up several receipt amounts and drop the sum into the Amount field.
function calcPanelHtml() {
  return `<div class="calc-panel" id="calcPanel" hidden>
    <div class="calc-input-row">
      <input id="calcInput" inputmode="decimal" placeholder="${esc(t('Add an amount…'))}" />
      <button type="button" class="btn btn-ghost btn-sm" id="calcAdd">${esc(t('Add'))}</button>
    </div>
    <ul class="calc-list" id="calcList"></ul>
    <div class="calc-foot">
      <div class="calc-total-wrap"><span>${esc(t('Total'))}</span><strong id="calcTotal">0</strong></div>
      <div class="calc-foot-btns">
        <button type="button" class="btn btn-ghost btn-sm" id="calcClear">${esc(t('Clear'))}</button>
        <button type="button" class="btn btn-primary btn-sm" id="calcApply">${esc(t('Use total'))}</button>
      </div>
    </div>
  </div>`;
}

function wireClaimCalculator() {
  const toggle = $('#calcToggle'), panel = $('#calcPanel');
  if (!toggle || !panel) return;
  let entries = [];
  const sum = () => entries.reduce((a, b) => a + b, 0);
  const render = () => {
    $('#calcList').innerHTML = entries.length
      ? entries.map((n, i) =>
          `<li><span class="mono">${groupAmount(String(n))}</span>
             <button type="button" data-i="${i}" aria-label="${esc(t('Remove'))}">×</button></li>`).join('')
      : `<li class="calc-empty">${esc(t('No amounts added yet.'))}</li>`;
    $('#calcTotal').textContent = groupAmount(String(sum())) || '0';
    $$('#calcList button[data-i]').forEach(b =>
      b.addEventListener('click', () => { entries.splice(+b.dataset.i, 1); render(); }));
  };
  const add = () => {
    const inp = $('#calcInput');
    const n = Number(String(inp.value).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) entries.push(n);
    inp.value = ''; inp.focus(); render();
  };
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) $('#calcInput').focus();
  });
  $('#calcAdd').addEventListener('click', add);
  $('#calcInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });
  $('#calcInput').addEventListener('input', e => { e.target.value = groupAmount(e.target.value); });
  $('#calcApply').addEventListener('click', () => {
    const amt = $('#claimForm [name="amount"]');
    if (amt) amt.value = groupAmount(String(sum()));
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  });
  $('#calcClear').addEventListener('click', () => { entries = []; render(); });
  render();
}

// When the signed-in account has two or more chooseable Approver 1 candidates,
// render a required picker of them. With one candidate it is used automatically
// (no picker), and with none the approver chain is fixed — both return ''. On
// resubmit, preselect the claim's existing first approver if it is still one of
// the candidates.
function approver1PickerHtml(existing) {
  const choices = (state.user && state.user.approver1_choices) || [];
  if (choices.length < 2) return '';
  const preId = existing && existing.approvers && existing.approvers[0] ? String(existing.approvers[0].id) : '';
  const opts = ['<option value="" disabled' + (preId ? '' : ' selected') + '>' + esc(t('Choose an approver…')) + '</option>']
    .concat(choices.map(c => `<option value="${c.id}" ${String(c.id) === preId ? 'selected' : ''}>${esc(c.name)}</option>`));
  return `<label class="full">${esc(t('Approver 1'))} <span style="color:var(--danger,#d33)">*</span>
    <select name="approver1" required>${opts.join('')}</select></label>`;
}

// A reimbursement claim is an editable table: one row per expense (date, DB no,
// type, amount, description) with that expense's own receipts. Files/kept
// attachments live on the row objects (never in the DOM) so re-rendering the
// table preserves them.
let claimRows = [];
let claimEditId = null;   // claim being edited, for the kept-receipt view links
// Base API path for kept-receipt links in the shared line editor. Reimbursement
// claims use /api/claims; the cash-advance realization form flips it to
// /api/cash-advances so kept receipts open from the right endpoint.
let rcAttachBase = '/api/claims';
// Optional callback fired whenever the shared line editor's total changes, so the
// realization form can refresh its "advance vs spent" difference banner.
let rcTotalHook = null;
const rcAmt = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };
function claimTotal() { return claimRows.reduce((sum, r) => sum + rcAmt(r.amount), 0); }
const blankClaimRow = (date = '') => ({ line_date: date, db_no: '', expense_type: '', expense_type_other: '', amount: '', description: '', files: [], kept: [] });

function rcChips(r, i) {
  const kept = (r.kept || []).map((a, k) =>
    `<span class="file-chip file-chip-saved"><a href="${rcAttachBase}/${claimEditId}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.original_name)}</a>` +
    `<button type="button" data-chip="kept" data-row="${i}" data-k="${k}" aria-label="${esc(t('Remove'))}">×</button></span>`);
  const files = (r.files || []).map((f, k) =>
    `<span class="file-chip">${esc(f.name)}<button type="button" data-chip="new" data-row="${i}" data-k="${k}" aria-label="${esc(t('Remove'))}">×</button></span>`);
  return kept.concat(files).join('');
}
// Expense-type picker for a row: a native <select> (clean, and its dropdown is
// never clipped by the scrolling table). "Others" is always offered and reveals
// a free-text field. A legacy custom value is preserved as its own option.
function rcTypeSelect(r) {
  const cur = r.expense_type || '';
  const opts = [...(state.lookups.expense_types || [])];
  if (!opts.some(o => o.toLowerCase() === 'others')) opts.push('Others');
  const extra = (cur && cur !== 'Others' && !opts.includes(cur)) ? cur : null;
  return `<select name="expense_type">
      <option value="" ${cur ? '' : 'selected'}>${esc(t('Select…'))}</option>
      ${extra ? `<option value="${esc(extra)}" selected>${esc(extra)}</option>` : ''}
      ${opts.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o === 'Others' ? t('Others (specify)') : o)}</option>`).join('')}
    </select>
    <input name="expense_type_other" class="rc-other" value="${esc(r.expense_type_other || '')}" placeholder="${esc(t('Specify the expense…'))}" ${cur === 'Others' ? '' : 'hidden'} />`;
}
// A "DB number" field. The user first chooses No DB or With DB; picking With DB
// reveals a numbers-only box with a fixed grey "DB" prefix (no spaces). The
// combined value is stored back as "DB <digits>" (or "" for No DB) so every
// downstream reader — the line tables, the PDF export and the DB filter — keeps
// working unchanged. Shared by the meal, reimbursement and realization editors.
function dbParse(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { on: false, digits: '' };
  return { on: true, digits: s.replace(/\D/g, '') };
}
function dbCombine(on, digits) {
  const d = String(digits || '').replace(/\D/g, '');
  return on ? (d ? 'DB ' + d : 'DB') : '';
}
// Display a stored DB string ("DB 200231") with no space → "DB200231". Purely
// cosmetic: the stored value keeps its space so filters/search/PDF stay uniform
// across old and new claims; only what the reader sees is tightened.
const dbFmt = v => String(v == null ? '' : v).replace(/\s+/g, '');
function dbCellHtml(value) {
  const { on, digits } = dbParse(value);
  return `<div class="db-cell">
    <select class="db-mode">
      <option value="no" ${on ? '' : 'selected'}>${esc(t('No DB'))}</option>
      <option value="yes" ${on ? 'selected' : ''}>${esc(t('With DB'))}</option>
    </select>
    <div class="db-entry" ${on ? '' : 'hidden'}>
      <span class="db-prefix" aria-hidden="true">DB</span>
      <input class="db-num" inputmode="numeric" autocomplete="off" value="${esc(digits)}"
        aria-label="${esc(t('DB number'))}" placeholder="500309" />
    </div>
  </div>`;
}
// Read a DB cell (identified by its .db-mode/.db-num children) back into the
// combined stored string.
function dbCellRead(tr) {
  const sel = tr.querySelector('.db-mode'), num = tr.querySelector('.db-num');
  return dbCombine(sel ? sel.value === 'yes' : false, num ? num.value : '');
}
// Wire every DB cell inside `scope`: the select toggles the numbers box, and the
// box strips anything that isn't a digit (so spaces are impossible).
function wireDbCells(scope) {
  $$(scope + ' .db-cell').forEach(cell => {
    const sel = cell.querySelector('.db-mode');
    const entry = cell.querySelector('.db-entry');
    const num = cell.querySelector('.db-num');
    if (!sel || !entry || !num) return;
    sel.addEventListener('change', () => {
      const on = sel.value === 'yes';
      entry.hidden = !on;
      if (on) num.focus();
    });
    num.addEventListener('input', () => {
      const clean = num.value.replace(/[^0-9]/g, '');
      if (clean !== num.value) num.value = clean;
    });
  });
}

function claimRowHtml(r, i) {
  const min = claimEarliest() ? `min="${esc(claimEarliest())}"` : '';
  return `<tr data-i="${i}">
    <td data-label="${esc(t('Date'))}"><input name="line_date" type="date" ${min} value="${esc(r.line_date || '')}" /></td>
    <td data-label="${esc(t('DB No.'))}">${dbCellHtml(r.db_no)}</td>
    <td data-label="${esc(t('Type of expense'))}">${rcTypeSelect(r)}</td>
    <td data-label="${esc(t('Amount'))}"><div class="rc-amt-wrap">
      <input name="amount" class="rc-amt" inputmode="decimal" value="${esc(r.amount == null ? '' : groupAmount(String(r.amount)))}" placeholder="0" />
      <button type="button" class="rc-calc" data-calc="${i}" title="${esc(t('Add up amounts'))}" aria-label="${esc(t('Add up amounts'))}">🧮</button>
    </div></td>
    <td data-label="${esc(t('Description / purpose'))}"><input name="description" value="${esc(r.description || '')}" placeholder="${esc(t('What was this for?'))}" /></td>
    <td class="rc-receipts" data-label="${esc(t('Receipts'))}">
      <div class="file-chips">${rcChips(r, i)}</div>
      <button type="button" class="btn btn-ghost btn-sm rc-add" data-add="${i}">📎 ${esc(t('Add'))}</button>
      <input type="file" class="rc-input" data-input="${i}" multiple hidden accept=".pdf,image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif" />
    </td>
    <td class="meal-x"><button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove'))}">×</button></td>
  </tr>`;
}
// Copy scalar fields from the DOM back into claimRows before any re-render, so
// files/kept (not in the DOM) survive.
function readClaimRows() {
  $$('#rcRows tr[data-i]').forEach(tr => {
    const i = +tr.dataset.i, r = claimRows[i]; if (!r) return;
    const g = (n) => { const el = tr.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
    r.line_date = g('line_date'); r.db_no = dbCellRead(tr); r.expense_type = g('expense_type');
    r.expense_type_other = g('expense_type_other'); r.amount = g('amount'); r.description = g('description');
  });
}
function renderClaimRows() {
  const body = $('#rcRows');
  body.innerHTML = claimRows.length
    ? claimRows.map(claimRowHtml).join('')
    : `<tr><td colspan="7" class="muted" style="padding:14px;text-align:center">${esc(t('No rows yet — add one below.'))}</td></tr>`;
  $('#rcTotal').textContent = liveAmt(claimTotal());
  if (rcTotalHook) rcTotalHook();
  $$('#rcRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    readClaimRows(); claimRows.splice(+b.dataset.rm, 1); renderClaimRows();
  }));
  $$('#rcRows .rc-add').forEach(b => b.addEventListener('click', () => {
    const inp = $(`#rcRows .rc-input[data-input="${b.dataset.add}"]`); if (inp) inp.click();
  }));
  $$('#rcRows .rc-input').forEach(inp => inp.addEventListener('change', async () => {
    const i = +inp.dataset.input, r = claimRows[i]; if (!r) return;
    const accepted = await processFiles(inp.files, (r.files || []).length + (r.kept || []).length);
    r.files = (r.files || []).concat(accepted);
    readClaimRows(); renderClaimRows();
  }));
  $$('#rcRows [data-chip]').forEach(b => b.addEventListener('click', () => {
    const r = claimRows[+b.dataset.row]; if (!r) return;
    (b.dataset.chip === 'kept' ? r.kept : r.files).splice(+b.dataset.k, 1);
    readClaimRows(); renderClaimRows();
  }));
  $$('#rcRows .rc-amt').forEach(el => el.addEventListener('input', () => {
    el.value = groupAmount(el.value); // thousands separators as they type
    readClaimRows(); $('#rcTotal').textContent = liveAmt(claimTotal()); if (rcTotalHook) rcTotalHook();
  }));
  // Reveal the "specify" field when the type is set to Others.
  $$('#rcRows select[name="expense_type"]').forEach(sel => sel.addEventListener('change', () => {
    const other = sel.closest('td').querySelector('.rc-other');
    if (other) { other.hidden = sel.value !== 'Others'; if (!other.hidden) other.focus(); }
  }));
  // Per-row calculator: tally amounts and drop the sum into this row's Amount.
  $$('#rcRows .rc-calc').forEach(b => b.addEventListener('click', () => openCalcModal(+b.dataset.calc)));
  wireDbCells('#rcRows');
}

// A small calculator (over the claim form) that adds up several amounts and
// writes the total into row `rowIndex`'s Amount field.
function openCalcModal(rowIndex) {
  let entries = [];
  const sum = () => entries.reduce((a, b) => a + b, 0);
  openModal2(`
    <div class="modal-head"><h2>${esc(t('Add up amounts'))}</h2><button class="x-btn" id="calcClose">×</button></div>
    <div class="modal-body">
      <div class="calc-input-row">
        <input id="calcInput" inputmode="decimal" placeholder="${esc(t('Add an amount…'))}" />
        <button type="button" class="btn btn-ghost btn-sm" id="calcAdd">${esc(t('Add'))}</button>
      </div>
      <ul class="calc-list" id="calcList"></ul>
      <div class="calc-foot">
        <div class="calc-total-wrap"><span>${esc(t('Total'))}</span><strong id="calcTotal">0</strong></div>
        <div class="calc-foot-btns">
          <button type="button" class="btn btn-ghost btn-sm" id="calcClear">${esc(t('Clear'))}</button>
          <button type="button" class="btn btn-primary btn-sm" id="calcApply">${esc(t('Use total'))}</button>
        </div>
      </div>
    </div>`);
  const render = () => {
    $('#calcList').innerHTML = entries.length
      ? entries.map((n, i) =>
          `<li><span class="mono">${groupAmount(String(n))}</span>
             <button type="button" data-i="${i}" aria-label="${esc(t('Remove'))}">×</button></li>`).join('')
      : `<li class="calc-empty">${esc(t('No amounts added yet.'))}</li>`;
    $('#calcTotal').textContent = groupAmount(String(sum())) || '0';
    $$('#calcList button[data-i]').forEach(b =>
      b.addEventListener('click', () => { entries.splice(+b.dataset.i, 1); render(); }));
  };
  const add = () => {
    const inp = $('#calcInput');
    const n = Number(String(inp.value).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) entries.push(n);
    inp.value = ''; inp.focus(); render();
  };
  $('#calcClose').addEventListener('click', closeModal2);
  $('#calcAdd').addEventListener('click', add);
  $('#calcInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  $('#calcInput').addEventListener('input', e => { e.target.value = groupAmount(e.target.value); });
  $('#calcClear').addEventListener('click', () => { entries = []; render(); });
  $('#calcApply').addEventListener('click', () => {
    readClaimRows();
    if (claimRows[rowIndex]) claimRows[rowIndex].amount = String(sum());
    closeModal2();
    renderClaimRows();
  });
  render();
  setTimeout(() => { const inp = $('#calcInput'); if (inp) inp.focus(); }, 0);
}

// ---------------------------------------------------------------------------
// Local drafts — an unsent "New claim" / "New meal allowance" / "New cash
// advance" form is kept in the browser so a mis-click, an accidental close, or
// a reload never throws the work away. Drafts are stored per signed-in user (so
// they never leak between accounts sharing a device) and per form type. Only
// the typed fields are saved — receipt files can't be serialized to storage, so
// those are re-attached when a claim draft is reopened.
//
// Two ways in: an explicit "Save draft" button, and an automatic save whenever
// the form is closed by its × / the scrim / Escape while it has content (the
// mis-click case). Pressing "Cancel" is treated as a deliberate discard, and a
// successful submit clears the draft. A reopened form shows a banner with a
// "Start fresh" option to drop the draft.
// ---------------------------------------------------------------------------
const DRAFT_BTN = { claim: '#newClaimBtn', meal: '#newMealBtn', advance: '#newAdvanceBtn' };
function draftKey(kind) { return `draft:${kind}:${state.user ? state.user.id : 'anon'}`; }
function loadDraft(kind) {
  try { const raw = localStorage.getItem(draftKey(kind)); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function saveDraftData(kind, data) {
  try { localStorage.setItem(draftKey(kind), JSON.stringify({ savedAt: Date.now(), data })); }
  catch { /* storage full / disabled — nothing more we can do */ }
  refreshDraftBadges();
}
function clearDraft(kind) {
  try { localStorage.removeItem(draftKey(kind)); } catch { /* ignore */ }
  refreshDraftBadges();
}
// Show a small dot on a "New …" button whenever that form has a saved draft, so
// the claimant can see one is waiting and reopen it.
function refreshDraftBadges() {
  for (const kind of Object.keys(DRAFT_BTN)) {
    const btn = $(DRAFT_BTN[kind]); if (!btn) continue;
    btn.classList.toggle('has-draft', !!loadDraft(kind));
  }
}

// The banner shown at the top of a form that was reopened from a saved draft.
// `note` is an optional extra line (used to remind claim drafts to re-attach
// receipts).
function draftBannerHtml(note) {
  return `<div class="draft-banner" id="draftBanner">
    <span class="draft-banner-txt">📝 ${esc(t('Picked up from your saved draft.'))}${note ? ' ' + esc(note) : ''}</span>
    <button type="button" class="draft-discard" id="draftDiscard">${esc(t('Start fresh'))}</button>
  </div>`;
}
// Wire the banner's "Start fresh": drop the draft and reopen the form empty.
function wireDraftBanner(kind, reopen) {
  const b = $('#draftDiscard'); if (!b) return;
  b.addEventListener('click', () => { clearDraft(kind); modalCloseHook = null; reopen(); });
}
// Auto-save on an accidental close (×, scrim, Escape). `collect` returns the
// draft data, or null when the form is effectively empty (nothing worth saving).
function armDraftAutosave(kind, collect) {
  modalCloseHook = () => {
    const data = collect();
    if (!data) { clearDraft(kind); return; }
    saveDraftData(kind, data);
    toast(t('Draft saved — reopen it from the New button.'));
  };
}
// Explicit "Save draft": save (if there's anything) and close.
function saveDraftAndClose(kind, collect) {
  const data = collect();
  if (!data) { toast(t('Nothing to save yet — fill in the form first.'), true); return; }
  saveDraftData(kind, data);
  modalCloseHook = null; // already saved; don't double-save on close
  toast(t('Draft saved'));
  closeModal();
}
// "Cancel": deliberate discard — drop any draft and close without saving.
function discardDraftAndClose(kind) { clearDraft(kind); modalCloseHook = null; closeModal(); }

function openClaimModal(existing = null) {
  const isEdit = !!existing;
  claimEditId = isEdit ? existing.id : null;
  rcAttachBase = '/api/claims';
  const draft = isEdit ? null : loadDraft('claim');
  if (isEdit) {
    claimRows = (existing.lines || []).map(l => ({
      line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: l.amount != null ? String(l.amount) : '', description: l.description || '',
      files: [], kept: (l.attachments || []).map(a => ({ id: a.id, original_name: a.original_name }))
    }));
    if (!claimRows.length) claimRows = [blankClaimRow()];
  } else if (draft && Array.isArray(draft.data.rows) && draft.data.rows.length) {
    // Restore the saved draft's rows, giving each a fresh files/kept pair
    // (receipts aren't stored, so they start empty and get re-attached).
    claimRows = draft.data.rows.map(r => ({ ...blankClaimRow(), ...r, files: [], kept: [] }));
  } else {
    claimRows = [blankClaimRow(todayWIB())];
  }
  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? esc(t('Edit & resubmit claim')) : esc(t('New reimbursement claim'))}</h2>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">
      <form id="claimForm" class="form">
        ${draft ? draftBannerHtml(t('Re-attach any receipts.')) : ''}
        <div class="meal-topbar">
          <button type="button" class="btn btn-brand-soft btn-sm" id="rcAddRow">${esc(t('+ Add row'))}</button>
        </div>
        ${claimLimitNote()}
        <p class="muted" style="margin:2px 0 6px;font-size:.82rem">${esc(t('One row per expense — attach that expense\'s receipts on its own row (PDF or images, up to 8 per row).'))}</p>
        <p class="form-error" id="claimError" hidden></p>
        <div class="meal-scroll">
          <div class="meal-table-wrap">
            <table class="meal-table rc-table">
              <colgroup>
                <col class="c-date" /><col class="c-db" /><col class="c-type" /><col class="c-amt" /><col /><col class="c-recv" /><col class="c-x" />
              </colgroup>
              <thead><tr>
                <th>${esc(t('Date'))}</th><th>${esc(t('DB No.'))}</th><th>${esc(t('Type of expense'))}</th>
                <th>${esc(t('Amount'))}</th><th>${esc(t('Description / purpose'))}</th>
                <th>${esc(t('Receipts'))}</th><th aria-label="${esc(t('Remove'))}"></th>
              </tr></thead>
              <tbody id="rcRows"></tbody>
            </table>
          </div>
          ${approver1PickerHtml(existing)}
          ${isEdit ? `<label class="full" style="margin-top:10px">${esc(t('Note to manager (optional)'))}
            <input name="resubmit_note" placeholder="${esc(t('What you changed since the rejection'))}" /></label>` : ''}
        </div>
        <div class="modal-actions meal-foot">
          <span class="meal-foot-total">${esc(t('TOTAL'))} <span class="meal-total" id="rcTotal">0</span></span>
          <button type="button" class="btn btn-ghost" id="cancelClaim">${esc(t('Cancel'))}</button>
          ${isEdit ? '' : `<button type="button" class="btn btn-ghost" id="rcSaveDraft">${esc(t('Save draft'))}</button>`}
          <button type="submit" class="btn btn-primary">${isEdit ? esc(t('Resubmit claim')) : esc(t('Submit claim'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#cancelClaim').addEventListener('click', isEdit ? closeModal : () => discardDraftAndClose('claim'));
  $('#rcAddRow').addEventListener('click', () => {
    readClaimRows(); claimRows.push(blankClaimRow()); renderClaimRows();
  });
  $('#claimForm').addEventListener('submit', e => submitClaim(e, existing));
  renderClaimRows();
  if (!isEdit) {
    // Preselect the draft's Approver 1 (the picker only renders when ≥2 choices).
    if (draft && draft.data.approver1) {
      const sel = $('#claimForm [name="approver1"]'); if (sel) sel.value = draft.data.approver1;
    }
    const collect = collectClaimDraft;
    $('#rcSaveDraft').addEventListener('click', () => saveDraftAndClose('claim', collect));
    armDraftAutosave('claim', collect);
    if (draft) wireDraftBanner('claim', () => openClaimModal());
  }
}
// Gather the claim form's typed fields into a draft payload, or null when every
// row is empty. Receipts are intentionally excluded (File objects can't persist).
function collectClaimDraft() {
  readClaimRows();
  const rows = claimRows.map(r => ({
    line_date: r.line_date || '', db_no: r.db_no || '', expense_type: r.expense_type || '',
    expense_type_other: r.expense_type_other || '', amount: r.amount || '', description: r.description || ''
  }));
  const filled = rows.some(r => r.line_date || r.db_no || r.expense_type || r.expense_type_other || r.amount || r.description);
  if (!filled) return null;
  const approver1 = (($('#claimForm [name="approver1"]') || {}).value) || '';
  return { rows, approver1 };
}

// Only PDFs and images are accepted. The <input accept> covers the file picker,
// but drag & drop bypasses it, so validate by MIME type (falling back to the
// extension when the browser doesn't report one).
function isAllowedUpload(f) {
  if (f.type) return f.type === 'application/pdf' || f.type.startsWith('image/');
  return /\.(pdf|jpe?g|png|gif|webp|heic|heif|bmp|tiff?|svg)$/i.test(f.name);
}
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB — hard ceiling for any one file
// Images are compressed to comfortably under this so they upload through our own
// origin (POST /api/uploads/direct) rather than the vercel.com direct-upload
// host, which some office networks / iOS setups can't reach. See DIRECT_BLOB_THRESHOLD.
const COMPRESS_TARGET = 3.6 * 1024 * 1024;

// iPhone photos: HEIC/HEIF. Browsers report the type as image/heic, image/heif
// or (often) an empty string, so fall back to the extension too.
function isHeic(f) {
  const t = (f.type || '').toLowerCase();
  return t === 'image/heic' || t === 'image/heif' || /\.(heic|heif)$/i.test(f.name || '');
}

// Decode a HEIC/HEIF photo and re-encode it as JPEG so it displays everywhere.
async function heicToJpeg(file) {
  const heic2any = await loadHeic2any();
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}

// Re-encode an oversized image to JPEG, shrinking quality then dimensions until
// it fits under `maxBytes`. Used to keep large photos under the 10 MB cap
// instead of rejecting them outright. Returns a new File.
async function compressImage(file, maxBytes) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => rej(new Error('decode failed'));
    im.src = dataUrl;
  });
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  // Only downscale genuinely enormous images. Real photos compress well, so we
  // keep the resolution high and only trim quality (or size, as a last resort)
  // by as much as it takes to slip under the cap — no more.
  const MAX_DIM = 6000;
  if (Math.max(w, h) > MAX_DIM) { const s = MAX_DIM / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let quality = 0.92, blob = null;
  for (let i = 0; i < 12; i++) {
    canvas.width = w; canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size <= maxBytes) break;
    if (quality > 0.6) quality -= 0.07;                     // first, ease quality down gently
    else { w = Math.round(w * 0.85); h = Math.round(h * 0.85); } // then, shrink size as a last resort
  }
  if (!blob) throw new Error('compress failed');
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}

// ---------------------------------------------------------------------------
// Receipt photo editor — crop, rotate, and (optionally) burn in a date + GPS
// location stamp. Opens for every picked image so a receipt photographed on a
// phone can be straightened/tightened and carries a tamper-evident capture
// stamp, the way dedicated "GPS camera" apps produce. PDFs and animated GIFs
// skip it (nothing to crop/rotate). Returns a new JPEG File, the untouched
// original (if the browser can't decode it), or null when the user cancels.
// ---------------------------------------------------------------------------
const STAMP_FONT = '-apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Draw `img` rotated by `deg` degrees into a new canvas sized to the rotated
// image's bounding box. Shared by the on-screen preview and the full-res export
// so the two always agree on geometry.
function rotatedImageCanvas(img, deg) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const rad = deg * Math.PI / 180;
  const s = Math.abs(Math.sin(rad)), c = Math.abs(Math.cos(rad));
  const bw = Math.max(1, Math.round(w * c + h * s));
  const bh = Math.max(1, Math.round(w * s + h * c));
  const cnv = document.createElement('canvas');
  cnv.width = bw; cnv.height = bh;
  const ctx = cnv.getContext('2d');
  ctx.translate(bw / 2, bh / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return cnv;
}

// One-shot geolocation as a promise.
function getPositionOnce(opts) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(resolve, reject, opts);
  });
}

// Turn a coordinate into a street address via our same-origin proxy (which
// forwards to a public geocoder). Best-effort — null on any failure.
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`/api/geocode?lat=${lat}&lon=${lon}&lang=${encodeURIComponent(I18N.getLang())}`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.address) || null;
  } catch { return null; }
}

// Format the capture time as "16 Aug 2026 · 14:32:07 GMT+7".
function fmtStampTime(d) {
  const M = I18N.months();
  const p2 = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
  const gmt = `GMT${sign}${oh}${om ? ':' + p2(om) : ''}`;
  return `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()} · `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${gmt}`;
}
// Signed decimal coordinate → "3.589200°N" style.
function fmtLat(v) { return `${Math.abs(v).toFixed(6)}°${v >= 0 ? 'N' : 'S'}`; }
function fmtLon(v) { return `${Math.abs(v).toFixed(6)}°${v >= 0 ? 'E' : 'W'}`; }

// Wrap `text` to physical lines no wider than maxWidth (ctx.font already set).
function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = []; let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (!cur || ctx.measureText(test).width <= maxWidth) cur = test;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// Burn a bottom-anchored capture stamp into `box` (x,y,w,h) of `ctx`. `lines`
// is [{ text, bold }]. Font sizes scale with box.w, so the preview (drawn into
// the crop rectangle) and the export (drawn into the full-res crop) look the
// same. Address lines are clamped to two rows so the band can't swallow the
// photo.
function drawCaptureStamp(ctx, box, lines) {
  if (!lines || !lines.length) return;
  const fs = Math.min(Math.max(box.w * 0.026, 12), 44);
  const headFs = fs * 1.14;
  const padX = fs * 0.85, padY = fs * 0.62, lineGap = fs * 0.34, accent = Math.max(3, fs * 0.24);
  const textLeft = padX + accent + fs * 0.5;
  const maxTextW = box.w - textLeft - padX;
  // Expand logical lines into physical (wrapped) rows carrying their own font.
  const rows = [];
  lines.forEach(ln => {
    const size = ln.bold ? headFs : fs;
    ctx.font = `${ln.bold ? 700 : 500} ${size}px ${STAMP_FONT}`;
    let wrapped = wrapTextLines(ctx, ln.text, maxTextW);
    if (wrapped.length > 2) { // clamp long addresses to two rows + ellipsis
      wrapped = wrapped.slice(0, 2);
      while (wrapped[1] && ctx.measureText(wrapped[1] + '…').width > maxTextW && wrapped[1].length > 1) {
        wrapped[1] = wrapped[1].slice(0, -1);
      }
      wrapped[1] = (wrapped[1] || '').replace(/\s+$/, '') + '…';
    }
    wrapped.forEach(txt => rows.push({ txt, size, bold: ln.bold }));
  });
  const rowH = fs * 1.32;
  const bandH = padY * 2 + rows.length * rowH;
  const bandY = box.y + box.h - bandH;
  ctx.save();
  // Dark translucent band across the bottom of the crop.
  ctx.fillStyle = 'rgba(18,18,20,0.58)';
  ctx.fillRect(box.x, bandY, box.w, bandH);
  // Brand accent bar on the left.
  ctx.fillStyle = '#f7982a';
  ctx.fillRect(box.x + padX, bandY + padY, accent, bandH - padY * 2);
  // Text.
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = fs * 0.18;
  let ty = bandY + padY;
  rows.forEach(r => {
    ctx.font = `${r.bold ? 700 : 500} ${r.size}px ${STAMP_FONT}`;
    ctx.fillStyle = r.bold ? '#ffffff' : 'rgba(255,255,255,0.92)';
    ctx.fillText(r.txt, box.x + textLeft, ty + (rowH - r.size) / 2);
    ty += rowH;
  });
  ctx.restore();
}

// The editor itself. Resolves with a File (edited JPEG), the original file (on
// a decode error), or null (cancelled).
function editImage(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); }; // can't decode — attach as-is
    img.onload = () => setup();
    img.src = url;

    let settled = false;
    function settle(result) {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      document.removeEventListener('keydown', onKey, true);
      $('#modal2Scrim').removeEventListener('click', onScrim);
      $('#modal2').classList.remove('ph-modal');
      closeModal2();
      resolve(result);
    }
    const onScrim = () => settle(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(null); }
    };

    function setup() {
      const shotAt = new Date();
      let quarter = 0;          // 0/90/180/270 from the rotate buttons
      let fine = 0;             // -45..45 straighten slider
      let stampOn = true;
      let geo = null;           // { lat, lon, acc, address? }
      let geoStatus = 'idle';   // idle | locating | located | denied
      let crop = null;          // { x, y, w, h } in stage (display) pixels
      let stageW = 0, stageH = 0, rc = null;
      const totalDeg = () => ((quarter + fine) % 360 + 360) % 360;

      openModal2(`
        <div class="modal-head"><h2>${esc(t('Edit photo'))}</h2>
          <button class="x-btn" id="phCancelX" aria-label="${esc(t('Cancel'))}">×</button></div>
        <div class="modal-body ph-body">
          <div class="ph-stage" id="phStage">
            <canvas class="ph-canvas" id="phCanvas"></canvas>
            <div class="ph-crop" id="phCrop">
              <span class="ph-handle" data-h="nw"></span><span class="ph-handle" data-h="ne"></span>
              <span class="ph-handle" data-h="sw"></span><span class="ph-handle" data-h="se"></span>
            </div>
          </div>
          <div class="ph-tools">
            <div class="ph-rotrow">
              <button type="button" class="btn btn-ghost btn-sm" id="phRotL">↺ ${esc(t('Rotate left'))}</button>
              <button type="button" class="btn btn-ghost btn-sm" id="phRotR">↻ ${esc(t('Rotate right'))}</button>
              <button type="button" class="btn btn-ghost btn-sm" id="phReset">${esc(t('Reset'))}</button>
            </div>
            <label class="ph-fine">
              <span>${esc(t('Straighten'))}</span>
              <input type="range" id="phFine" min="-45" max="45" step="1" value="0" />
              <output id="phFineOut">0°</output>
            </label>
            <label class="ph-stamp-toggle">
              <input type="checkbox" id="phStamp" checked />
              <span>${esc(t('Stamp date & location'))}</span>
            </label>
            <div class="ph-stamp-preview" id="phStampInfo"></div>
          </div>
        </div>
        <div class="ph-foot">
          <button type="button" class="btn btn-ghost" id="phCancel">${esc(t('Cancel'))}</button>
          <button type="button" class="btn btn-primary" id="phAttach">${esc(t('Attach photo'))}</button>
        </div>`);
      $('#modal2').classList.add('modal-wide', 'ph-modal');
      document.addEventListener('keydown', onKey, true);
      $('#modal2Scrim').addEventListener('click', onScrim);

      const stageEl = $('#phStage'), canvas = $('#phCanvas'), cropEl = $('#phCrop');

      // Build the stage for the current rotation and (re)fit the crop box.
      function layout(resetCrop) {
        rc = rotatedImageCanvas(img, totalDeg());
        // Fit the rotated image into the available modal space.
        const maxW = Math.min(stageEl.parentElement.clientWidth || 560, 620);
        const maxH = 440;
        const scale = Math.min(maxW / rc.width, maxH / rc.height, 1);
        stageW = Math.max(1, Math.round(rc.width * scale));
        stageH = Math.max(1, Math.round(rc.height * scale));
        canvas.width = stageW; canvas.height = stageH;
        stageEl.style.width = stageW + 'px';
        stageEl.style.height = stageH + 'px';
        if (resetCrop || !crop) crop = { x: 0, y: 0, w: stageW, h: stageH };
        else clampCrop();
        draw();
      }

      function clampCrop() {
        const min = 28;
        crop.w = Math.max(min, Math.min(crop.w, stageW));
        crop.h = Math.max(min, Math.min(crop.h, stageH));
        crop.x = Math.max(0, Math.min(crop.x, stageW - crop.w));
        crop.y = Math.max(0, Math.min(crop.y, stageH - crop.h));
      }

      // Current stamp lines (empty when the stamp is switched off).
      function stampLines() {
        if (!stampOn) return [];
        const lines = [{ text: fmtStampTime(new Date(shotAt)), bold: true }];
        if (geo) {
          if (geo.address) lines.push({ text: geo.address });
          lines.push({ text: `${fmtLat(geo.lat)}  ${fmtLon(geo.lon)}  ±${Math.round(geo.acc)} m` });
        } else if (geoStatus === 'locating') {
          lines.push({ text: t('Locating…') });
        } else if (geoStatus === 'denied') {
          lines.push({ text: t('Location unavailable') });
        }
        return lines;
      }

      function draw() {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, stageW, stageH);
        ctx.drawImage(rc, 0, 0, rc.width, rc.height, 0, 0, stageW, stageH);
        // Preview the stamp inside the crop rectangle (same proportions as export).
        drawCaptureStamp(ctx, { x: crop.x, y: crop.y, w: crop.w, h: crop.h }, stampLines());
        cropEl.style.left = crop.x + 'px';
        cropEl.style.top = crop.y + 'px';
        cropEl.style.width = crop.w + 'px';
        cropEl.style.height = crop.h + 'px';
        renderStampInfo();
      }

      function renderStampInfo() {
        const el = $('#phStampInfo');
        if (!stampOn) { el.innerHTML = `<span class="muted">${esc(t('No stamp will be added.'))}</span>`; return; }
        const loc = geo
          ? (geo.address ? esc(geo.address) : `${esc(fmtLat(geo.lat))} ${esc(fmtLon(geo.lon))}`)
          : geoStatus === 'locating' ? esc(t('Locating…'))
          : geoStatus === 'denied' ? esc(t('Location unavailable'))
          : '';
        el.innerHTML = `<strong>📅 ${esc(fmtStampTime(new Date(shotAt)))}</strong>`
          + (loc ? `<span>📍 ${loc}</span>` : '');
      }

      // Ask for location the first time the stamp is (or stays) enabled.
      function ensureGeo() {
        if (!stampOn || geoStatus !== 'idle') return;
        geoStatus = 'locating'; renderStampInfo(); draw();
        getPositionOnce({ enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 })
          .then(async pos => {
            geo = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 0 };
            geoStatus = 'located'; draw();
            const addr = await reverseGeocode(geo.lat, geo.lon);
            if (addr && geo) { geo.address = addr; draw(); }
          })
          .catch(() => { geoStatus = 'denied'; draw(); });
      }

      // -- Crop drag/resize (pointer events, touch-friendly) --
      let drag = null;
      function stagePoint(e) {
        const r = stageEl.getBoundingClientRect();
        const z = r.width / stageW || 1; // account for the page's CSS zoom
        return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
      }
      function onDown(e, mode, handle) {
        e.preventDefault();
        const p = stagePoint(e);
        drag = { mode, handle, sx: p.x, sy: p.y, orig: { ...crop } };
        try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      function onMove(e) {
        if (!drag) return;
        const p = stagePoint(e);
        const dx = p.x - drag.sx, dy = p.y - drag.sy, o = drag.orig, min = 28;
        if (drag.mode === 'move') {
          crop.x = Math.max(0, Math.min(o.x + dx, stageW - o.w));
          crop.y = Math.max(0, Math.min(o.y + dy, stageH - o.h));
        } else {
          let x = o.x, y = o.y, w = o.w, h = o.h;
          const H = drag.handle;
          if (H.includes('e')) w = Math.max(min, Math.min(o.w + dx, stageW - o.x));
          if (H.includes('s')) h = Math.max(min, Math.min(o.h + dy, stageH - o.y));
          if (H.includes('w')) { const nx = Math.max(0, Math.min(o.x + dx, o.x + o.w - min)); w = o.w + (o.x - nx); x = nx; }
          if (H.includes('n')) { const ny = Math.max(0, Math.min(o.y + dy, o.y + o.h - min)); h = o.h + (o.y - ny); y = ny; }
          crop = { x, y, w, h };
        }
        draw();
      }
      function onUp() { drag = null; }

      cropEl.addEventListener('pointerdown', e => {
        if (e.target.classList.contains('ph-handle')) onDown(e, 'resize', e.target.dataset.h);
        else onDown(e, 'move', null);
      });
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      // Tidy the document-level listeners when the editor closes.
      const cleanup = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };

      // -- Controls --
      $('#phRotL').addEventListener('click', () => { quarter -= 90; layout(true); });
      $('#phRotR').addEventListener('click', () => { quarter += 90; layout(true); });
      $('#phReset').addEventListener('click', () => {
        quarter = 0; fine = 0; $('#phFine').value = '0'; $('#phFineOut').textContent = '0°'; layout(true);
      });
      $('#phFine').addEventListener('input', e => {
        fine = Number(e.target.value) || 0;
        $('#phFineOut').textContent = `${fine}°`;
        layout(true);
      });
      $('#phStamp').addEventListener('change', e => {
        stampOn = e.target.checked;
        if (stampOn) ensureGeo();
        draw();
      });
      const cancel = () => { cleanup(); settle(null); };
      $('#phCancel').addEventListener('click', cancel);
      $('#phCancelX').addEventListener('click', cancel);
      $('#phAttach').addEventListener('click', async () => {
        cleanup();
        try {
          const out = rotatedImageCanvas(img, totalDeg()); // full-res rotated
          const sc = out.width / stageW;                   // stage px → full-res px
          const cw = Math.max(1, Math.round(crop.w * sc)), ch = Math.max(1, Math.round(crop.h * sc));
          const cnv = document.createElement('canvas');
          cnv.width = cw; cnv.height = ch;
          const cx = cnv.getContext('2d');
          cx.drawImage(out, crop.x * sc, crop.y * sc, crop.w * sc, crop.h * sc, 0, 0, cw, ch);
          drawCaptureStamp(cx, { x: 0, y: 0, w: cw, h: ch }, stampLines());
          const blob = await new Promise(res => cnv.toBlob(res, 'image/jpeg', 0.92));
          if (!blob) throw new Error('encode failed');
          const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          settle(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
        } catch {
          toast(t("Couldn't process the photo — attaching the original"), true);
          settle(file);
        }
      });

      layout(true);
      ensureGeo();
      window.addEventListener('resize', () => layout(false), { once: true });
    }
  });
}

// Validate, HEIC-convert and compress a picked file list into accepted File[].
// `alreadyCount` is the row's current file count, so it can't exceed 8.
async function processFiles(list, alreadyCount = 0) {
  const out = [];
  for (const f of Array.from(list)) {
    if (alreadyCount + out.length >= 8) { toast(t('Maximum 8 files'), true); break; }
    if (!isAllowedUpload(f)) { toast(t('{name}: only PDF or image files are allowed', { name: f.name }), true); continue; }
    let file = f;
    // iPhone HEIC/HEIF photos aren't viewable in browsers, so convert them to
    // JPEG up front (regardless of size) before the 10 MB check below.
    if (isHeic(file)) {
      toast(t('Converting {name}…', { name: f.name }));
      try { file = await heicToJpeg(file); }
      catch { toast(t("{name}: couldn't read this iPhone photo", { name: f.name }), true); continue; }
    }
    // Every still image opens the crop / rotate / stamp editor before it is
    // compressed. Animated GIFs and PDFs skip it (nothing to crop, and re-encoding
    // would flatten a GIF). A null result means the user cancelled — drop it.
    const editable = file.type && file.type.startsWith('image/') && file.type !== 'image/gif';
    if (editable) {
      const edited = await editImage(file);
      if (!edited) continue; // cancelled in the editor
      file = edited;
    }
    // Compress images down to the same-origin upload capacity so they take the
    // reliable path through our own domain. Modern phone photos are often 4–8 MB,
    // which would otherwise route to the vercel.com direct-upload host that some
    // networks block. PDFs and animated GIFs can't be re-encoded.
    const compressible = file.type && file.type.startsWith('image/') && file.type !== 'image/gif';
    if (compressible && file.size > COMPRESS_TARGET) {
      toast(t('Compressing {name}…', { name: f.name }));
      try { file = await compressImage(file, COMPRESS_TARGET); }
      catch { toast(t("{name}: couldn't compress — please shrink it and retry", { name: f.name }), true); continue; }
    }
    if (file.size > MAX_UPLOAD) { toast(t('{name} exceeds 10 MB', { name: f.name }), true); continue; }
    out.push(file);
  }
  return out;
}
// Chips for the claim's receipts: the ones already saved (openable, so the
// claimant can check what is there before replacing it) followed by the files
// picked in this session. Removing either kind is what drops it from the claim.
function renderChips() {
  const saved = keptAttachments.map((a, i) =>
    `<span class="file-chip file-chip-saved">
      <a href="/api/claims/${keptClaimId}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.original_name)}</a>
      <button type="button" data-kind="kept" data-i="${i}" aria-label="${esc(t('Remove'))} ${esc(a.original_name)}">×</button>
    </span>`);
  const picked = pendingFiles.map((f, i) =>
    `<span class="file-chip">${esc(f.name)}
      <button type="button" data-kind="new" data-i="${i}" aria-label="${esc(t('Remove'))} ${esc(f.name)}">×</button>
    </span>`);
  $('#fileChips').innerHTML = saved.concat(picked).join('');
  $$('#fileChips button').forEach(b => b.addEventListener('click', () => {
    (b.dataset.kind === 'kept' ? keptAttachments : pendingFiles).splice(+b.dataset.i, 1);
    renderChips();
  }));
}

// Send an in-memory blob via XMLHttpRequest, resolving with the parsed JSON
// response. We use XHR rather than fetch() because iOS Safari reports upload
// failures as an opaque "Load failed" with no detail; XHR distinguishes
// network / timeout / HTTP-status errors and reports upload progress.
function xhrSend(method, url, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    // Note: no withCredentials — same-origin requests send the session cookie
    // automatically, and the cross-origin Blob PUT must stay credential-less
    // (its response uses a wildcard CORS origin, which credentials would block).
    xhr.setRequestHeader('content-type', contentType || 'application/octet-stream');
    xhr.timeout = 120000; // 2 min — generous for a large photo on mobile data
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('the upload response could not be read')); }
      } else {
        let msg = `the server returned ${xhr.status}`;
        try { const j = JSON.parse(xhr.responseText); if (j && j.error) msg = j.error; } catch { /* keep default */ }
        // Attach the status (and any Retry-After) so the caller can tell a
        // transient 429 rate-limit apart from a deterministic 4xx/5xx.
        const err = new Error(msg);
        err.status = xhr.status;
        const ra = xhr.getResponseHeader('retry-after');
        if (ra) err.retryAfter = ra;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('a network error interrupted the upload'));
    xhr.ontimeout = () => reject(new Error('the upload timed out'));
    xhr.onabort = () => reject(new Error('the upload was cancelled'));
    xhr.send(body);
  });
}

// Files at or under this size upload through our own origin (reliable); larger
// files must go directly to Blob to clear the serverless ~4.5 MB body limit.
const DIRECT_BLOB_THRESHOLD = 4 * 1024 * 1024;

// Parse a Retry-After header (delta-seconds or an HTTP-date) into milliseconds,
// or null when it is absent or unparseable.
function retryAfterMs(v) {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Upload one already-materialized receipt. A network blip or timeout is worth
// exactly one retry; an HTTP 429 (rate limiting — Vercel's edge throttles the
// burst of back-to-back receipt uploads) is transient too, so we retry it a few
// times with exponential backoff, honoring a Retry-After header when present.
// Every other HTTP-status and bad-response error is deterministic and rethrown.
async function sendReceipt(method, url, body, contentType, onProgress) {
  const MAX_429_RETRIES = 3;
  let rateLimitTries = 0, netTries = 0;
  for (;;) {
    try {
      return await xhrSend(method, url, body, contentType, onProgress);
    } catch (e) {
      if (e.status === 429 && rateLimitTries < MAX_429_RETRIES) {
        rateLimitTries++;
        const server = retryAfterMs(e.retryAfter);
        // Fall back to 1s / 2s / 4s backoff with jitter when the server gives
        // no Retry-After, so parallel uploads don't all wake at once.
        const backoff = Math.min(8000, 1000 * 2 ** (rateLimitTries - 1)) + Math.random() * 250;
        await wait(server === null ? backoff : server);
        continue;
      }
      if (/network error|timed out/.test(e.message) && netTries < 1) {
        netTries++;
        continue;
      }
      throw e;
    }
  }
}

// Upload the chosen receipts and return the metadata to attach to the claim.
// Small files (the common case — phone photos, most PDFs) go through our own
// domain, which is reliable everywhere the app itself loads. Only genuinely
// large files use a presigned direct-to-Blob URL, since they can't fit through
// the size-limited API route. Files are already compressed/validated by addFiles().
async function uploadReceipts(files, onProgress) {
  if (!files.length) return [];
  // Presign only the large files that must bypass our API route.
  const large = files.map((f, i) => ({ f, i })).filter(x => x.f.size > DIRECT_BLOB_THRESHOLD);
  const presigned = {};
  if (large.length) {
    const { uploads } = await api('/uploads/presign', {
      method: 'POST',
      body: JSON.stringify({ files: large.map(x => ({ name: x.f.name, type: x.f.type, size: x.f.size })) })
    });
    large.forEach((x, k) => { presigned[x.i] = uploads[k].presignedUrl; });
  }
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const prog = onProgress ? frac => onProgress(i, files.length, frac) : null;
    // iOS Safari can fail to stream a File backed by a fresh camera capture, so
    // read the bytes into an in-memory Blob first (the same read the compression
    // path does), which sidesteps that bug.
    const type = f.type || 'application/octet-stream';
    const body = new Blob([await f.arrayBuffer()], { type });
    const viaDirect = f.size > DIRECT_BLOB_THRESHOLD;
    let blob;
    try {
      blob = viaDirect
        ? await sendReceipt('PUT', presigned[i], body, type, prog)
        : await sendReceipt('POST', `/api/uploads/direct?name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(type)}`, body, type, prog);
    } catch (e) {
      // The trailing tag names which path failed, to aid diagnosis: "storage
      // host" = the direct vercel.com upload (large files); "our server" = the
      // same-origin API route (small files).
      throw new Error(`Couldn't upload ${f.name} via ${viaDirect ? 'storage host' : 'our server'} — ${e.message}. Please retry.`);
    }
    out.push({ url: blob.url, original_name: f.name });
  }
  return out;
}

async function submitClaim(e, existing) {
  e.preventDefault();
  readClaimRows();
  const err = $('#claimError'); err.hidden = true;
  // Keep only rows the claimant actually filled in (any field or receipt).
  const rows = claimRows.filter(r =>
    r.line_date || r.db_no || String(r.expense_type || '').trim() || r.description
    || rcAmt(r.amount) || (r.files || []).length || (r.kept || []).length);
  if (!rows.length) { err.textContent = t('Add at least one expense line with a date, type and amount.'); err.hidden = false; return; }
  // Resolve each row's expense type ("Others" uses its specify field).
  const rowType = (r) => r.expense_type === 'Others' ? String(r.expense_type_other || '').trim() : String(r.expense_type || '').trim();
  for (const r of rows) {
    if (!r.line_date) { err.textContent = t('Every row needs a date.'); err.hidden = false; return; }
    if (r.expense_type === 'Others' && !String(r.expense_type_other || '').trim()) {
      err.textContent = t('Please specify the expense type for the "Others" row.'); err.hidden = false; return;
    }
    if (!rowType(r)) { err.textContent = t('Every row needs a type of expense.'); err.hidden = false; return; }
    if (rcAmt(r.amount) <= 0) { err.textContent = t('Every row needs a positive amount.'); err.hidden = false; return; }
  }
  // Claim-date policy: block any row dated before the allowed floor.
  const earliest = claimEarliest();
  if (earliest && rows.some(r => String(r.line_date || '') < earliest)) {
    err.textContent = t('Expenses dated before {date} can no longer be claimed.', { date: earliest });
    err.hidden = false; return;
  }
  const approver1 = String((new FormData(e.target).get('approver1') || '')).trim();
  if ((state.user.approver1_choices || []).length >= 2 && !approver1) {
    err.textContent = t('Please choose Approver 1.'); err.hidden = false; return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    // Upload each row's receipts to Blob, then send the claim as JSON carrying
    // only their metadata (keeping large files off the size-limited API route).
    if (rows.some(r => (r.files || []).length)) btn.textContent = t('Uploading receipts…');
    const lines = [];
    for (const r of rows) {
      const uploaded = (r.files || []).length ? await uploadReceipts(r.files) : [];
      lines.push({
        line_date: r.line_date, db_no: r.db_no, expense_type: rowType(r),
        amount: r.amount, description: r.description,
        attachments: uploaded, keep_attachment_ids: (r.kept || []).map(a => a.id)
      });
    }
    const payload = { lines, currency: regionCurrency() };
    if (approver1) payload.approver1 = Number(approver1);
    btn.textContent = existing ? t('Resubmitting…') : t('Submitting…');
    if (existing) {
      payload.resubmit_note = String((new FormData(e.target).get('resubmit_note') || '')).trim();
      await api('/claims/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(t('Claim resubmitted'));
    } else {
      await api('/claims', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('Claim submitted'));
      clearDraft('claim');
    }
    modalCloseHook = null; // submitted — don't auto-save a draft on close
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    btn.disabled = false; btn.textContent = label;
  }
}

$('#newClaimBtn').addEventListener('click', () => openClaimModal());

// ---------------------------------------------------------------------------
// New meal allowance — a line-item claim form mirroring the paper
// "Meal Allowance Claim Form": a title, an editable table (one row per day),
// a live total, and the rate note at the bottom.
// ---------------------------------------------------------------------------
// A running total in the region's default currency (Settings → Currency & time
// zone). Mirrors money()'s locale/currency convention so the live total in a
// claim form reads the same as the claim will once submitted — and follows the
// region when its default currency changes (e.g. IDR → USD).
function liveAmt(n) { return money(n || 0, regionCurrency()); }
const mealAmount = (s) => { const n = Number(String(s == null ? '' : s).replace(/[^0-9]/g, '')); return Number.isFinite(n) ? n : 0; };

// The preset meal-allowance amounts are configured per region in Settings → Meal
// allowance and loaded into state.mealRates. The Amount field is a dropdown of
// those amounts.
const mealRateList = () => (state.mealRates && state.mealRates.length ? state.mealRates : []);
function mealAmountSelect(val) {
  const cur = mealAmount(val);
  const rates = mealRateList();
  // Preserve any legacy/custom amount from an older claim so editing never
  // silently drops it — show it as an extra selected option when it isn't one
  // of the configured presets.
  const known = new Set(rates);
  const extra = cur && !known.has(cur) ? `<option value="${cur}" selected>${groupAmount(String(cur))}</option>` : '';
  return `<select name="amount" class="meal-amt">
    <option value="" ${cur ? '' : 'selected'}>${esc(t('— select —'))}</option>
    ${extra}
    ${rates.map(n => `<option value="${n}" ${cur === n ? 'selected' : ''}>${esc(groupAmount(String(n)))}</option>`).join('')}
  </select>`;
}

let mealRows = [];
function mealRowHtml(r, i) {
  return `<tr data-i="${i}">
    <td data-label="${esc(t('Date'))}"><input name="date" type="date" ${claimEarliest() ? `min="${esc(claimEarliest())}"` : ''} value="${esc(r.date || '')}" /></td>
    <td data-label="${esc(t('DB Number Site'))}">${dbCellHtml(r.site)}</td>
    <td data-label="${esc(t('Job Category'))}"><input name="category" value="${esc(r.category || '')}" placeholder="${esc(t('Install / Repair / Service…'))}" /></td>
    <td data-label="${esc(t('Amount'))}">${mealAmountSelect(r.amount)}</td>
    <td data-label="${esc(t('Additional Description'))}"><input name="desc" value="${esc(r.desc || '')}" placeholder="${esc(t('Surabaya'))}" /></td>
    <td class="meal-x"><button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove'))}">×</button></td>
  </tr>`;
}
function readMealRows() {
  mealRows = $$('#mealRows tr[data-i]').map(tr => ({
    date: tr.querySelector('[name="date"]').value,
    site: dbCellRead(tr),
    category: tr.querySelector('[name="category"]').value,
    amount: tr.querySelector('[name="amount"]').value,
    desc: tr.querySelector('[name="desc"]').value
  }));
}
function mealTotal() { return mealRows.reduce((s, r) => s + mealAmount(r.amount), 0); }
function renderMealRows() {
  $('#mealRows').innerHTML = mealRows.length
    ? mealRows.map(mealRowHtml).join('')
    : `<tr><td colspan="6" class="muted" style="padding:14px;text-align:center">${esc(t('No rows yet — add one below.'))}</td></tr>`;
  $('#mealTotal').textContent = liveAmt(mealTotal());
  $$('#mealRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    readMealRows(); mealRows.splice(+b.dataset.rm, 1); renderMealRows();
  }));
  $$('#mealRows .meal-amt').forEach(sel => sel.addEventListener('change', () => {
    readMealRows(); $('#mealTotal').textContent = liveAmt(mealTotal());
  }));
  wireDbCells('#mealRows');
}

async function openMealAllowanceModal(existing = null) {
  // Refresh the Amount-dropdown presets for the submitter's region every time the
  // form opens. state.mealRates is seeded at login but can be stale (e.g. an admin
  // just changed them in Settings), so re-fetch to keep the form connected to the
  // saved amounts. A failure keeps whatever presets we already have.
  try { state.mealRates = (await api('/meal-rates')).rates || state.mealRates; } catch { /* keep current */ }
  const isEdit = !!existing;
  const draft = isEdit ? null : loadDraft('meal');
  if (isEdit) {
    // Prefill from the claim being resubmitted.
    mealRows = (existing.lines || []).map(l => ({
      date: l.line_date, site: l.site, category: l.job_category,
      amount: l.amount != null ? Math.round(l.amount) : '', desc: l.description
    }));
    if (!mealRows.length) mealRows = [{ date: '', site: '', category: '', amount: '', desc: '' }];
  } else if (draft && Array.isArray(draft.data.rows) && draft.data.rows.length) {
    mealRows = draft.data.rows.map(r => ({
      date: r.date || '', site: r.site || '', category: r.category || '', amount: r.amount || '', desc: r.desc || ''
    }));
  } else {
    // Start with a handful of blank rows, like the paper form.
    mealRows = Array.from({ length: 5 }, () => ({ date: '', site: '', category: '', amount: '', desc: '' }));
  }
  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? esc(t('Edit & resubmit meal allowance')) : esc(t('Meal Allowance Claim Form'))}</h2>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">
      <form id="mealForm" class="form">
        ${draft ? draftBannerHtml() : ''}
        <div class="meal-topbar">
          <button type="button" class="btn btn-brand-soft btn-sm" id="mealAddRow">${esc(t('+ Add row'))}</button>
        </div>
        ${claimLimitNote()}
        <p class="form-error" id="mealError" hidden></p>
        <div class="meal-scroll">
          <div class="meal-table-wrap">
            <table class="meal-table">
              <thead>
                <tr>
                  <th>${esc(t('Date'))}</th><th>${esc(t('DB Number Site'))}</th><th>${esc(t('Job Category'))}</th>
                  <th>${esc(t('Amount'))}</th><th>${esc(t('Additional Description'))}</th><th aria-label="${esc(t('Remove'))}"></th>
                </tr>
              </thead>
              <tbody id="mealRows"></tbody>
            </table>
          </div>
          ${approver1PickerHtml(existing)}
          ${isEdit ? `<label class="full" style="margin-top:10px">${esc(t('Note to manager (optional)'))}
            <input name="resubmit_note" placeholder="${esc(t('What you changed since the rejection'))}" /></label>` : ''}
        </div>
        <div class="modal-actions meal-foot">
          <span class="meal-foot-total">${esc(t('TOTAL CLAIM MEAL ALLOWANCE'))} <span class="meal-total" id="mealTotal">0</span></span>
          <button type="button" class="btn btn-ghost" id="mealCancel">${esc(t('Cancel'))}</button>
          ${isEdit ? '' : `<button type="button" class="btn btn-ghost" id="mealSaveDraft">${esc(t('Save draft'))}</button>`}
          <button type="submit" class="btn btn-primary">${isEdit ? esc(t('Resubmit claim')) : esc(t('Submit claim'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#mealCancel').addEventListener('click', isEdit ? closeModal : () => discardDraftAndClose('meal'));
  $('#mealAddRow').addEventListener('click', () => {
    readMealRows(); mealRows.push({ date: '', site: '', category: '', amount: '', desc: '' }); renderMealRows();
  });
  $('#mealForm').addEventListener('submit', e => submitMealClaim(e, existing));
  renderMealRows();
  if (!isEdit) {
    if (draft && draft.data.approver1) {
      const sel = $('#mealForm [name="approver1"]'); if (sel) sel.value = draft.data.approver1;
    }
    $('#mealSaveDraft').addEventListener('click', () => saveDraftAndClose('meal', collectMealDraft));
    armDraftAutosave('meal', collectMealDraft);
    if (draft) wireDraftBanner('meal', () => openMealAllowanceModal());
  }
}
// Gather the meal form's typed fields into a draft payload, or null when empty.
function collectMealDraft() {
  readMealRows();
  const rows = mealRows.map(r => ({
    date: r.date || '', site: r.site || '', category: r.category || '', amount: r.amount || '', desc: r.desc || ''
  }));
  const filled = rows.some(r => r.date || r.site || r.category || r.amount || r.desc);
  if (!filled) return null;
  const approver1 = (($('#mealForm [name="approver1"]') || {}).value) || '';
  return { rows, approver1 };
}

async function submitMealClaim(e, existing) {
  e.preventDefault();
  readMealRows();
  const err = $('#mealError'); err.hidden = true;
  const lines = mealRows
    .filter(r => r.date || r.site || r.category || r.desc || mealAmount(r.amount))
    .map(r => ({ date: r.date, site: r.site, category: r.category, amount: mealAmount(r.amount), desc: r.desc }));
  if (!lines.length) { err.textContent = t('Add at least one line with a date and amount'); err.hidden = false; return; }
  // Claim-date policy: block any line dated before the allowed floor.
  const earliest = claimEarliest();
  if (earliest && lines.some(l => String(l.date || '') < earliest)) {
    err.textContent = t('Expenses dated before {date} can no longer be claimed.', { date: earliest });
    err.hidden = false; return;
  }
  const needsApprover1 = (state.user.approver1_choices || []).length >= 2;
  const approver1 = String((new FormData(e.target).get('approver1') || '')).trim();
  if (needsApprover1 && !approver1) { err.textContent = t('Please choose Approver 1.'); err.hidden = false; return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const payload = { lines };
  if (needsApprover1) payload.approver1 = Number(approver1);
  if (existing) payload.resubmit_note = (new FormData(e.target).get('resubmit_note') || '').trim();
  try {
    if (existing) {
      await api('/meal-claims/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(t('Meal claim resubmitted'));
    } else {
      await api('/meal-claims', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('Meal claim submitted'));
      clearDraft('meal');
    }
    modalCloseHook = null; // submitted — don't auto-save a draft on close
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
}
$('#newMealBtn').addEventListener('click', () => openMealAllowanceModal());

// ---------------------------------------------------------------------------
// Cash advance — a two-stage document. Stage 1: request the advance (purpose +
// amount), which runs the approver chain and is disbursed by finance. Stage 2
// (once paid): realize it by submitting the actual transactions as an itemised
// line table with receipts — the same editor as a reimbursement claim.
// ---------------------------------------------------------------------------
// Stage 1 request form: purpose + amount (+ Approver 1 when chooseable). Reused
// for editing a rejected request.
function openAdvanceRequestModal(existing = null) {
  const isEdit = !!existing;
  const draft = isEdit ? null : loadDraft('advance');
  // For a new request, seed the fields from the saved draft if there is one.
  const prePurpose = isEdit ? (existing.purpose || '') : (draft ? draft.data.purpose || '' : '');
  const preAmount = isEdit
    ? (existing.amount != null ? groupAmount(String(Math.round(existing.amount))) : '')
    : (draft ? groupAmount(String(draft.data.amount || '')) : '');
  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? esc(t('Edit & resubmit cash advance')) : esc(t('New cash advance'))}</h2>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">
      <form id="advForm" class="form">
        ${draft ? draftBannerHtml() : ''}
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">${esc(t('Ask for a cash advance up front. Once it is approved and paid, you will settle it by submitting your actual transactions.'))}</p>
        <label class="full">${esc(t('Purpose of the cash advance'))} <span style="color:var(--danger,#d33)">*</span>
          <textarea name="purpose" rows="3" required placeholder="${esc(t('What is this advance for?'))}">${esc(prePurpose)}</textarea></label>
        <label class="full">${esc(t('Amount needed'))} <span style="color:var(--danger,#d33)">*</span>
          <input name="amount" inputmode="decimal" required placeholder="0" value="${esc(preAmount)}" /></label>
        ${approver1PickerHtml(existing)}
        ${isEdit ? `<label class="full">${esc(t('Note to manager (optional)'))}
          <input name="resubmit_note" placeholder="${esc(t('What you changed since the rejection'))}" /></label>` : ''}
        <p class="form-error" id="advError" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="advCancel">${esc(t('Cancel'))}</button>
          ${isEdit ? '' : `<button type="button" class="btn btn-ghost" id="advSaveDraft">${esc(t('Save draft'))}</button>`}
          <button type="submit" class="btn btn-primary">${isEdit ? esc(t('Resubmit request')) : esc(t('Submit request'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#advCancel').addEventListener('click', isEdit ? closeModal : () => discardDraftAndClose('advance'));
  const amt = $('#advForm [name="amount"]');
  amt.addEventListener('input', e => { e.target.value = groupAmount(e.target.value); });
  $('#advForm').addEventListener('submit', e => submitAdvanceRequest(e, existing));
  if (!isEdit) {
    if (draft && draft.data.approver1) {
      const sel = $('#advForm [name="approver1"]'); if (sel) sel.value = draft.data.approver1;
    }
    $('#advSaveDraft').addEventListener('click', () => saveDraftAndClose('advance', collectAdvanceDraft));
    armDraftAutosave('advance', collectAdvanceDraft);
    if (draft) wireDraftBanner('advance', () => openAdvanceRequestModal());
  }
}
// Gather the cash-advance form's fields into a draft payload, or null when both
// the purpose and the amount are empty.
function collectAdvanceDraft() {
  const f = $('#advForm'); if (!f) return null;
  const purpose = ((f.querySelector('[name="purpose"]') || {}).value || '').trim();
  const amountRaw = ((f.querySelector('[name="amount"]') || {}).value || '');
  const amount = String(amountRaw).replace(/[^0-9.]/g, '');
  if (!purpose && !amount) return null;
  const approver1 = ((f.querySelector('[name="approver1"]') || {}).value) || '';
  return { purpose, amount, approver1 };
}

async function submitAdvanceRequest(e, existing) {
  e.preventDefault();
  const err = $('#advError'); err.hidden = true;
  const fd = new FormData(e.target);
  const purpose = String(fd.get('purpose') || '').trim();
  const amount = Number(String(fd.get('amount') || '').replace(/[^0-9.]/g, ''));
  if (!purpose) { err.textContent = t('Please describe the purpose of the cash advance.'); err.hidden = false; return; }
  if (!(amount > 0)) { err.textContent = t('Enter the advance amount.'); err.hidden = false; return; }
  const needsApprover1 = (state.user.approver1_choices || []).length >= 2;
  const approver1 = String(fd.get('approver1') || '').trim();
  if (needsApprover1 && !approver1) { err.textContent = t('Please choose Approver 1.'); err.hidden = false; return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const payload = { purpose, amount, currency: regionCurrency() };
  if (needsApprover1) payload.approver1 = Number(approver1);
  try {
    if (existing) {
      payload.resubmit_note = String(fd.get('resubmit_note') || '').trim();
      await api('/cash-advances/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(t('Cash advance resubmitted'));
    } else {
      await api('/cash-advances', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('Cash advance requested'));
      clearDraft('advance');
    }
    modalCloseHook = null; // submitted — don't auto-save a draft on close
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
}
$('#newAdvanceBtn').addEventListener('click', () => openAdvanceRequestModal());

// Stage 2 realization form: the actual transactions as an itemised line table
// (the reimbursement-claim editor), with a live "advance vs spent" banner.
function realizeDiffBanner(advanceAmount) {
  const spent = claimTotal();
  const diff = spent - advanceAmount;
  const cls = diff > 0 ? 'adv-diff-topup' : diff < 0 ? 'adv-diff-return' : 'adv-diff-even';
  const msg = diff > 0 ? t('Over the advance by {amt} — a top-up will be owed to you.', { amt: liveAmt(diff) })
    : diff < 0 ? t('Under the advance by {amt} — you will return this balance.', { amt: liveAmt(-diff) })
    : t('Exactly matches the advance.');
  return `<div class="adv-diff ${cls}">
      <div class="adv-diff-row"><span>${esc(t('Advance received'))}</span><strong>${esc(liveAmt(advanceAmount))}</strong></div>
      <div class="adv-diff-row"><span>${esc(t('Total spent'))}</span><strong id="advSpent">${esc(liveAmt(spent))}</strong></div>
      <div class="adv-diff-msg" id="advDiffMsg">${esc(msg)}</div>
    </div>`;
}
function openRealizeModal(advance) {
  const isEdit = advance.status === 'rejected_realize';
  claimEditId = advance.id;
  rcAttachBase = '/api/cash-advances';
  if (isEdit && (advance.lines || []).length) {
    claimRows = advance.lines.map(l => ({
      line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: l.amount != null ? String(l.amount) : '', description: l.description || '',
      files: [], kept: (l.attachments || []).map(a => ({ id: a.id, original_name: a.original_name }))
    }));
    if (!claimRows.length) claimRows = [blankClaimRow(todayWIB())];
  } else {
    claimRows = [blankClaimRow(todayWIB())];
  }
  openModal(`
    <div class="modal-head">
      <h2>${esc(t('Realize cash advance {no}', { no: advance.advance_no }))}</h2>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">
      <form id="realizeForm" class="form">
        <div class="meal-topbar">
          <button type="button" class="btn btn-brand-soft btn-sm" id="rcAddRow">${esc(t('+ Add row'))}</button>
        </div>
        <p class="muted" style="margin:2px 0 6px;font-size:.82rem">${esc(t('Account for the advance: one row per expense, with that expense\'s receipts attached (PDF or images, up to 8 per row).'))}</p>
        <div id="advDiffWrap">${realizeDiffBanner(advance.amount)}</div>
        <p class="form-error" id="claimError" hidden></p>
        <div class="meal-scroll">
          <div class="meal-table-wrap">
            <table class="meal-table rc-table">
              <colgroup>
                <col class="c-date" /><col class="c-db" /><col class="c-type" /><col class="c-amt" /><col /><col class="c-recv" /><col class="c-x" />
              </colgroup>
              <thead><tr>
                <th>${esc(t('Date'))}</th><th>${esc(t('DB No.'))}</th><th>${esc(t('Type of expense'))}</th>
                <th>${esc(t('Amount'))}</th><th>${esc(t('Description / purpose'))}</th>
                <th>${esc(t('Receipts'))}</th><th aria-label="${esc(t('Remove'))}"></th>
              </tr></thead>
              <tbody id="rcRows"></tbody>
            </table>
          </div>
          ${approver1PickerHtml(isEdit ? advance : null)}
          ${isEdit ? `<label class="full" style="margin-top:10px">${esc(t('Note to manager (optional)'))}
            <input name="resubmit_note" placeholder="${esc(t('What you changed since the rejection'))}" /></label>` : ''}
        </div>
        <div class="modal-actions meal-foot">
          <span class="meal-foot-total">${esc(t('TOTAL'))} <span class="meal-total" id="rcTotal">0</span></span>
          <button type="button" class="btn btn-ghost" id="cancelRealize">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(t('Submit realization'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#cancelRealize').addEventListener('click', closeModal);
  $('#rcAddRow').addEventListener('click', () => { readClaimRows(); claimRows.push(blankClaimRow()); renderClaimRows(); });
  // Refresh the difference banner whenever the line total changes.
  rcTotalHook = () => {
    const spent = claimTotal();
    const sp = $('#advSpent'); if (sp) sp.textContent = liveAmt(spent);
    const wrap = $('#advDiffWrap'); if (wrap) wrap.innerHTML = realizeDiffBanner(advance.amount);
  };
  $('#realizeForm').addEventListener('submit', e => submitRealization(e, advance));
  renderClaimRows();
}

async function submitRealization(e, advance) {
  e.preventDefault();
  readClaimRows();
  const err = $('#claimError'); err.hidden = true;
  const rows = claimRows.filter(r =>
    r.line_date || r.db_no || String(r.expense_type || '').trim() || r.description
    || rcAmt(r.amount) || (r.files || []).length || (r.kept || []).length);
  if (!rows.length) { err.textContent = t('Add at least one expense line with a date, type and amount.'); err.hidden = false; return; }
  const rowType = (r) => r.expense_type === 'Others' ? String(r.expense_type_other || '').trim() : String(r.expense_type || '').trim();
  for (const r of rows) {
    if (!r.line_date) { err.textContent = t('Every row needs a date.'); err.hidden = false; return; }
    if (r.expense_type === 'Others' && !String(r.expense_type_other || '').trim()) {
      err.textContent = t('Please specify the expense type for the "Others" row.'); err.hidden = false; return;
    }
    if (!rowType(r)) { err.textContent = t('Every row needs a type of expense.'); err.hidden = false; return; }
    if (rcAmt(r.amount) <= 0) { err.textContent = t('Every row needs a positive amount.'); err.hidden = false; return; }
  }
  const earliest = claimEarliest();
  if (earliest && rows.some(r => String(r.line_date || '') < earliest)) {
    err.textContent = t('Expenses dated before {date} can no longer be claimed.', { date: earliest }); err.hidden = false; return;
  }
  const needsApprover1 = (state.user.approver1_choices || []).length >= 2;
  const approver1 = String((new FormData(e.target).get('approver1') || '')).trim();
  if (needsApprover1 && !approver1) { err.textContent = t('Please choose Approver 1.'); err.hidden = false; return; }
  const isEdit = advance.status === 'rejected_realize';
  const btn = e.target.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    if (rows.some(r => (r.files || []).length)) btn.textContent = t('Uploading receipts…');
    const lines = [];
    for (const r of rows) {
      const uploaded = (r.files || []).length ? await uploadReceipts(r.files) : [];
      lines.push({
        line_date: r.line_date, db_no: r.db_no, expense_type: rowType(r),
        amount: r.amount, description: r.description,
        attachments: uploaded, keep_attachment_ids: (r.kept || []).map(a => a.id)
      });
    }
    const payload = { lines };
    if (needsApprover1) payload.approver1 = Number(approver1);
    btn.textContent = t('Submitting…');
    if (isEdit) {
      payload.resubmit_note = String((new FormData(e.target).get('resubmit_note') || '')).trim();
      await api('/cash-advances/' + advance.id + '/realize', { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/cash-advances/' + advance.id + '/realize', { method: 'POST', body: JSON.stringify(payload) });
    }
    toast(t('Realization submitted'));
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = label; }
}

// Settle a fully-approved realization (finance records the top-up / return).
function openSettleModal(c) {
  const diff = (c.realized_total || 0) - (c.amount || 0);
  const line = diff > 0 ? t('A top-up of {amt} is owed to the employee.', { amt: money(diff, c.currency) })
    : diff < 0 ? t('The employee returns {amt}.', { amt: money(-diff, c.currency) })
    : t('The advance and the actual spend match exactly.');
  openModal(`
    <div class="modal-head"><h2>${esc(t('Settle {no}', { no: c.advance_no }))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="settleForm" class="form">
        <dl class="kv">
          <dt>${esc(t('Advance paid'))}</dt><dd>${esc(money(c.amount, c.currency))}</dd>
          <dt>${esc(t('Total realized'))}</dt><dd>${esc(money(c.realized_total, c.currency))}</dd>
          <dt>${esc(t('Difference'))}</dt><dd>${esc(money(Math.abs(diff), c.currency))}</dd>
        </dl>
        <p class="muted" style="margin:6px 0">${esc(line)}</p>
        <label class="full">${esc(t('Settlement note (optional)'))}
          <input name="note" placeholder="${esc(t('e.g. top-up paid / balance received on…'))}" /></label>
        <p class="form-error" id="settleErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="settleCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(t('Confirm settlement'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#settleCancel').addEventListener('click', closeModal);
  $('#settleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = String((new FormData(e.target).get('note') || '')).trim();
    const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
    try {
      await api('/cash-advances/' + c.id + '/settle', { method: 'POST', body: JSON.stringify({ note }) });
      toast(t('Cash advance settled'));
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#settleErr'); el.textContent = ex.message; el.hidden = false; btn.disabled = false; }
  });
}

// ---------------------------------------------------------------------------
// Reject modal
// ---------------------------------------------------------------------------
// Mark as paid — a payment date must be chosen before the claim can be recorded
// as paid. Defaults to today; the confirm button stays disabled until a date is
// present.
function openPaidModal(c) {
  const today = todayWIB();
  openModal(`
    <div class="modal-head"><h2>${esc(t('Mark {no} as paid', { no: c.claim_no }))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="paidForm" class="form">
        <label>${esc(t('Payment date'))}
          <input type="date" name="payment_date" value="${today}" max="${today}" required /></label>
        <p class="muted" style="margin:2px 0 0;font-size:.85rem">${esc(t('The date the payment was actually made.'))}</p>
        <p class="form-error" id="paidErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="paidCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary" id="paidConfirm">${esc(t('Mark as paid'))}</button>
        </div>
      </form>
    </div>`);
  const dateEl = $('#paidForm [name="payment_date"]');
  const confirmBtn = $('#paidConfirm');
  const sync = () => { confirmBtn.disabled = !dateEl.value; };
  dateEl.addEventListener('input', sync); sync();
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#paidCancel').addEventListener('click', closeModal);
  $('#paidForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payment_date = dateEl.value;
    if (!payment_date) return;
    const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
    try {
      await api(`${base}${c.id}/mark-paid`, { method: 'POST', body: JSON.stringify({ payment_date }) });
      toast(t('Marked as paid'));
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#paidErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
function openRejectModal(c) {
  openModal(`
    <div class="modal-head"><h2>${esc(t('Reject {no}', { no: c.claim_no }))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="rejectForm" class="form">
        <label>${esc(t('Reason for rejection (sent back to the claimant)'))}
          <textarea name="comment" required placeholder="${esc(t('Explain what needs to change…'))}"></textarea></label>
        <p class="form-error" id="rejErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="rejCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-danger">${esc(t('Reject & return'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#rejCancel').addEventListener('click', closeModal);
  $('#rejectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const comment = new FormData(e.target).get('comment').trim();
    const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
    try {
      await api(`${base}${c.id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) });
      toast(t('Claim returned to claimant'));
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#rejErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Export (finance) — choose a date range and one or more statuses; covers both
// reimbursement and meal allowance claims.
// ---------------------------------------------------------------------------
const EXPORT_STATUS_OPTS = [
  { v: 'submitted', l: 'Pending review' },
  { v: 'approved', l: 'Approved' },
  { v: 'rejected', l: 'Rejected' },
  { v: 'paid', l: 'Paid' }
];
$('#exportBtn').addEventListener('click', () => openExportModal());

async function openExportModal() {
  let users = [];
  try { ({ users } = await api('/claim-submitters')); } catch (ex) { toast(ex.message, true); return; }
  users.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));

  openModal(`
    <div class="modal-head"><h2>${esc(t('Export claims to CSV'))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="exportForm" class="form">
        <div class="grid2">
          <label>${esc(t('From date'))}<input name="from" type="date" value="${esc(state.filters.exportFrom || '')}" /></label>
          <label>${esc(t('To date'))}<input name="to" type="date" value="${esc(state.filters.exportTo || '')}" /></label>
        </div>
        <div class="date-presets">
          <button type="button" class="btn btn-ghost btn-sm" data-unit="month" data-off="0">${esc(t('This month'))}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-unit="month" data-off="1">${esc(t('Last month'))}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-unit="year" data-off="0">${esc(t('This year'))}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-unit="year" data-off="1">${esc(t('Last year'))}</button>
        </div>
        <div class="grid2 export-groups">
          <div class="export-group">
            <div class="section-label">${esc(t('Statuses to include'))}</div>
            <div class="check-group">
              ${EXPORT_STATUS_OPTS.map(o => `
                <label class="check-item"><input type="checkbox" name="status" value="${o.v}" checked /> ${esc(t(o.l))}</label>`).join('')}
            </div>
          </div>
          <div class="export-group">
            <div class="section-label">${esc(t('Claim types'))}</div>
            <div class="check-group">
              <label class="check-item"><input type="checkbox" name="types" value="reimbursement" checked /> ${esc(t('Reimbursement claims'))}</label>
              <label class="check-item"><input type="checkbox" name="types" value="meal" checked /> ${esc(t('Meal allowances'))}</label>
              <label class="check-item"><input type="checkbox" name="types" value="advance" checked /> ${esc(t('Cash advances (realized)'))}</label>
            </div>
          </div>
        </div>
        <div class="section-label" style="margin-top:6px">${esc(t('Users (submitters)'))}</div>
        <div class="user-filter">
          <div class="uf-toolbar">
            <input id="ufSearch" class="input" type="search" placeholder="${esc(t('Search names…'))}" />
            <button type="button" class="btn btn-ghost btn-sm" id="ufAll">${esc(t('Select all'))}</button>
            <button type="button" class="btn btn-ghost btn-sm" id="ufNone">${esc(t('Clear'))}</button>
          </div>
          <div class="uf-list" id="ufList">
            ${users.length ? users.map(u => `
              <label class="uf-item" data-name="${esc((u.full_name + ' ' + u.username).toLowerCase())}">
                <span class="uf-name">${esc(u.full_name)} <span class="muted">(${esc(u.username)})</span></span>
                <input type="checkbox" name="employee" value="${u.id}" checked />
              </label>`).join('') : `<p class="muted" style="padding:8px">${esc(t('No users.'))}</p>`}
          </div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:10px 0 0">${esc(t('Leave dates blank to export all dates. Dates apply to the expense / meal date.'))}</p>
        <p class="form-error" id="exportErr" hidden></p>
        <div class="modal-actions sticky-foot">
          <button type="button" class="btn btn-ghost" id="exportCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(t('Download CSV'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#exportCancel').addEventListener('click', closeModal);

  // Quick date presets: fill From/To with this or last calendar month / year.
  // Dates are formatted from local components (not toISOString) so the day never
  // shifts. `off` steps back one period; a 0 day rolls to the period's last day.
  const ymd = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  $$('.date-presets button').forEach(b => b.addEventListener('click', () => {
    const now = new Date();
    const off = Number(b.dataset.off) || 0;
    const first = b.dataset.unit === 'year'
      ? new Date(now.getFullYear() - off, 0, 1)
      : new Date(now.getFullYear(), now.getMonth() - off, 1);
    const last = b.dataset.unit === 'year'
      ? new Date(now.getFullYear() - off, 11, 31)
      : new Date(now.getFullYear(), now.getMonth() - off + 1, 0);
    $('#exportForm [name="from"]').value = ymd(first);
    $('#exportForm [name="to"]').value = ymd(last);
  }));

  // Excel-style user filter: search narrows the list; Select all / Clear act on
  // whatever rows are currently visible.
  const list = $('#ufList');
  const visibleBoxes = () => $$('.uf-item', list).filter(el => el.style.display !== 'none')
    .map(el => el.querySelector('input'));
  $('#ufSearch').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    $$('.uf-item', list).forEach(el => { el.style.display = el.dataset.name.includes(term) ? '' : 'none'; });
  });
  $('#ufAll').addEventListener('click', () => visibleBoxes().forEach(cb => { cb.checked = true; }));
  $('#ufNone').addEventListener('click', () => visibleBoxes().forEach(cb => { cb.checked = false; }));

  $('#exportForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#exportErr'); err.hidden = true;
    const fd = new FormData(e.target);
    const statuses = fd.getAll('status');
    const types = fd.getAll('types');
    const emps = fd.getAll('employee');
    if (!types.length) { err.textContent = t('Pick at least one claim type.'); err.hidden = false; return; }
    if (!emps.length) { err.textContent = t('Pick at least one user.'); err.hidden = false; return; }
    const from = fd.get('from'), to = fd.get('to');
    if (from && to && from > to) { err.textContent = t('The “from” date is after the “to” date.'); err.hidden = false; return; }
    const p = new URLSearchParams();
    if (statuses.length && statuses.length < EXPORT_STATUS_OPTS.length) p.set('status', statuses.join(','));
    if (types.length < 3) p.set('types', types.join(','));
    if (emps.length < users.length) p.set('employees', emps.join(','));
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    // Remember the chosen range for next time.
    state.filters.exportFrom = from; state.filters.exportTo = to;
    window.location.href = '/api/export.csv?' + p.toString();
    closeModal();
  });
}

// ---------------------------------------------------------------------------
// Profile — bank / payout details + change password (self-service, all users)
// ---------------------------------------------------------------------------
$('#profileBtn').addEventListener('click', () => openProfileModal());

// Bank name is picked from a short list (the region's preferred bank / Others).
// "Others" reveals a free text field for the actual bank name and shows a red
// fee note, since payouts to any non-preferred bank are charged the region's
// configured fee. The preferred bank and fee come from the account's region
// (Settings → per-region defaults); both fall back to the legacy BCA / IDR 2,500
// policy. `prefs` is { preferredBank, bankFee, currency }. Returns the markup;
// wiring is done by wireBankNameField after the modal is in the DOM.
function bankNameField(current, prefs) {
  const p = prefs || {};
  const preferred = String(p.preferredBank || 'BCA').trim() || 'BCA';
  const fee = Number.isFinite(p.bankFee) ? p.bankFee : 2500;
  const currency = p.currency || regionCurrency();
  const cur = String(current || '').trim();
  const isPreferred = cur.toLowerCase() === preferred.toLowerCase();
  const isOther = !!cur && !isPreferred;
  const choice = isPreferred ? 'PREF' : (isOther ? 'Others' : 'PREF'); // default to preferred when unset
  const feeNote = fee > 0
    ? `<p class="fee-note" id="bankFeeNote" ${choice === 'PREF' ? 'hidden' : ''}>${esc(t('⚠ A fee of {fee} is charged for every payment to a non-preferred bank account.', { fee: money(fee, currency) }))}</p>`
    : '';
  return `
    <label>${esc(t('Bank name'))}
      <select name="bank_choice" id="bankChoice" data-preferred="${esc(preferred)}">
        <option value="PREF" ${choice === 'PREF' ? 'selected' : ''}>${esc(preferred)}</option>
        <option value="Others" ${choice === 'Others' ? 'selected' : ''}>${esc(t('Others'))}</option>
      </select></label>
    <label id="bankOtherWrap" ${choice === 'Others' ? '' : 'hidden'}>${esc(t('Bank name (please specify)'))}
      <input name="bank_name_custom" id="bankNameCustom" value="${isOther ? esc(cur) : ''}" placeholder="${esc(t('Enter your bank name'))}" /></label>
    ${feeNote}`;
}
// Toggle the custom field + fee note as the bank choice changes. Returns a
// getter for the effective bank name to use on submit (the region's preferred
// bank name when "PREF" is selected, else the typed custom name).
function wireBankNameField() {
  const choice = $('#bankChoice');
  if (!choice) return () => '';
  const preferred = choice.getAttribute('data-preferred') || '';
  const wrap = $('#bankOtherWrap'), custom = $('#bankNameCustom'), note = $('#bankFeeNote');
  const sync = () => {
    const other = choice.value === 'Others';
    wrap.hidden = !other;
    if (note) note.hidden = !other;
  };
  choice.addEventListener('change', () => { sync(); if (choice.value === 'Others' && custom) custom.focus(); });
  sync();
  return () => choice.value === 'Others' ? String((custom && custom.value) || '').trim() : preferred;
}

async function openProfileModal() {
  // Fetch the current values (login response omits bank details).
  let me = state.user || {};
  try { ({ user: me } = await api('/me')); } catch { /* fall back to state.user */ }
  openModal(`
    <div class="modal-head"><h2>${esc(t('My profile'))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="profileForm" class="form">
        <div class="section-label">${esc(t('Contact'))}</div>
        <label>${esc(t('Email (used for password resets & notifications)'))}
          <input name="email" type="email" value="${esc(me.email || '')}" placeholder="${esc(t('you@company.com'))}" /></label>
        ${me.region ? `<div class="section-label" style="margin-top:14px">${esc(t('Region'))}</div>
        <p class="muted" style="margin:0">${esc(regionLabel(me.region))} <span style="font-size:.8rem">— ${esc(t('set by your administrator'))}</span></p>` : ''}
        <div class="section-label" style="margin-top:14px">${esc(t('Bank / payout details'))}</div>
        ${bankNameField(me.bank_name, { preferredBank: me.preferredBank, bankFee: me.bankFee, currency: me.currency })}
        <label>${esc(t('Recipient bank account name'))}<input name="recipient_name" value="${esc(me.recipient_name || '')}" placeholder="${esc(t('Name on the account'))}" /></label>
        <label>${esc(t('Bank account number'))}<input name="bank_account_no" inputmode="numeric" value="${esc(me.bank_account_no || '')}" placeholder="${esc(t('Account number'))}" /></label>
        <p class="form-note caution">${esc(t('The company is not responsible if you submit the wrong bank details. Please triple check and make sure it is your bank details and it is the right one. Thank you.'))}</p>
        <p class="form-error" id="profileErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="profileCancel">${esc(t('Close'))}</button>
          <button type="submit" class="btn btn-primary">${esc(t('Save details'))}</button>
        </div>
      </form>
      <form id="pwForm" class="form" style="border-top:1px solid var(--line);margin-top:18px;padding-top:16px">
        <div class="section-label">${esc(t('Change password'))}</div>
        <label>${esc(t('Current password'))}
          <div class="pw-wrap"><input name="current_password" type="password" required />
            <button type="button" class="pw-toggle" aria-label="${esc(t('Show password'))}">👁</button></div></label>
        <label>${esc(t('New password (min 8 characters)'))}
          <div class="pw-wrap"><input name="new_password" type="password" required minlength="8" />
            <button type="button" class="pw-toggle" aria-label="${esc(t('Show password'))}">👁</button></div></label>
        <p class="form-error" id="pwErr" hidden></p>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">${esc(t('Update password'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#profileCancel').addEventListener('click', closeModal);
  const bankName = wireBankNameField();

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#profileErr'); err.hidden = true;
    const fd = new FormData(e.target);
    const effectiveBank = bankName();
    if ($('#bankChoice').value === 'Others' && !effectiveBank) {
      err.textContent = t('Please enter your bank name.'); err.hidden = false; return;
    }
    try {
      const { user } = await api('/me', { method: 'PUT', body: JSON.stringify({
        email: fd.get('email'),
        bank_name: effectiveBank, recipient_name: fd.get('recipient_name'),
        bank_account_no: fd.get('bank_account_no') }) });
      if (user) state.user = { ...state.user, ...user };
      toast(t('Profile saved'));
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#pwErr'); err.hidden = true;
    const fd = new FormData(e.target);
    try {
      await api('/me/password', { method: 'POST', body: JSON.stringify({
        current_password: fd.get('current_password'), new_password: fd.get('new_password') }) });
      toast(t('Password updated')); e.target.reset();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Admin: Settings (accounts, departments, positions, expense types)
// ---------------------------------------------------------------------------
// Tabs inside a region workspace. Regions themselves live one level up (the
// Regions landing), so there is no Regions tab here.
const SETTINGS_TABS = [
  { key: 'accounts', label: 'Accounts', accounts: true },
  { key: 'departments', label: 'Departments', cap: 'manage_settings' },
  { key: 'positions', label: 'Job positions', cap: 'manage_settings' },
  { key: 'expense-types', label: 'Expense types', cap: 'manage_settings' },
  { key: 'meal-rates', label: 'Meal allowance', cap: 'manage_settings' },
  { key: 'claim-window', label: 'Claim window', cap: 'manage_settings' },
  { key: 'region-prefs', label: 'Currency, time zone & bank', regionPrefs: true },
  { key: 'roles', label: 'Roles', roleMatrix: true }
];
// Tabs visible to the current user. The Roles matrix is open to Super Admins, VPs
// and CM/MD (admins), who may edit the rows below their own; the rest need the
// matching capability.
function visibleSettingsTabs() {
  const u = state.user;
  const isSuper = u && u.role === 'superadmin';
  const isVp = u && u.role === 'vp';
  const isCmMd = u && u.role === 'admin';
  return SETTINGS_TABS.filter(tab => {
    if (tab.roleMatrix) return isSuper || isVp || isCmMd;
    // Currency & time zone: Super Admins (any region) and CM/MD (their own).
    if (tab.regionPrefs) return isSuper || isCmMd;
    // Accounts: Super Admins get the full editor; anyone who can create or manage
    // accounts (CM/MD, delegated seniors) gets the delegated view of the tab.
    if (tab.accounts) return isSuper || uCan('create_accounts') || !!(u && u.can_manage_accounts);
    if (tab.super) return isSuper;
    return tab.cap ? uCan(tab.cap) : true;
  });
}
const settingsState = { tab: 'accounts', positions: [], departments: [], users: [] };

$('#settingsBtn').addEventListener('click', () => openSettingsModal());
// Admins and delegated seniors share the same department-scoped, rank-limited
// "Manage accounts" screen; superadmins use full Settings instead.
$('#accountsBtn').addEventListener('click', () => openManageAccountsModal());

// Human-readable role labels used across the account tables. These are the
// system's formal role/position titles and are intentionally shown in English
// in every language (like "Super Admin" and "Managing Director"), so roleLabel
// deliberately does NOT run them through t(). Other uses of words like
// "Employee"/"Finance" (e.g. the Insights filter) still localise normally.
const ROLE_LABELS = { superadmin: 'Super Admin', vp: 'Vice President', admin: 'Country Manager / Managing Director', manager: 'Mid Management', lowmgmt: 'Low Management', finance: 'Finance', employee: 'Employee' };
const roleLabel = (r) => ROLE_LABELS[r] || r;
// Display label for an account/claim region: '*' -> All regions, '' -> em dash.
const regionLabel = (r) => r === '*' ? t('All regions') : (r || '—');
// Creation-audit sub-line for the account tables: who created this account, or
// "—" for accounts made directly (seed scripts) or before creator tracking.
const creatorLine = (u) =>
  `<div class="u-sub u-creator">${u.created_by_name ? esc(t('Created by {name}', { name: u.created_by_name })) : t('Created by {name}', { name: '—' })}</div>`;

// Settings entry point. A super admin first picks a region (the Regions
// landing); everyone else is pinned to their own region and drops straight into
// that region's workspace.
function openSettingsModal() {
  const u = state.user;
  const isSuper = u && u.role === 'superadmin';
  if (!isSuper) settingsState.region = String(u.region || '');
  if (isSuper && !settingsState.region) return openRegionsLanding();
  return openRegionWorkspace();
}

// Regions landing (super admin): cards to enter a region's workspace, plus the
// full region list manager (add / rename / enable-disable / delete) below.
function openRegionsLanding() {
  openModal(`
    <div class="modal-head">
      <h2>${esc(t('Regions'))}</h2>
      <div style="display:flex;gap:8px;align-items:center"><button class="x-btn">×</button></div>
    </div>
    <div class="modal-body"><div id="settingsPanel"></div></div>`);
  // Frozen-header model: the intro + region cards + add/search bar stay put
  // while the region table scrolls. renderRegionsLanding lays out #settingsPanel
  // so the table is a direct scrolling child (see there).
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  renderRegionsLanding();
}

async function renderRegionsLanding() {
  const panel = $('#settingsPanel');
  panel.innerHTML = `<p class="muted" style="padding:20px 0">${esc(t('Loading…'))}</p>`;
  let items;
  try { ({ items } = await api('/regions')); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const active = items.filter(r => r.active);
  // Render the region-list manager straight into the panel first, so its table
  // (.settings-list) is a direct flex child of #settingsPanel and owns the
  // scroll. Then pin a frozen header (intro + region cards + the "Manage
  // regions" label) above it — .settings-controls (add + search) stays frozen
  // too, so only the table scrolls.
  await renderLookupTab({ path: '/regions', noun: 'region' }, '#settingsPanel');
  const header = `
    <div class="region-landing-head">
      <p class="muted" style="margin:0 0 8px;font-size:.9rem">${esc(t('Choose a region to configure its accounts, departments, job positions, expense types, claim window and roles. Manage the region list below.'))}</p>
      <div class="region-grid">
        ${active.length ? active.map(r => `
          <button type="button" class="region-card" data-region="${esc(r.name)}">
            <span class="region-card-name">${esc(r.name)}</span>
            <span class="region-card-go" aria-hidden="true">→</span>
          </button>`).join('') : `<p class="muted">${esc(t('No regions yet. Add one below.'))}</p>`}
      </div>
      <div class="section-label" style="margin-top:10px">${esc(t('Manage regions'))}</div>
    </div>`;
  panel.insertAdjacentHTML('afterbegin', header);
  $$('#settingsPanel .region-card').forEach(c => c.addEventListener('click', () => {
    settingsState.region = c.dataset.region;
    settingsState.tab = 'accounts';
    openRegionWorkspace();
  }));
}

// A region's workspace: tabs for that region's settings. Super admins get a
// "← Regions" button to go back and switch regions; region-pinned managers do
// not (they only ever see their own).
function openRegionWorkspace() {
  const u = state.user;
  const isSuper = u && u.role === 'superadmin';
  const region = settingsState.region;
  const tabs = visibleSettingsTabs();
  if (!tabs.some(x => x.key === settingsState.tab)) settingsState.tab = tabs.length ? tabs[0].key : 'roles';
  openModal(`
    <div class="modal-head">
      <div class="ws-head">
        ${isSuper ? `<button type="button" class="btn btn-ghost btn-sm ws-back" id="wsBack">← ${esc(t('Regions'))}</button>` : ''}
        <h2>${esc(t('Settings'))}${region ? ` <span class="ws-region">${esc(region)}</span>` : ''}</h2>
      </div>
      <div style="display:flex;gap:8px;align-items:center"><button class="x-btn">×</button></div>
    </div>
    <div class="modal-body">
      <div class="tabs" id="settingsTabs">
        ${tabs.map(tab =>
          `<button class="tab ${tab.key === settingsState.tab ? 'active' : ''}" data-tab="${tab.key}">${esc(t(tab.label))}</button>`).join('')}
      </div>
      <div id="settingsPanel"></div>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  const back = $('#wsBack');
  if (back) back.addEventListener('click', () => { settingsState.region = null; openRegionsLanding(); });
  $$('#settingsTabs .tab').forEach(b =>
    b.addEventListener('click', () => { settingsState.tab = b.dataset.tab; openRegionWorkspace(); }));
  renderSettingsTab();
}

// Confirm email delivery: sends a test message (default: the admin's own email).
async function sendTestEmail() {
  const to = prompt(t('Send a test email to:'), (state.user && state.user.email) || '');
  if (to === null) return; // cancelled
  const btn = $('#testEmailBtn');
  btn.disabled = true;
  try {
    const r = await api('/test-email', { method: 'POST', body: JSON.stringify({ to: to.trim() }) });
    toast(t('Test email sent to {to}', { to: r.to }));
  } catch (ex) { toast(ex.message, true); }
  finally { btn.disabled = false; }
}

function renderSettingsTab() {
  const panel = $('#settingsPanel');
  settingsState.departments = state.lookups.departments;
  panel.innerHTML = `<p class="muted" style="padding:20px 0">${esc(t('Loading…'))}</p>`;
  if (settingsState.tab === 'accounts') return renderAccountsTab();
  if (settingsState.tab === 'claim-window') return renderClaimWindowTab();
  if (settingsState.tab === 'meal-rates') return renderMealRatesTab();
  if (settingsState.tab === 'region-prefs') return renderRegionPrefsTab();
  if (settingsState.tab === 'roles') return renderRolesTab();
  const cfg = {
    departments: { path: '/departments', noun: 'department', purposes: true, regional: true },
    positions: { path: '/positions', noun: 'job position', purposes: true, ranked: true, manage: true, regional: true },
    'expense-types': { path: '/expense-types', noun: 'expense type', regional: true }
  }[settingsState.tab];
  return renderLookupTab(cfg);
}

// --- Claim window (how far back an expense may be dated) ----------------------
// Superadmin-only editor for the rolling window (N days) and the absolute cutoff
// date. Both may be set; the effective floor shown is whichever is later.
async function renderClaimWindowTab() {
  const panel = $('#settingsPanel');
  // Scoped to the workspace region. This is a separate context from the logged-in
  // user's own claim limit (state.claimLimit, set by loadLookups), so it must not
  // overwrite it.
  const regionQS = settingsState.region ? `?region=${encodeURIComponent(settingsState.region)}` : '';
  let cw;
  try { cw = await api('/claim-window' + regionQS); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const status = cw.earliest
    ? t('Only expenses dated {date} or later can be claimed.', { date: cw.earliest })
    : t('No date limit is set — expenses of any date can be claimed.');
  panel.innerHTML = `
    <div class="settings-controls" style="max-width:560px">
      <p class="muted" style="margin:0 0 16px;font-size:.9rem">${esc(t('Set how far back an expense may be dated and still be claimable. Both rules apply — the effective earliest date is whichever is later.'))}</p>
      <form id="cwForm" class="form">
        <label>${esc(t('Maximum age (days)'))}
          <input name="max_age_days" type="number" min="0" max="3650" inputmode="numeric" placeholder="${esc(t('No limit'))}" value="${cw.max_age_days != null ? cw.max_age_days : ''}" />
          <span class="form-note" style="font-weight:400;color:var(--muted);font-size:.8rem">${esc(t('Expenses older than this many days cannot be claimed. Leave blank for no limit.'))}</span>
        </label>
        <label>${esc(t('Earliest allowed expense date'))}
          <input name="earliest_date" type="date" value="${esc(cw.earliest_date || '')}" />
          <span class="form-note" style="font-weight:400;color:var(--muted);font-size:.8rem">${esc(t('No expense dated before this can be claimed. Leave blank for no limit.'))}</span>
        </label>
        <div style="margin:14px 0;padding:10px 12px;background:var(--pine-tint);border:1px solid var(--line);border-radius:8px;font-size:.85rem;color:var(--ink-soft)">${esc(status)}</div>
        <p class="form-error" id="cwErr" hidden></p>
        <div class="modal-actions" style="justify-content:flex-start">
          <button type="submit" class="btn btn-primary btn-sm">${esc(t('Save'))}</button>
        </div>
      </form>
    </div>`;
  $('#cwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#cwErr'); err.hidden = true;
    const fd = new FormData(e.target);
    try {
      await api('/claim-window', { method: 'PUT', body: JSON.stringify({
        max_age_days: fd.get('max_age_days'), earliest_date: fd.get('earliest_date'),
        ...(settingsState.region ? { region: settingsState.region } : {})
      }) });
      toast(t('Claim date limit saved'));
      renderClaimWindowTab();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

// --- Meal allowance rates (per-region dropdown presets) ----------------------
// Editor for the preset amounts the Meal Allowance form's Amount dropdown offers,
// scoped to the workspace region. Each preset is an optional label + an amount.
// Saved via PUT /api/meal-rates; open to anyone with manage_settings.
let mealRatesEdit = [];
function mealRateEditRowHtml(n, i) {
  return `<div class="mr-row" data-i="${i}" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
    <input name="amount" class="mr-amt" inputmode="numeric" value="${n ? esc(groupAmount(String(n))) : ''}" placeholder="0" style="flex:1;min-width:0;margin:0" />
    <button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove'))}">×</button>
  </div>`;
}
function readMealRateEdit() {
  mealRatesEdit = $$('#mrRows [data-i]').map(el => mealAmount(el.querySelector('[name="amount"]').value));
}
function renderMealRateRows() {
  $('#mrRows').innerHTML = mealRatesEdit.length
    ? mealRatesEdit.map(mealRateEditRowHtml).join('')
    : `<p class="muted" style="margin:4px 0">${esc(t('No amounts yet — add one below.'))}</p>`;
  $$('#mrRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    readMealRateEdit(); mealRatesEdit.splice(+b.dataset.rm, 1); renderMealRateRows();
  }));
  // Group digits as the admin types, like the amount fields elsewhere.
  $$('#mrRows .mr-amt').forEach(inp => inp.addEventListener('input', () => {
    const pos = inp.value.length; inp.value = groupAmount(inp.value);
    // Keep the caret at the end (grouping shifts characters); good enough here.
    void pos;
  }));
}
async function renderMealRatesTab() {
  const panel = $('#settingsPanel');
  const regionQS = settingsState.region ? `?region=${encodeURIComponent(settingsState.region)}` : '';
  let data;
  try { data = await api('/meal-rates' + regionQS); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  mealRatesEdit = (data.rates || []).slice();
  if (!mealRatesEdit.length) mealRatesEdit = [0];
  panel.innerHTML = `
    <div class="settings-controls" style="max-width:320px">
      <p class="muted" style="margin:0 0 16px;font-size:.9rem">${esc(t('Set the preset amounts the Meal Allowance form offers in its Amount dropdown.'))}</p>
      <div id="mrRows"></div>
      <div style="margin-top:6px">
        <button type="button" class="btn btn-brand-soft btn-sm" id="mrAddRow">${esc(t('+ Add amount'))}</button>
      </div>
      <p class="form-error" id="mrErr" hidden style="margin-top:12px"></p>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:14px">
        <button type="button" class="btn btn-primary btn-sm" id="mrSave">${esc(t('Save'))}</button>
      </div>
    </div>`;
  renderMealRateRows();
  $('#mrAddRow').addEventListener('click', () => {
    readMealRateEdit(); mealRatesEdit.push(0); renderMealRateRows();
  });
  $('#mrSave').addEventListener('click', async () => {
    const err = $('#mrErr'); err.hidden = true;
    readMealRateEdit();
    // Keep only rows with a positive amount; a blank row is simply dropped.
    const rates = mealRatesEdit.filter(n => n > 0);
    try {
      const saved = await api('/meal-rates', { method: 'PUT', body: JSON.stringify({
        rates, ...(settingsState.region ? { region: settingsState.region } : {})
      }) });
      // If this is the signed-in user's own region, refresh the presets the meal
      // form uses so a new claim reflects the change without a reload.
      if (!settingsState.region || settingsState.region === state.user.region) {
        state.mealRates = saved.rates || [];
      }
      toast(t('Meal allowance amounts saved'));
      renderMealRatesTab();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

// --- Currency & time zone (per-region defaults) ------------------------------
// Country Managers / Managing Directors (their own region) and Super Admins (any
// region) set the region's default currency — stamped onto new claims — and its
// default time zone, which decides what counts as "today" for claim dates. Both
// are simple dropdowns saved via PUT /api/region-prefs.
const CURRENCY_NAMES = {
  IDR: 'Indonesian rupiah', USD: 'US dollar', THB: 'Thai baht', VND: 'Vietnamese đồng',
  KHR: 'Cambodian riel', MYR: 'Malaysian ringgit', KRW: 'South Korean won'
};
async function renderRegionPrefsTab() {
  const panel = $('#settingsPanel');
  const regionQS = settingsState.region ? `?region=${encodeURIComponent(settingsState.region)}` : '';
  let data;
  try { data = await api('/region-prefs' + regionQS); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const curOpts = (data.currencies || []).map(c =>
    `<option value="${esc(c)}" ${c === data.currency ? 'selected' : ''}>${esc(c)}${CURRENCY_NAMES[c] ? ` — ${esc(t(CURRENCY_NAMES[c]))}` : ''}</option>`).join('');
  const tzOpts = (data.timezones || []).map(z => {
    const off = tzOffsetLabel(z);
    return `<option value="${esc(z)}" ${z === data.timezone ? 'selected' : ''}>${esc(z)}${off ? ` (${esc(off)})` : ''}</option>`;
  }).join('');
  const feeCur = esc(data.currency || 'IDR');
  panel.innerHTML = `
    <div class="settings-controls" style="max-width:560px">
      <p class="muted" style="margin:0 0 16px;font-size:.9rem">${esc(t('Set the default currency and time zone for {region}. New claims use this currency, and the time zone decides what counts as “today” for claim dates.', { region: settingsState.region || t('this region') }))}</p>
      <form id="rpForm" class="form">
        <label>${esc(t('Default currency'))}
          <select name="currency">${curOpts}</select>
        </label>
        <label>${esc(t('Default time zone'))}
          <select name="timezone">${tzOpts}</select>
        </label>
        <div class="section-label" style="margin-top:14px">${esc(t('Bank / payout details'))}</div>
        <p class="muted" style="margin:0 0 10px;font-size:.85rem">${esc(t('Payments to the preferred bank are free; all other banks are charged this fee. This shows on each employee’s profile.'))}</p>
        <label>${esc(t('Preferred bank (no transfer fee)'))}
          <input name="bank" value="${esc(data.preferredBank || '')}" placeholder="${esc(t('Enter your bank name'))}" maxlength="60" />
        </label>
        <label>
          <span>${esc(t('Fee for payments to other banks'))} (<span id="rpFeeCur">${feeCur}</span>)</span>
          <input name="bankFee" inputmode="numeric" autocomplete="off" value="${data.bankFee != null ? esc(groupAmount(String(data.bankFee))) : ''}" />
        </label>
        <p class="form-error" id="rpErr" hidden></p>
        <div class="modal-actions" style="justify-content:flex-start">
          <button type="submit" class="btn btn-primary btn-sm">${esc(t('Save'))}</button>
        </div>
      </form>
    </div>`;
  // Keep the fee's currency hint in sync with the chosen default currency, so it
  // reflects the pending selection before the form is even saved.
  const rpCur = $('#rpForm [name="currency"]'), rpFeeCur = $('#rpFeeCur');
  if (rpCur && rpFeeCur) rpCur.addEventListener('change', () => { rpFeeCur.textContent = rpCur.value; });
  // Thousands separators + digits-only as the admin types (same as amount fields
  // elsewhere); commas are stripped again on submit via mealAmount().
  attachAmountGrouping($('#rpForm [name="bankFee"]'));
  $('#rpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#rpErr'); err.hidden = true;
    const fd = new FormData(e.target);
    try {
      await api('/region-prefs', { method: 'PUT', body: JSON.stringify({
        currency: fd.get('currency'), timezone: fd.get('timezone'),
        bank: fd.get('bank'), bankFee: mealAmount(fd.get('bankFee')),
        ...(settingsState.region ? { region: settingsState.region } : {})
      }) });
      toast(t('Saved'));
      // If the actor edited their own region, refresh so new-claim defaults and
      // date formatting pick up the change without a reload.
      if (state.user && String(state.user.region || '') === String(settingsState.region || '')) {
        try { const { user } = await api('/me'); if (user) state.user = { ...state.user, ...user }; } catch { /* keep going */ }
      }
      renderRegionPrefsTab();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

// --- Roles: region-scoped capability matrix ----------------------------------
// Rows are capabilities; columns are the region's roles (Super Admin is never
// shown — it always holds every permission). The Employee column is shown
// locked for reference; Vice President, Country Manager / MD, Mid Management,
// Low Management, and Finance are editable, and persist immediately via PUT.
// Which columns a given user may toggle comes from the server (editableRoles): a
// Super Admin edits every row below Super Admin, a VP every row below VP, a CM/MD
// only Mid/Low/Finance. Grants are additive on top of job-position / department /
// flag permissions, and apply only within the selected region.
async function renderRolesTab() {
  const panel = $('#settingsPanel');
  const region = settingsState.region;
  let data;
  try { data = await api('/role-permissions' + (region ? `?region=${encodeURIComponent(region)}` : '')); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const { capabilities, roles, editableRoles, matrix } = data;
  const editable = new Set(editableRoles || []);
  const head = `<th>${esc(t('Capability'))}</th>`
    + roles.map(r => `<th style="text-align:center;width:120px">${esc(roleLabel(r))}${editable.has(r) ? '' : `<div class="role-locked">${esc(t('Locked'))}</div>`}</th>`).join('');
  const cell = (cap, role) => {
    const on = !!(matrix[role] && matrix[role][cap]);
    const canEdit = editable.has(role);
    const title = canEdit ? '' : (role === 'employee'
      ? t('The Employee baseline is fixed.')
      : t('This role’s permissions are managed by a more senior administrator.'));
    return `<td class="tick-cell" style="text-align:center"><input type="checkbox" ${canEdit ? `data-role="${role}" data-cap="${cap}"` : 'disabled'} ${on ? 'checked' : ''}${title ? ` title="${esc(title)}"` : ''} /></td>`;
  };
  panel.innerHTML = `
    <div class="settings-controls">
      <p class="muted" style="margin:0 0 12px;font-size:.9rem">${esc(t('Set what each role in {region} can do. Super Admin always has every permission and is not shown. The Employee row is shown for reference. These grants are added on top of what a user already gets from their job position and department.', { region: region || t('this region') }))}</p>
    </div>
    <div class="settings-list">
      <div class="matrix-scroll">
      <table class="utable utable-matrix">
        <thead><tr>${head}</tr></thead>
        <tbody>${capabilities.map(c => `
          <tr>
            <td data-label="${esc(t('Capability'))}" class="name-cell">
              <div>${esc(t(c.label))}</div>
              <div class="u-sub" style="color:var(--muted);font-size:.8rem;font-weight:400">${esc(t(c.desc))}</div>
            </td>
            ${roles.map(r => cell(c.key, r)).join('')}
          </tr>`).join('')}</tbody>
      </table>
      </div>
    </div>`;
  $$('#settingsPanel input[data-cap]').forEach(cb => cb.addEventListener('change', async () => {
    const role = cb.dataset.role, cap = cb.dataset.cap, value = cb.checked;
    try {
      await api('/role-permissions', { method: 'PUT', body: JSON.stringify({ region, role, cap, value }) });
      toast(t('Saved'));
    } catch (ex) { cb.checked = !value; toast(ex.message, true); }
  }));
}

// --- Generic lookup manager (departments / positions / expense types) --------
async function renderLookupTab(cfg, mountSel = '#settingsPanel') {
  const panel = $(mountSel);
  // Regional lookups (departments / positions / expense types) are scoped to the
  // workspace's region; the region list itself is global. Reads carry ?region;
  // create/reorder carry it in the body. Edits/deletes are authorised server-side
  // from the row's own region, so they need nothing extra.
  const regionScoped = !!(cfg.regional && settingsState.region);
  const regionQS = regionScoped ? `?region=${encodeURIComponent(settingsState.region)}` : '';
  const regionBody = regionScoped ? { region: settingsState.region } : {};
  let items;
  try { ({ items } = await api(cfg.path + regionQS)); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }

  const p = !!cfg.purposes;         // purpose gates (New claim / New meal allowance)
  const ranked = !!cfg.ranked;      // reorderable seniority ladder (job positions)
  const manage = !!cfg.manage;      // "Can manage accounts" delegation flag
  const noun = t(cfg.noun);         // localised singular noun for this lookup
  // A tick cell wires a boolean flag column (persisted immediately via PUT).
  const flagCell = (it, flag, label) =>
    `<td class="tick-cell" data-label="${esc(label)}"><input type="checkbox" data-flag="${flag}" data-id="${it.id}" ${it[flag] ? 'checked' : ''} /></td>`;
  // Up/down reorder controls for a ranked row (disabled at the ends).
  const orderCell = (it, i) => `<td class="ord-cell" data-label="${esc(t('Order'))}">
      <div class="ord-btns">
        <button type="button" class="ord-btn" data-move="up" data-id="${it.id}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('Move up'))}">▲</button>
        <button type="button" class="ord-btn" data-move="down" data-id="${it.id}" ${i === items.length - 1 ? 'disabled' : ''} aria-label="${esc(t('Move down'))}">▼</button>
      </div></td>`;
  const headCols = (ranked ? `<th style="width:64px">${esc(t('Order'))}</th>` : '') + `<th>${esc(t('Name'))}</th><th>${esc(t('Active'))}</th>`
    + (p ? `<th>${esc(t('New claim'))}</th><th>${esc(t('New meal allowance'))}</th><th>${esc(t('New cash advance'))}</th>` : '')
    + (manage ? `<th>${esc(t('Manage accounts'))}</th>` : '')
    + '<th class="u-actions-h"></th>';
  const colspan = 2 + (ranked ? 1 : 0) + (p ? 3 : 0) + (manage ? 1 : 0) + 1;
  panel.innerHTML = `
    <div class="settings-controls">
      <form id="lookupForm" class="form" style="margin-bottom:10px">
        <div style="display:flex;gap:8px;align-items:flex-end">
          <label style="flex:1;margin:0">${esc(t('Add {noun}', { noun }))}<input name="name" required placeholder="${esc(t('Name'))}" /></label>
          <button type="submit" class="btn btn-primary btn-sm">${esc(t('Add'))}</button>
        </div>
        <p class="form-error" id="lookupErr" hidden></p>
      </form>
      <div class="settings-search">
        <input id="lookupSearch" class="input" type="search" placeholder="${esc(t('Search {noun}…', { noun }))}" />
      </div>
    </div>
    <div class="settings-list">
      <table class="utable utable-lookup">
        <thead><tr>${headCols}</tr></thead>
        <tbody>${items.length ? items.map((it, i) => `
          <tr data-id="${it.id}">
            ${ranked ? orderCell(it, i) : ''}
            <td data-label="${esc(t('Name'))}" class="name-cell">${esc(it.name)}</td>
            <td data-label="${esc(t('Active'))}">${it.active ? esc(t('Yes')) : esc(t('No'))}</td>
            ${p ? flagCell(it, 'allow_claim', t('New claim')) + flagCell(it, 'allow_meal', t('New meal allowance')) + flagCell(it, 'allow_advance', t('New cash advance')) : ''}
            ${manage ? flagCell(it, 'can_manage', t('Manage accounts')) : ''}
            <td class="act-cell" data-label="${esc(t('Actions'))}">
              <div class="u-actions">
                <button class="btn btn-brand-soft btn-sm" data-rename="${it.id}">${esc(t('Edit'))}</button>
                <button class="btn ${it.active ? 'btn-amber-soft' : 'btn-green-soft'} btn-sm" data-toggle="${it.id}">${it.active ? esc(t('Disable')) : esc(t('Enable'))}</button>
                <button class="btn btn-danger-ghost btn-sm" data-del="${it.id}">${esc(t('Delete'))}</button>
              </div>
            </td>
          </tr>`).join('') : `<tr><td colspan="${colspan}" class="muted" style="padding:16px">${esc(t('No {noun} entries yet.', { noun }))}</td></tr>`}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#lookupSearch'), '#settingsPanel .settings-list');

  const byId = (id) => items.find(x => x.id == id);
  $('#lookupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    try { await api(cfg.path, { method: 'POST', body: JSON.stringify({ name, ...regionBody }) }); toast(t('Added')); refreshAfterSettings(); }
    catch (ex) { const el = $('#lookupErr'); el.textContent = ex.message; el.hidden = false; }
  });
  $$('#settingsPanel [data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const it = byId(b.dataset.toggle);
    try { await api(`${cfg.path}/${it.id}`, { method: 'PUT', body: JSON.stringify({ active: !it.active }) }); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  }));
  $$('#settingsPanel [data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(t('Delete this {noun}? Existing claims keep their recorded value.', { noun }))) return;
    try { await api(`${cfg.path}/${b.dataset.del}`, { method: 'DELETE' }); toast(t('Deleted')); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  }));
  // Inline rename — turn the name cell into an input with Save / Cancel.
  $$('#settingsPanel [data-rename]').forEach(b => b.addEventListener('click', () => {
    const it = byId(b.dataset.rename);
    const cell = b.closest('tr').querySelector('.name-cell');
    startInlineRename(cell, it, cfg);
  }));
  // Boolean flag tickboxes (purposes + can_manage) — persist immediately; keep
  // local state in sync so a later re-render reflects the choice.
  $$('#settingsPanel input[data-flag]').forEach(cb => cb.addEventListener('change', async () => {
    const it = byId(cb.dataset.id);
    const flag = cb.dataset.flag, val = cb.checked;
    try {
      await api(`${cfg.path}/${cb.dataset.id}`, { method: 'PUT', body: JSON.stringify({ [flag]: val }) });
      if (it) it[flag] = val;
      toast(t('Saved'));
    } catch (ex) { cb.checked = !val; toast(ex.message, true); }
  }));
  // Reorder arrows — move the row within the local list and persist the new
  // order for the whole ladder in one call.
  if (ranked) $$('#settingsPanel [data-move]').forEach(b => b.addEventListener('click', async () => {
    const idx = items.findIndex(x => x.id == b.dataset.id);
    const swap = b.dataset.move === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= items.length) return;
    [items[idx], items[swap]] = [items[swap], items[idx]];
    try {
      await api(`${cfg.path}/reorder`, { method: 'POST', body: JSON.stringify({ order: items.map(x => x.id), ...regionBody }) });
      refreshAfterSettings();
    } catch (ex) { toast(ex.message, true); refreshAfterSettings(); }
  }));
}

// Replace a name cell's text with an editable input + Save/Cancel. Enter saves,
// Escape cancels. On success the whole tab re-renders (keeps ordering/flags).
function startInlineRename(cell, it, cfg) {
  if (!cell || cell.querySelector('input')) return;
  cell.innerHTML = `<div class="rename-row">
      <input class="input rename-input" value="${esc(it.name)}" />
      <button type="button" class="btn btn-primary btn-sm" data-save>${esc(t('Save'))}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cancel>${esc(t('Cancel'))}</button>
    </div>`;
  const input = cell.querySelector('.rename-input');
  input.focus(); input.select();
  const cancel = () => { cell.textContent = it.name; };
  const save = async () => {
    const name = input.value.trim();
    if (!name || name === it.name) return cancel();
    try { await api(`${cfg.path}/${it.id}`, { method: 'PUT', body: JSON.stringify({ name }) }); toast(t('Renamed')); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  };
  cell.querySelector('[data-save]').addEventListener('click', save);
  cell.querySelector('[data-cancel]').addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
}

// Re-render whatever settings view is open and keep the claim-form dropdowns in
// sync. On the Regions landing (super admin, no region chosen) that's the
// landing; inside a region workspace it's the active tab.
function refreshAfterSettings() {
  loadLookups();
  const isSuper = state.user && state.user.role === 'superadmin';
  if (isSuper && !settingsState.region) return renderRegionsLanding();
  renderSettingsTab();
}

// --- Accounts (users) --------------------------------------------------------
// Current sort for the accounts table: key + direction (1 = A→Z, -1 = Z→A).
let accountsSort = { key: 'full_name', dir: 1 };
// Sort a copy of the accounts by the active column, always tie-breaking on name.
function sortAccounts(users) {
  const { key, dir } = accountsSort;
  const val = (u) => key === 'active' ? (u.active ? 1 : 0) : String(u[key] || '').toLowerCase();
  const name = (u) => String(u.full_name || '').toLowerCase();
  return [...users].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return name(a).localeCompare(name(b));
  });
}

// Fetch the accounts once, then paint from cache so re-sorting is instant.
async function renderAccountsTab() {
  const panel = $('#settingsPanel');
  const region = settingsState.region;
  const rQS = region ? `?region=${encodeURIComponent(region)}` : '';
  let users, positions, depts;
  try {
    [{ users }, { items: positions }, { items: depts }] =
      await Promise.all([api('/users'), api('/positions' + rQS), api('/departments' + rQS)]);
  } catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  settingsState.positions = positions.map(p => p.name);
  // The account form's Department picker should reflect this region's list.
  settingsState.departments = depts.filter(d => d.active).map(d => d.name);
  // Scope the workspace's account list to this region (All-regions accounts, e.g.
  // super admins, stay visible everywhere).
  settingsState.users = region ? users.filter(u => u.region === region || u.region === '*') : users;
  if (state.user.role === 'superadmin') paintAccounts();
  else paintDelegatedAccounts();
}

// The Accounts tab for a non-superadmin (CM/MD or a delegated senior): the same
// department-scoped, rank-limited team screen as the "Manage accounts" modal —
// reset passwords / enable-disable your team, plus "+ Add user" for anyone who
// holds create_accounts. Rendered into the Settings workspace panel.
function paintDelegatedAccounts() {
  const panel = $('#settingsPanel');
  const users = settingsState.users || [];
  const dept = state.user.department || '';
  const canCreate = uCan('create_accounts');
  panel.innerHTML = `
    <div class="settings-controls">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
        <input id="acctSearch" class="input" type="search" placeholder="${esc(t('Search users…'))}" style="flex:1" />
        ${canCreate ? `<button class="btn btn-primary btn-sm" id="addUserBtn">${esc(t('+ Add user'))}</button>` : ''}
      </div>
      <p class="muted" style="margin:0 0 12px;font-size:.85rem">${canCreate
        ? esc(t('Accounts in {dept}. You can create accounts, reset passwords and enable/disable your team (positions ranked below yours).', { dept: dept || '—' }))
        : esc(t('Accounts in {dept}. You can reset passwords and enable/disable your team (positions ranked below yours). Only a super admin can create new accounts.', { dept: dept || '—' }))}</p>
    </div>
    <div class="settings-list">
      <table class="utable utable-manage">
        <thead><tr><th>${esc(t('User'))}</th><th>${esc(t('Email'))}</th><th>${esc(t('Position'))}</th><th>${esc(t('Active'))}</th><th class="u-actions-h">${esc(t('Actions'))}</th></tr></thead>
        <tbody>${users.length ? users.map(u => `
          <tr>
            <td data-label="${esc(t('User'))}"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub mono">${esc(u.username)}</div>${creatorLine(u)}</td>
            <td class="u-wrap" data-label="${esc(t('Email'))}">${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Position'))}">${u.position ? esc(u.position) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Active'))}">${u.active
                ? `<span class="pill pill-on">${esc(t('Active'))}</span>`
                : `<span class="pill pill-off">${esc(t('Disabled'))}</span>`}</td>
            <td class="act-cell" data-label="${esc(t('Actions'))}">${maCanManage(u) ? `<div class="u-actions">
              <button class="btn btn-indigo-soft btn-sm" data-reset="${u.id}">${esc(t('Reset password'))}</button>
              <button class="btn btn-sm ${u.active ? 'btn-danger-ghost' : 'btn-primary'}" data-active="${u.id}">${u.active ? esc(t('Disable')) : esc(t('Enable'))}</button>
            </div>` : '<span class="muted">—</span>'}</td>
          </tr>`).join('') : `<tr><td colspan="5" class="muted" style="padding:16px">${esc(t('No accounts yet.'))}</td></tr>`}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#acctSearch'), '#settingsPanel .settings-list');
  const addBtn = $('#addUserBtn');
  if (addBtn) addBtn.addEventListener('click', () => openDelegatedUserForm());
  $$('#settingsPanel [data-reset]').forEach(b => b.addEventListener('click', () =>
    renderResetPasswordForm(users.find(x => x.id == b.dataset.reset))));
  $$('#settingsPanel [data-active]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id == b.dataset.active);
    if (u.active && !confirm(t("Disable {name}'s account? They won't be able to sign in until re-enabled.", { name: u.full_name }))) return;
    try {
      await api('/users/' + u.id + '/set-active', { method: 'POST', body: JSON.stringify({ active: !u.active }) });
      toast(u.active ? t('Account disabled') : t('Account enabled'));
      renderAccountsTab();
    } catch (ex) { toast(ex.message, true); }
  }));
}

function paintAccounts() {
  const panel = $('#settingsPanel');
  const users = settingsState.users || [];
  const sorted = sortAccounts(users);
  // A clickable header cell that sorts by `key` and shows the active arrow.
  const th = (key, label) => {
    const on = accountsSort.key === key;
    const arrow = on ? (accountsSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-sort="${key}" role="button" tabindex="0" aria-sort="${on ? (accountsSort.dir === 1 ? 'ascending' : 'descending') : 'none'}" style="cursor:pointer;user-select:none;white-space:nowrap">${esc(label)}<span class="sort-arrow">${arrow}</span></th>`;
  };

  panel.innerHTML = `
    <div class="settings-controls">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
        <input id="acctSearch" class="input" type="search" placeholder="${esc(t('Search users…'))}" style="flex:1" />
        <button class="btn btn-primary btn-sm" id="addUserBtn">${esc(t('+ Add user'))}</button>
      </div>
    </div>
    <div class="settings-list">
      <table class="utable utable-users">
        <thead><tr>${th('full_name', t('User'))}${th('email', t('Email'))}${th('role', t('Role'))}${th('region', t('Region'))}${th('department', t('Dept / Position'))}${th('active', t('Active'))}<th></th></tr></thead>
        <tbody>${sorted.map(u => `
          <tr>
            <td data-label="${esc(t('User'))}"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub mono">${esc(u.username)}</div>${creatorLine(u)}</td>
            <td class="u-wrap" data-label="${esc(t('Email'))}">${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Role'))}">${esc(roleLabel(u.role))}<div class="u-sub">${u.approval_limit_cents == null ? esc(t('Approves any amount')) : esc(t('Approves ≤ {amount}', { amount: money(u.approval_limit_cents / 100) }))}</div></td>
            <td data-label="${esc(t('Region'))}">${esc(regionLabel(u.region))}</td>
            <td data-label="${esc(t('Dept / Position'))}"><div>${u.department ? esc(u.department) : '<span class="muted">—</span>'}</div>${u.position ? `<div class="u-sub">${esc(u.position)}</div>` : ''}</td>
            <td data-label="${esc(t('Active'))}">${u.active ? esc(t('Yes')) : esc(t('No'))}</td>
            <td class="act-cell" data-label="${esc(t('Actions'))}">${(state.user.role === 'superadmin' || u.role === 'employee')
              ? `<div class="u-actions">
                <button class="btn btn-brand-soft btn-sm" data-edit="${u.id}">${esc(t('Edit'))}</button>
                ${u.id != state.user.id ? `<button class="btn btn-sm ${u.active ? 'btn-danger-ghost' : 'btn-green-soft'}" data-active="${u.id}">${u.active ? esc(t('Disable')) : esc(t('Enable'))}</button>` : ''}
              </div>`
              : '<span class="muted">—</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#acctSearch'), '#settingsPanel .settings-list');
  // Clicking (or pressing Enter/Space on) a header sorts by that column; the same
  // header again flips the direction.
  const applySort = (key) => {
    if (accountsSort.key === key) accountsSort.dir *= -1;
    else accountsSort = { key, dir: 1 };
    paintAccounts();
  };
  $$('#settingsPanel th[data-sort]').forEach(h => {
    h.addEventListener('click', () => applySort(h.dataset.sort));
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applySort(h.dataset.sort); } });
  });
  $('#addUserBtn').addEventListener('click', () => renderUserForm(null));
  $$('#settingsPanel [data-edit]').forEach(b =>
    b.addEventListener('click', () => renderUserForm(users.find(x => x.id == b.dataset.edit))));
  $$('#settingsPanel [data-active]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id == b.dataset.active);
    if (u.active && !confirm(t("Disable {name}'s account? They won't be able to sign in until re-enabled.", { name: u.full_name }))) return;
    try {
      await api('/users/' + u.id + '/set-active', { method: 'POST', body: JSON.stringify({ active: !u.active }) });
      toast(u.active ? t('Account disabled') : t('Account enabled'));
      renderAccountsTab();
    } catch (ex) { toast(ex.message, true); }
  }));
}

// Build a <select> of configured options plus the current value; used for the
// department and position fields on the account form.
function optionSelect(name, value, options) {
  const cur = value || '';
  const opts = [...options];
  if (cur && !opts.includes(cur)) opts.unshift(cur);
  return `<select name="${name}">
    <option value="">${esc(t('— none —'))}</option>
    ${opts.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}
  </select>`;
}

// A searchable combobox of the created users (value = user id) for an approver
// row. The account being edited is excluded so it can't approve its own claims.
// A hidden input carries the selected id (name="appr_i") so the existing
// read/submit logic is unchanged; a text input filters the list as you type.
function approverRowSelect(i, value, excludeId, prefix = 'appr') {
  const cur = value == null ? '' : String(value);
  const sel = settingsState.users.find(x => String(x.id) === cur && x.id !== excludeId);
  const label = sel ? `${sel.full_name} (${sel.username})` : '';
  return `<div class="combo" data-combo="${i}">
    <input type="hidden" name="${prefix}_${i}" value="${esc(cur)}" />
    <input type="text" class="combo-input" autocomplete="off" spellcheck="false"
      role="combobox" aria-expanded="false" aria-autocomplete="list"
      placeholder="${esc(t('Search user…'))}" value="${esc(label)}" />
    <div class="combo-list" role="listbox" hidden></div>
  </div>`;
}

// Wire one combobox: type-to-filter, click / arrow-keys / Enter to choose,
// Escape to close. Selecting sets the hidden id; leaving without a valid pick
// restores the last confirmed selection (or clears it).
function wireApproverCombo(container, excludeId, onChoose = syncApproverRows) {
  const hidden = container.querySelector('input[type="hidden"]');
  const input = container.querySelector('.combo-input');
  const list = container.querySelector('.combo-list');
  const users = settingsState.users
    .filter(x => x.id !== excludeId)
    .slice()
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name), undefined, { sensitivity: 'base' }));
  const labelFor = (u) => `${u.full_name} (${u.username})`;
  const currentLabel = () => { const u = users.find(x => String(x.id) === hidden.value); return u ? labelFor(u) : ''; };
  let items = [], active = -1;

  const render = (q) => {
    const ql = q.trim().toLowerCase();
    items = users.filter(u => !ql || labelFor(u).toLowerCase().includes(ql));
    active = items.length ? 0 : -1;
    list.innerHTML = items.length
      ? items.map((u, idx) => `<div class="combo-opt${idx === active ? ' active' : ''}" role="option" data-id="${u.id}">${esc(labelFor(u))}</div>`).join('')
      : `<div class="combo-empty">${esc(t('No matches'))}</div>`;
  };
  const open = (q) => { render(q == null ? '' : q); list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const highlight = () => {
    [...list.querySelectorAll('.combo-opt')].forEach((el, idx) => el.classList.toggle('active', idx === active));
    const el = list.querySelector('.combo-opt.active'); if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const choose = (u) => { hidden.value = String(u.id); input.value = labelFor(u); close(); onChoose(); };

  input.addEventListener('focus', () => { input.select(); open(''); });
  input.addEventListener('input', () => { hidden.value = ''; open(input.value); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { open(input.value); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { active = (active + 1) % items.length; highlight(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; highlight(); } }
    else if (e.key === 'Enter') { if (!list.hidden && active >= 0 && items[active]) { e.preventDefault(); choose(items[active]); } }
    else if (e.key === 'Escape') { close(); }
  });
  // mousedown (not click) so the pick lands before the input's blur fires.
  list.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-opt'); if (!opt) return;
    e.preventDefault();
    const u = users.find(x => String(x.id) === opt.dataset.id); if (u) choose(u);
  });
  input.addEventListener('blur', () => { setTimeout(() => { input.value = currentLabel(); close(); }, 120); });
}

// Ordered list of approver ids (as strings) being edited on the account form.
let acctApprovers = [];
function renderApproverRows(excludeId) {
  const wrap = $('#approverRows');
  wrap.innerHTML = acctApprovers.length ? acctApprovers.map((val, i) => `
    <div class="line-row" data-i="${i}">
      <span class="line-step">${i + 1}</span>
      ${approverRowSelect(i, val, excludeId)}
      <button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove approver'))}">×</button>
    </div>`).join('') : `<p class="muted" style="font-size:.85rem;margin:4px 0">${esc(t('No approvers — only a Super Admin can approve.'))}</p>`;
  $$('#approverRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    syncApproverRows(); acctApprovers.splice(+b.dataset.rm, 1); renderApproverRows(excludeId);
  }));
  $$('#approverRows .combo').forEach(c => wireApproverCombo(c, excludeId));
}
// Read the current selects back into acctApprovers before re-render/submit.
function syncApproverRows() {
  $$('#approverRows .line-row').forEach(row => {
    const i = +row.dataset.i;
    acctApprovers[i] = row.querySelector(`[name="appr_${i}"]`).value;
  });
}

// Candidate pool for a chooseable Approver 1 (super admin only). Same combobox
// machinery as the fixed chain, but an unordered set of options the submitter
// later picks one of. Stored/submitted as approver1_options.
let acctApprover1Options = [];
function renderApprover1Options(excludeId) {
  const wrap = $('#approver1OptionRows');
  if (!wrap) return;
  wrap.innerHTML = acctApprover1Options.length ? acctApprover1Options.map((val, i) => `
    <div class="line-row" data-i="${i}">
      <span class="line-step">${i + 1}</span>
      ${approverRowSelect(i, val, excludeId, 'a1opt')}
      <button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove candidate'))}">×</button>
    </div>`).join('') : `<p class="muted" style="font-size:.85rem;margin:4px 0">${esc(t('No candidates — Approver 1 comes from the fixed chain below.'))}</p>`;
  $$('#approver1OptionRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    syncApprover1Options(); acctApprover1Options.splice(+b.dataset.rm, 1); renderApprover1Options(excludeId);
  }));
  $$('#approver1OptionRows .combo').forEach(c => wireApproverCombo(c, excludeId, syncApprover1Options));
}
function syncApprover1Options() {
  $$('#approver1OptionRows .line-row').forEach(row => {
    const i = +row.dataset.i;
    acctApprover1Options[i] = row.querySelector(`[name="a1opt_${i}"]`).value;
  });
}

function renderUserForm(u) {
  const isEdit = !!u;
  const excludeId = isEdit ? u.id : null;
  acctApprovers = isEdit ? (u.approver_ids || []).map(String) : [];
  acctApprover1Options = isEdit ? (u.approver1_options || []).map(String) : [];
  openModal2(`
    <div class="modal-head">
      <h2>${isEdit ? esc(t('Edit {username}', { username: u.username })) : esc(t('New user'))}</h2>
      <button type="button" class="x-btn" id="uClose">×</button>
    </div>
    <div class="modal-body">
    <form id="uForm" class="form">
      <div class="grid2">
        <label>${esc(t('Username'))}<input name="username" required value="${isEdit ? esc(u.username) : ''}" /></label>
        <label>${esc(t('Full name'))}<input name="full_name" required value="${isEdit ? esc(u.full_name) : ''}" /></label>
        <label>${esc(t('Email (for resets & notifications)'))}<input name="email" type="email" value="${isEdit ? esc(u.email || '') : ''}" placeholder="${esc(t('you@company.com'))}" /></label>
        ${state.user.role === 'superadmin' ? `<label>${esc(t('Role'))}
          <select name="role">
            ${['superadmin', 'vp', 'admin', 'manager', 'lowmgmt', 'finance', 'employee'].map(r =>
              `<option value="${r}" ${(isEdit ? u.role === r : r === 'employee') ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}
          </select></label>`
        : (!isEdit && creatableRoles().length ? `<label>${esc(t('Role'))}
          <select name="role">
            ${creatableRoles().map((r, i, arr) =>
              `<option value="${r}" ${i === arr.length - 1 ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}
          </select></label>` : '')}
        <label>${esc(t('Department'))}${optionSelect('department', isEdit ? u.department : '', settingsState.departments)}</label>
        <label>${esc(t('Job position'))}${optionSelect('position', isEdit ? u.position : '', settingsState.positions)}</label>
        ${(state.user.role === 'superadmin' || (!isEdit && state.user.region === '*')) ? `<label>${esc(t('Region'))}
          <select name="region">
            ${(state.lookups.regions || []).map(r => `<option value="${esc(r)}" ${(isEdit ? u.region === r : r === settingsState.region) ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            ${state.user.role === 'superadmin' ? `<option value="*" ${isEdit && u.region === '*' ? 'selected' : ''}>${esc(t('All regions'))}</option>` : ''}
          </select></label>` : ''}
        <label>${isEdit ? esc(t('Reset password (optional)')) : esc(t('Password'))}
          <div class="pw-wrap">
            <input name="password" type="password" ${isEdit ? '' : 'required'} />
            <button type="button" class="pw-toggle" aria-label="${esc(t('Show password'))}">👁</button>
          </div></label>
      </div>
      ${state.user.role === 'superadmin' ? `
      <div class="section-label" style="margin-top:8px">${esc(t('Permissions'))}</div>
      <label class="perm-check"><input type="checkbox" name="can_mark_paid" ${isEdit && u.can_mark_paid ? 'checked' : ''} /> <span>${esc(t('Can mark claims as paid (record payment)'))}</span></label>
      <div class="section-label" style="margin-top:8px">${esc(t('Approval limit'))}</div>
      <label class="perm-check"><input type="checkbox" name="approval_unlimited" ${(isEdit ? u.approval_limit_cents == null : true) ? 'checked' : ''} /> <span>${esc(t('Unlimited — can approve a claim of any amount'))}</span></label>
      <label id="apprLimitWrap" style="margin-top:8px">${esc(t('Maximum claim amount this account can approve'))}
        <input name="approval_limit" inputmode="decimal" placeholder="${esc(t('e.g. 5,000,000'))}" value="${(isEdit && u.approval_limit_cents != null) ? esc(String(u.approval_limit_cents / 100)) : ''}" />
      </label>` : ''}
      ${state.user.role === 'superadmin' ? `
      <div class="section-label" style="margin-top:8px">${esc(t('Approver 1 — let the submitter choose from'))}</div>
      <p class="muted" style="font-size:.82rem;margin:0 0 6px">${esc(t('Add two or more accounts to let this person pick their Approver 1 from a dropdown on the New Claim form. With one, it\'s used as Approver 1 automatically (no dropdown). Leave empty to use the fixed chain below as-is. Whatever ends up as Approver 1 becomes step 1, and the chain below runs after it.'))}</p>
      <div id="approver1OptionRows"></div>
      <button type="button" class="btn btn-ghost btn-sm add-approver-btn" id="addApprover1OptBtn">${esc(t('+ Add candidate'))}</button>` : ''}
      <div class="section-label" style="margin-top:8px">${esc(t('Approval chain (approvers, in order)'))}</div>
      <div id="approverRows"></div>
      <button type="button" class="btn btn-ghost btn-sm add-approver-btn" id="addApproverBtn">${esc(t('+ Add approver'))}</button>
      <div class="section-label" style="margin-top:8px">${esc(t('Bank / payout details'))}</div>
      <div class="grid2">
        <label>${esc(t('Bank name'))}<input name="bank_name" value="${isEdit ? esc(u.bank_name || '') : ''}" /></label>
        <label>${esc(t('Recipient name'))}<input name="recipient_name" value="${isEdit ? esc(u.recipient_name || '') : ''}" /></label>
        <label>${esc(t('Bank account no.'))}<input name="bank_account_no" inputmode="numeric" value="${isEdit ? esc(u.bank_account_no || '') : ''}" /></label>
      </div>
      <p class="form-error" id="uErr" hidden></p>
      <div class="modal-actions sticky-foot">
        <button type="button" class="btn btn-ghost btn-sm" id="uCancel">${esc(t('Cancel'))}</button>
        <button type="submit" class="btn btn-primary btn-sm">${isEdit ? esc(t('Save')) : esc(t('Create'))}</button>
      </div>
    </form>
    </div>`);
  $('#modal2').classList.add('modal-wide');
  $('#uClose').addEventListener('click', closeModal2);
  $('#uCancel').addEventListener('click', closeModal2);
  renderApproverRows(excludeId);
  $('#addApproverBtn').addEventListener('click', () => { syncApproverRows(); acctApprovers.push(''); renderApproverRows(excludeId); });
  if (state.user.role === 'superadmin') {
    renderApprover1Options(excludeId);
    $('#addApprover1OptBtn').addEventListener('click', () => { syncApprover1Options(); acctApprover1Options.push(''); renderApprover1Options(excludeId); });
    // Approval limit: the amount field is only relevant when "Unlimited" is off.
    const unl = $('#uForm [name="approval_unlimited"]');
    const amt = $('#uForm [name="approval_limit"]');
    const wrap = $('#apprLimitWrap');
    if (unl && amt && wrap) {
      const syncLimit = () => { const on = unl.checked; amt.disabled = on; wrap.style.opacity = on ? '.5' : '1'; if (on) amt.value = ''; };
      unl.addEventListener('change', syncLimit); syncLimit();
    }
  }
  // Departments and job positions are per-region now, so when the Region changes
  // reload its lists and rebuild those two pickers. The current pick is preserved
  // (optionSelect keeps a value even if it's not in the new region). Runs for any
  // creator who has a Region select (super admins and all-regions delegates).
  {
    const regionSel = $('#uForm select[name="region"]');
    if (regionSel) regionSel.addEventListener('change', async () => {
      const region = regionSel.value;
      const concrete = region && region !== '*';
      const qs = concrete ? `?region=${encodeURIComponent(region)}` : '';
      let depts, positions;
      try {
        const [d, p] = await Promise.all([api('/departments' + qs), api('/positions' + qs)]);
        const uniq = (items) => [...new Set((items || []).filter(i => i.active).map(i => i.name))];
        depts = uniq(d.items); positions = uniq(p.items);
      } catch (ex) { toast(ex.message, true); return; }
      // These selects are now wrapped in a .msel; swap the whole wrapper for a
      // fresh native select and re-enhance it (keeping the current value).
      const rebuild = (sel, options) => {
        if (!sel) return;
        const target = sel.closest('.msel') || sel;
        const tmp = document.createElement('div');
        tmp.innerHTML = optionSelect(sel.name, sel.value, options);
        const fresh = tmp.firstElementChild;
        target.replaceWith(fresh);
        enhanceSelect(fresh);
      };
      rebuild($('#uForm select[name="department"]'), depts);
      rebuild($('#uForm select[name="position"]'), positions);
    });
  }
  $('#uForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    syncApproverRows();
    if (state.user.role === 'superadmin') syncApprover1Options();
    const fd = new FormData(e.target);
    const payload = {
      username: fd.get('username'), full_name: fd.get('full_name'),
      role: fd.get('role') || undefined,
      email: fd.get('email') || '',
      department: fd.get('department') || '', position: fd.get('position') || '',
      bank_name: fd.get('bank_name') || '', recipient_name: fd.get('recipient_name') || '',
      bank_account_no: fd.get('bank_account_no') || '',
      approver_ids: acctApprovers.filter(Boolean).map(Number)
    };
    if (state.user.role === 'superadmin') {
      payload.can_mark_paid = fd.get('can_mark_paid') === 'on';
      payload.approver1_options = acctApprover1Options.filter(Boolean).map(Number);
      payload.region = fd.get('region') || '';
      const unlimited = fd.get('approval_unlimited') === 'on';
      const limitAmt = String(fd.get('approval_limit') || '').trim();
      if (!unlimited && !limitAmt) { const el = $('#uErr'); el.textContent = t('Enter an approval limit or choose Unlimited.'); el.hidden = false; return; }
      payload.approval_unlimited = unlimited;
      payload.approval_limit = limitAmt;
    } else if (!isEdit && state.user.region === '*') {
      // An all-regions delegate picks the new account's region; a region-scoped
      // one has it pinned server-side to their own, so no field is sent.
      payload.region = fd.get('region') || '';
    }
    const pw = fd.get('password');
    if (pw && (!isEdit || pw.length)) payload.password = pw;
    try {
      if (isEdit) await api('/users/' + u.id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/users', { method: 'POST', body: JSON.stringify(payload) });
      closeModal2(); toast(t('User saved'));
      // Refresh whichever account screen is open: the super-admin Settings tab or
      // the delegated "Manage accounts" modal.
      if ($('#maBody')) renderManageAccounts(); else renderAccountsTab();
    } catch (ex) { const el = $('#uErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Delegated account management (non-superadmins)
// ---------------------------------------------------------------------------
// The team screen non-superadmins get instead of full Settings: reset passwords
// and enable/disable accounts they may manage (positions ranked below theirs),
// plus — for anyone granted the create_accounts capability — a "+ Add user" form
// scoped to their region and to roles below their own. The server enforces the
// same rules; this is the UI.
function openManageAccountsModal() {
  openModal(`
    <div class="modal-head">
      <h2>${esc(t('Manage accounts'))}</h2>
      <button class="x-btn">×</button>
    </div>
    <div class="modal-body" id="maBody">
      <p class="muted" style="padding:20px 0">${esc(t('Loading…'))}</p>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  renderManageAccounts();
}

async function renderManageAccounts() {
  const body = $('#maBody');
  let users;
  try { ({ users } = await api('/users')); }
  catch (ex) { body.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const dept = state.user.department || '';
  const canCreate = uCan('create_accounts');
  // Keep the approver-combo / creatable-position helpers fed while this modal is
  // open (they read settingsState); the delegated create form reuses them.
  settingsState.users = users;
  body.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
      <input id="maSearch" class="input" type="search" placeholder="${esc(t('Search users…'))}" style="flex:1" />
      ${canCreate ? `<button class="btn btn-primary btn-sm" id="maAddUserBtn">${esc(t('+ Add user'))}</button>` : ''}
    </div>
    <p class="muted" style="margin:0 0 12px;font-size:.85rem">${canCreate
      ? esc(t('Accounts in {dept}. You can create accounts, reset passwords and enable/disable your team (positions ranked below yours).', { dept: dept || '—' }))
      : esc(t('Accounts in {dept}. You can reset passwords and enable/disable your team (positions ranked below yours). Only a super admin can create new accounts.', { dept: dept || '—' }))}</p>
    <div class="settings-list">
      <table class="utable utable-manage">
        <thead><tr><th>${esc(t('User'))}</th><th>${esc(t('Email'))}</th><th>${esc(t('Position'))}</th><th>${esc(t('Active'))}</th><th class="u-actions-h">${esc(t('Actions'))}</th></tr></thead>
        <tbody>${users.length ? users.map(u => `
          <tr>
            <td data-label="${esc(t('User'))}"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub mono">${esc(u.username)}</div>${creatorLine(u)}</td>
            <td class="u-wrap" data-label="${esc(t('Email'))}">${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Position'))}">${u.position ? esc(u.position) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Active'))}">${u.active
                ? `<span class="pill pill-on">${esc(t('Active'))}</span>`
                : `<span class="pill pill-off">${esc(t('Disabled'))}</span>`}</td>
            <td class="act-cell" data-label="${esc(t('Actions'))}">${maCanManage(u) ? `<div class="u-actions">
              <button class="btn btn-indigo-soft btn-sm" data-reset="${u.id}">${esc(t('Reset password'))}</button>
              <button class="btn btn-sm ${u.active ? 'btn-danger-ghost' : 'btn-primary'}" data-active="${u.id}">${u.active ? esc(t('Disable')) : esc(t('Enable'))}</button>
            </div>` : '<span class="muted">—</span>'}</td>
          </tr>`).join('') : `<tr><td colspan="5" class="muted" style="padding:16px">${esc(t('No accounts yet.'))}</td></tr>`}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#maSearch'), '#maBody .settings-list');
  const addBtn = $('#maAddUserBtn');
  if (addBtn) addBtn.addEventListener('click', () => openDelegatedUserForm());
  $$('#maBody [data-reset]').forEach(b => b.addEventListener('click', () =>
    renderResetPasswordForm(users.find(x => x.id == b.dataset.reset))));
  $$('#maBody [data-active]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id == b.dataset.active);
    if (u.active && !confirm(t("Disable {name}'s account? They won't be able to sign in until re-enabled.", { name: u.full_name }))) return;
    try {
      await api('/users/' + u.id + '/set-active', { method: 'POST', body: JSON.stringify({ active: !u.active }) });
      toast(u.active ? t('Account disabled') : t('Account enabled'));
      renderManageAccounts();
    } catch (ex) { toast(ex.message, true); }
  }));
}

// A row is manageable (reset password / enable-disable) when it's any
// non-superadmin holding a position ranked below this user's own. Mirrors the
// server's canManageAccount; the list (creatable_positions = positions strictly
// below the actor) is already scoped to the actor's own department.
function maCanManage(u) {
  if (u.role === 'superadmin') return false;
  const list = (state.user.creatable_positions || []).map(p => p.toLowerCase());
  return list.includes(String(u.position || '').trim().toLowerCase());
}

// Open the account-creation form for a delegated (non-superadmin) creator who
// holds the create_accounts capability. Loads their region's department /
// job-position lists (the form's pickers read settingsState) before opening it.
// settingsState.users is already populated by the surrounding manage-accounts
// screen. The server enforces the same region scope and the role-below-self rule.
async function openDelegatedUserForm() {
  const region = String(state.user.region || '');
  settingsState.region = region;
  const qs = region && region !== '*' ? `?region=${encodeURIComponent(region)}` : '';
  try {
    const [{ items: positions }, { items: depts }] = await Promise.all([
      api('/positions' + qs), api('/departments' + qs)
    ]);
    settingsState.positions = positions.map(p => p.name);
    settingsState.departments = depts.filter(d => d.active).map(d => d.name);
  } catch (ex) { toast(ex.message, true); return; }
  renderUserForm(null);
}

function renderResetPasswordForm(u) {
  if (!u) return;
  openModal2(`
    <div class="modal-head">
      <h2>${esc(t('Reset password'))}</h2>
      <button type="button" class="x-btn" id="rpClose">×</button>
    </div>
    <div class="modal-body">
    <form id="rpForm" class="form">
      <p class="muted" style="margin:0 0 12px;font-size:.9rem">${esc(t('Set a new password for {name} ({username}).', { name: u.full_name, username: u.username }))}</p>
      <label>${esc(t('New password'))}
        <div class="pw-wrap">
          <input name="password" type="password" required minlength="8" />
          <button type="button" class="pw-toggle" aria-label="${esc(t('Show password'))}">👁</button>
        </div></label>
      <p class="form-error" id="rpErr" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="rpCancel">${esc(t('Cancel'))}</button>
        <button type="submit" class="btn btn-primary btn-sm">${esc(t('Reset password'))}</button>
      </div>
    </form>
    </div>`);
  $('#rpClose').addEventListener('click', closeModal2);
  $('#rpCancel').addEventListener('click', closeModal2);
  $('#rpForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get('password');
    try {
      await api('/users/' + u.id + '/reset-password', { method: 'POST', body: JSON.stringify({ password }) });
      closeModal2(); toast(t('Password reset'));
    } catch (ex) { const el = $('#rpErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

boot();
