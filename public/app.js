'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  user: null, claims: [], filters: { status: '', department: '', claimant: '', q: '', paidFrom: '', paidTo: '' },
  // The ledger loads open items + the last LEDGER_WINDOW_DAYS by default;
  // "Show all history" sets ledgerAll. ledgerLoadedAll records what the last
  // load actually fetched (a search or an old payment-date range widens it too).
  ledgerAll: false, ledgerLoadedAll: false,
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
  viewRegion: '',
  // How many date-change requests are waiting on a Super Admin — the badge on
  // the "Request change of date" tile. Always 0 for everyone else. Reset on login.
  dcPending: 0
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
  // Server messages are English source text, translated here once for every
  // caller (npm run check:i18n keeps their translations complete).
  if (!res.ok) throw new Error((data && data.error) ? t(data.error) : `Request failed (${res.status})`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.add('toast-out');
    toast._t = setTimeout(() => { t.hidden = true; }, reducedMotion() ? 0 : 180);
  }, 3200);
}

// ---------------------------------------------------------------------------
// Motion helpers (the keyframes live in the Motion section of styles.css)
// ---------------------------------------------------------------------------
const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function reducedMotion() { return !!(motionQuery && motionQuery.matches); }

// Staggered entrance for a container's children (.entering). Call when a list
// first comes into view, and enterKeep() right before re-rendering it: a
// re-render inside the window then continues the running animation instead of
// replaying it or snapping half-faded rows to full.
const ENTER_MS = 800;
function playEnter(el) {
  if (!el || reducedMotion()) return;
  el._enterAt = performance.now();
  el.style.setProperty('--enter-offset', '0ms');
  el.classList.remove('entering');
  void el.offsetWidth; // restart the animations on the existing children
  el.classList.add('entering');
  clearTimeout(el._enterT);
  el._enterT = setTimeout(() => el.classList.remove('entering'), ENTER_MS);
}
function enterKeep(el) {
  if (el && el.classList.contains('entering')) {
    el.style.setProperty('--enter-offset', `${-Math.round(performance.now() - el._enterAt)}ms`);
  }
}

// Exit animation that never delays the real close: the panel itself hides at
// once (so close→reopen sequences stay synchronous), while an inert copy with
// no ids or names plays the .leaving animation on top and then removes itself.
function leaveGhost(el) {
  if (!el || el.hidden || reducedMotion()) return;
  const g = el.cloneNode(true);
  g.removeAttribute('id');
  g.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  g.querySelectorAll('[name]').forEach(n => n.removeAttribute('name'));
  g.querySelectorAll('iframe').forEach(n => n.remove());
  g.inert = true;
  g.setAttribute('aria-hidden', 'true');
  g.classList.add('leaving');
  el.after(g);
  g.scrollTop = el.scrollTop;
  const done = () => g.remove();
  g.addEventListener('animationend', e => { if (e.target === g) done(); });
  setTimeout(done, 400); // in case animationend never fires
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
// An approved realization that came in UNDER the advance leaves the unused
// balance with the employee: the advance is not cleared (it stays unrealized,
// and keeps the new-claim hold — see unrealizedAdvanceCount on the server)
// until Finance AP settles it, i.e. confirms the refund was received.
const owesRefund = (c) => !!(c && c.type === 'advance' && c.status === 'realize_approved'
  && (c.realized_total || 0) < (c.amount || 0));
const statusLabel = (s) => t(STATUS_LABEL[s] || s || '');
// "Pending review" splits by which approver is next: step 1 is still with the
// department Manager; once they approve, the claim advances to step >= 2, where it
// waits on FinanceAP. pendingReviewBase is the untranslated label (used for
// sorting); pendingReviewLabel is the translated one shown in the UI.
const pendingReviewBase = (step) => (Number(step) || 0) >= 2
  ? 'Pending Review - FinanceAP' : 'Pending Review - Manager';
const pendingReviewLabel = (step) => t(pendingReviewBase(step));
// Status label that knows the row type (advances relabel some shared statuses).
function statusLabelFor(c) {
  if (owesRefund(c)) return t('Awaiting refund');
  if (c && c.type === 'advance' && ADV_STATUS_LABEL[c.status]) return t(ADV_STATUS_LABEL[c.status]);
  if (c && c.status === 'submitted') return pendingReviewLabel(c.current_step);
  return statusLabel(c ? c.status : '');
}
// CSS pill class for a status — maps advance-only statuses onto a base colour.
const pillClass = (c) => owesRefund(c) ? 'submitted'
  : (c && c.type === 'advance' && ADV_PILL_BASE[c.status]) || (c ? c.status : '');

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
  initThemeUI();         // night-mode toggles (login card + top bar)
  initWhatsNew();        // release-notes button + its unread dot
  initIosInstallHint();  // "Add to Home Screen" card for iPhone/iPad
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

// Translations are fetched per language (i18n.js). A switch, or adopting the
// account's language at sign-in, can render before that table arrives; re-run
// the translation of whatever is on screen once it does.
window.addEventListener('i18n:changed', () => { applyLangChrome(); rerenderDynamic(); });

// Re-translate the static chrome (top bar, list head, filters, login) and keep
// both switchers showing the active language.
function applyLangChrome() {
  I18N.applyStatic();
  syncLangSelectors();
  renderLoginHint();
  syncThemeButtons();
}

// ---------------------------------------------------------------------------
// Night mode — theme.js owns the state (device setting until the user picks;
// the pick is remembered per device). These are just its two toggle buttons.
// ---------------------------------------------------------------------------
function initThemeUI() {
  if (!window.Theme) return;
  document.querySelectorAll('[data-theme-toggle]').forEach(btn =>
    btn.addEventListener('click', () => toggleThemeFrom(btn)));
  Theme.onChange(syncThemeButtons);
  syncThemeButtons();
}

function toggleThemeFrom(btn) { revealFrom(btn, () => Theme.toggle()); }

// A theme or look change spreads out from the button as a growing circle (View
// Transitions); browsers without it, or reduced motion, just switch.
function revealFrom(btn, update) {
  if (!document.startViewTransition || reducedMotion()) { update(); return; }
  // Rect and viewport sizes are visual px, but the pseudo-element inherits the
  // :root zoom, which multiplies the clip-path lengths: divide it back out.
  const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const at = `at ${x / z}px ${y / z}px`;
  const vt = document.startViewTransition(update);
  vt.ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0px ${at})`, `circle(${radius / z}px ${at})`] },
    { duration: 480, easing: 'cubic-bezier(.22, .8, .24, 1)', pseudoElement: '::view-transition-new(root)' }
  )).catch(() => { /* transition skipped */ });
}

// Label each toggle with what it will do, in the active language.
function syncThemeButtons() {
  if (!window.Theme) return;
  const label = Theme.get() === 'dark' ? t('Switch to light mode') : t('Switch to dark mode');
  document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    if (btn.id === 'tbThemeRow') return; // a switch, labelled by its own text
    btn.setAttribute('aria-label', label);
    btn.title = label;
  });
  // The phone panel's row is a switch: on = dark.
  const row = document.getElementById('tbThemeRow');
  if (row) row.setAttribute('aria-checked', String(Theme.get() === 'dark'));
}

// ---------------------------------------------------------------------------
// What's new — release notes from public/changelog.js, every item already
// written in all six languages (scripts/check-changelog.js enforces that). The
// newest release id the user has opened is remembered per device; until then
// the top-bar button carries a dot.
// ---------------------------------------------------------------------------
// Notes are only for the accounts they concern: an item's `audience` keys (see
// changelog.js) must match the signed-in account, Super Admins see everything,
// and a release with nothing left for this account is dropped whole.
const NOTE_AUDIENCE = {
  claim: (u) => !!(u.purposes && u.purposes.claim),
  meal: (u) => !!(u.purposes && u.purposes.meal),
  advance: (u) => !!(u.purposes && u.purposes.advance),
  pay: (u) => canPay(u),
  export: () => uCan('export_csv'),
  view_all: () => uCan('view_all_claims'),
  accounts: (u) => !!(u.can_manage_accounts || uCan('create_accounts')),
  settings: (u) => !!(u.role === 'vp' || u.role === 'admin' || uCan('manage_settings')),
  insights: (u) => !!u.can_view_insights,
  superadmin: () => false // covered by the Super Admin pass-through below
};
function noteFor(item, u) {
  if (!u) return false;
  if (u.role === 'superadmin' || !item.audience || !item.audience.length) return true;
  return item.audience.some(k => NOTE_AUDIENCE[k] && NOTE_AUDIENCE[k](u));
}
const releases = () => (Array.isArray(window.CHANGELOG) ? window.CHANGELOG : [])
  .map(r => ({ ...r, items: (r.items || []).filter(it => noteFor(it, state.user)) }))
  .filter(r => r.items.length);
// "Seen" is per account as well as per device: two people sharing a browser see
// different notes, so one opening theirs mustn't clear the other's dot.
const whatsNewKey = () => `reimb.seenRelease.${state.user ? state.user.id : ''}`;
function syncWhatsNewDot() {
  const btn = $('#whatsNewBtn'); if (!btn) return;
  const latest = releases()[0];
  btn.hidden = !latest;
  let seen = null;
  try { seen = localStorage.getItem(whatsNewKey()); } catch { /* private mode */ }
  btn.classList.toggle('has-unread', !!latest && seen !== latest.id);
}
// iOS never offers an install prompt (Android/desktop Chrome do, via sw.js and
// the manifest), so iPhone/iPad users get a one-time card explaining Share →
// Add to Home Screen. Not shown inside the installed app, and gone for good on
// this device once dismissed.
const IOS_HINT_KEY = 'reimb.iosInstallHint';
function initIosInstallHint() {
  const el = $('#iosInstallHint'); if (!el) return;
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support tells them apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem(IOS_HINT_KEY) === 'dismissed'; } catch { /* storage blocked: show it */ }
  if (!ios || installed || dismissed) return;
  el.hidden = false;
  document.body.classList.add('has-ios-hint');
  $('#iosInstallHintClose').addEventListener('click', () => {
    el.hidden = true;
    document.body.classList.remove('has-ios-hint');
    try { localStorage.setItem(IOS_HINT_KEY, 'dismissed'); } catch { /* fine: hidden for this visit */ }
  });
}

function initWhatsNew() {
  const btn = $('#whatsNewBtn'); if (!btn) return;
  btn.addEventListener('click', openWhatsNew);
}
// "1 Oct 2026" in the active language's month names (Khmer/Thai read fine this way too).
function releaseDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return y && m && d ? `${d} ${I18N.months()[m - 1]} ${y}` : String(iso || '');
}
function openWhatsNew() {
  const lang = I18N.getLang();
  const kindLabel = { new: t('New'), improved: t('Improved'), fixed: t('Fixed') };
  const list = releases();
  const body = list.map((r, i) => `
    <section class="wn-release">
      <h3 class="wn-date">${esc(releaseDate(r.date))}${i === 0 ? ` <span class="wn-latest">${esc(t('Latest'))}</span>` : ''}</h3>
      <ul class="wn-items">${(r.items || []).map(it => `
        <li class="wn-item">
          <span class="wn-kind wn-${esc(it.kind)}">${esc(kindLabel[it.kind] || kindLabel.new)}</span>
          <span class="wn-text">${esc((it.text && (it.text[lang] || it.text.en)) || '')}</span>
        </li>`).join('')}
      </ul>
    </section>`).join('');
  openModal(`
    <div class="modal-head">
      <div><h2>${esc(t("What's new"))}</h2><p class="wn-sub">${esc(t('Recent changes and improvements to the portal.'))}</p></div>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body wn-body">${body}</div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  if (list[0]) { try { localStorage.setItem(whatsNewKey(), list[0].id); } catch { /* private mode */ } }
  syncWhatsNewDot();
}

// Whether the server can email reset links (/api/auth-options); until it says
// so, a forgotten password goes through the manager as before.
let passwordResetOn = false;
function renderLoginHint() {
  const el = $('#loginHint');
  if (el) el.textContent = passwordResetOn
    ? t('Need an account? Contact your manager')
    : t('Need an account or forgot your password? Contact your manager');
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
  // The ledger's built options ("All departments" / "All claimants") are
  // rebuilt in the new language, and every custom dropdown's trigger re-reads
  // its (now translated) selected option.
  renderDeptOptions();
  renderClaimantOptions();
  document.querySelectorAll('select').forEach(sel => { if (sel._mselRefresh) sel._mselRefresh(); });
  renderHome();
  if (state.view === 'insights') { if (state.insights.data) renderInsights(); }
  else if (state.view === 'help') renderHelp();
  else if (state.view && state.view !== 'home' && state.view !== 'datechange') {
    const title = $('#listTitle');
    if (title) title.textContent = viewLabel(state.view);
    renderClaims();
  }
}

function showLogin() {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  showSignInPane();
  fetch('/api/auth-options', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(o => { passwordResetOn = !!(o && o.password_reset); showSignInPane(); })
    .catch(() => { /* offline: keep the manager hint */ });
}

// The login card shows one pane at a time: sign in, request a reset link, or
// the "check your email" confirmation.
function showSignInPane(pane = 'signin') {
  $('#loginForm').hidden = pane !== 'signin';
  $('#forgotRow').hidden = pane !== 'signin' || !passwordResetOn;
  $('#forgotForm').hidden = pane !== 'forgot';
  $('#forgotSent').hidden = pane !== 'sent';
  $('#loginHint').hidden = pane !== 'signin';
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
// --- Unrealized-advance hold -------------------------------------------------
// A disbursed cash advance that has not been realized puts this account's New
// Claim / New Meal Allowance on hold (the server refuses those submissions too —
// see heldByUnrealizedAdvance). The count is server-computed and deliberately
// ignores the ledger filters, so a filtered view can never look like the hold
// has lifted. Raising another cash advance is NOT held, and neither is
// resubmitting a rejected claim.
function advanceHold() {
  return Math.max(0, Number(state.user && state.user.my_unrealized_advances) || 0);
}
function advanceHoldReason() {
  const n = advanceHold();
  return n === 1
    ? t('Clear your outstanding cash advance first.')
    : t('Clear your {n} outstanding cash advances first.', { n });
}
// Disabled, never hidden: a button that vanishes reads as a bug, and the title
// says why it is greyed out. renderHome() puts the same reason on the page.
function applyAdvanceHold() {
  const n = advanceHold();
  const why = advanceHoldReason();
  for (const sel of ['#newClaimBtn', '#newMealBtn', '#newMealGpsBtn']) {
    const btn = $(sel);
    if (!btn) continue;
    btn.disabled = n > 0;
    if (n > 0) btn.title = why; else btn.removeAttribute('title');
  }
  // Same reason, spelled out inside the "+ New" menu (titles never show on touch).
  const note = $('#newMenuNote');
  if (note) { note.hidden = !(n > 0); note.textContent = n > 0 ? why : ''; }
}

// Cash advance is a per-account grant (users.allow_advance) set by a super admin
// in the account editor — not a department / job-position / role gate. Super
// admins always hold it, whatever the stored flag says (mirrors the server's
// computePurposes). Own access comes from purposes.advance; this reads OTHER
// accounts' rows in the Settings list.
function hasAdvanceGrant(u) {
  return !!(u && (u.allow_advance || u.role === 'superadmin'));
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
  if (state.view === 'help') loadHelpTab();
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
  // Phone account panel: this account's initials / name, and never left open
  // from a previous session in the same tab.
  syncTbIdentity();
  closeTbSheet();
  // "Purpose" buttons are gated per department + job position (see Settings).
  const purposes = u.purposes || { claim: false, meal: false, advance: false };
  $('#newClaimBtn').hidden = !purposes.claim;
  $('#newMealBtn').hidden = !purposes.meal;
  showMealGpsItem();
  $('#newAdvanceBtn').hidden = !purposes.advance;
  // An unrealized cash advance greys out New Claim / New Meal Allowance. The
  // count arrives on the user payload, so this is right before the first fetch;
  // loadClaims() refreshes it after every ledger load. The home notice is DOM,
  // so clear it here too, or a previous account's hold lingers on screen through
  // a same-tab login switch until the first renderHome().
  const holdNotice = $('#advanceHoldNotice');
  if (holdNotice) { holdNotice.hidden = true; holdNotice.innerHTML = ''; }
  // A new session starts on the recent window, not the last account's choice.
  state.ledgerAll = false;
  applyAdvanceHold();
  // Light up a "draft waiting" dot on any New button that has a saved draft.
  // This also syncs the "+ New" trigger (hidden when no purpose is allowed).
  closeNewMenu(false);
  refreshDraftBadges();
  // What's new: only this account's notes, and their unread dot.
  syncWhatsNewDot();
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
  $('#dcView').hidden = true;
  $('#helpView').hidden = true;
  resetHelpState();
  state.insights = { year: '', month: '', department: '', db: '', name: '', status: 'approved,paid', trend: 'month', drill: null, data: null };
  state.dcPending = 0;
  // Reset the region scope on every login so a same-tab account switch never
  // carries the previous user's chosen region; then show/hide + fill the picker.
  state.viewRegion = '';
  renderRegionPicker();
  loadLookups();
  playEnter($('#homeMenu'));
  loadAll(); // populates state.claims, then renderHome fills in the menu + badge
  scheduleSurvey();
}

// --- Phone top bar: the account panel -----------------------------------------
// On phones the bar is one row (logo · New · What's new · avatar). The avatar
// opens a panel with the signed-in name, the region / language pickers, the
// theme switch, the icon actions and Sign out. The actions are proxies: each
// row clicks the real top-bar button, and a row shows only while that button
// is visible — so all gating (roles, capabilities) stays in one place.
const TB_PROXIES = [['exportBtn', 'Export Excel'], ['profileBtn', 'Profile'], ['accountsBtn', 'Manage accounts'], ['settingsBtn', 'Settings']];
const phoneBar = window.matchMedia('(max-width: 720px)');
// Leaving the phone layout (rotation / wider window) closes an open panel.
phoneBar.addEventListener('change', (e) => { if (!e.matches) closeTbSheet(); });
const initialsOf = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
// A language picked inside the open panel re-labels its rows in place.
window.addEventListener('i18n:changed', () => { if ($('#tbSheet') && !$('#tbSheet').hidden) renderTbList(); });
function syncTbIdentity() {
  const u = state.user; if (!u) return;
  $('#tbAvatar').textContent = initialsOf(u.full_name);
  $('#tbSheetAvatar').textContent = initialsOf(u.full_name);
  $('#tbSheetName').textContent = u.full_name || '';
  $('#tbSheetSub').textContent = [u.department, u.position].filter(Boolean).join(' · ');
}
// The panel's region / language pickers mirror the bar's (which stay put in
// the bar, hidden on phones): native selects — the phone's own picker — that
// copy the real one's options and value, and hand a change back to it, so the
// bar's listeners do the work. Nothing is moved between layouts, so a resize
// or rotation can never strand a control.
const TB_PICKERS = [['regionSelect', 'regionPicker', '📍'], ['topLang', null, '🌐']];
function renderTbPickers() {
  const box = $('#tbSheetCtx');
  box.innerHTML = TB_PICKERS.map(([id, wrapId, icon]) => {
    const real = $('#' + id);
    if (!real || (wrapId && $('#' + wrapId).hidden)) return '';
    return `<label class="tb-pick"><span class="tb-pick-ic" aria-hidden="true">${icon}</span>
      <select class="tb-pick-sel" data-no-msel data-mirror="${id}" aria-label="${esc(real.getAttribute('aria-label') || '')}">${real.innerHTML}</select></label>`;
  }).join('');
  box.querySelectorAll('[data-mirror]').forEach(sel => {
    const real = $('#' + sel.dataset.mirror);
    sel.value = real.value;
    sel.addEventListener('change', () => {
      real.value = sel.value;
      if (real._mselRefresh) real._mselRefresh();
      real.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}
// The proxy rows, in the active language, for the buttons visible right now.
function renderTbList() {
  renderTbPickers();
  $('#tbSheetList').innerHTML = TB_PROXIES.filter(([id]) => { const b = $('#' + id); return b && !b.hidden; })
    .map(([id, label]) => `<button type="button" class="tb-sheet-item" data-proxy="${id}">${$('#' + id).querySelector('svg').outerHTML}<span>${esc(t(label))}</span><span class="tb-chev" aria-hidden="true">›</span></button>`).join('');
}
function openTbSheet() {
  renderTbList();
  // Drop the panel just under the bar (rects are visual px; :root zoom scales
  // the lengths set here, so divide it back out).
  const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  $('#tbSheet').style.top = `${($('.topbar').getBoundingClientRect().bottom + 8) / z}px`;
  $('#tbSheet').hidden = false; $('#tbSheetScrim').hidden = false;
  $('#tbMenuBtn').setAttribute('aria-expanded', 'true');
  const first = $('#tbSheet .tb-sheet-item'); if (first) first.focus({ preventScroll: true });
}
function closeTbSheet() {
  const sheet = $('#tbSheet'); if (!sheet || sheet.hidden) return;
  sheet.hidden = true; $('#tbSheetScrim').hidden = true;
  $('#tbMenuBtn').setAttribute('aria-expanded', 'false');
}
$('#tbMenuBtn').addEventListener('click', () => ($('#tbSheet').hidden ? openTbSheet() : closeTbSheet()));
$('#tbSheetScrim').addEventListener('click', closeTbSheet);
$('#tbSheetClose').addEventListener('click', closeTbSheet);
// Proxy rows: close the panel first, then press the real button (it may open a
// modal, which must not stack under the panel).
$('#tbSheet').addEventListener('click', (e) => {
  const row = e.target.closest('[data-proxy]'); if (!row) return;
  closeTbSheet();
  const real = $('#' + row.dataset.proxy); if (real) real.click();
});
// Escape closes the panel before anything underneath reacts to it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#tbSheet').hidden) { e.stopPropagation(); closeTbSheet(); $('#tbMenuBtn').focus(); }
}, true);

// Show/hide password toggle for any .pw-toggle button next to a password input.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle');
  if (!btn) return;
  const input = btn.parentElement.querySelector('input');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-label', show ? t('Hide password') : t('Show password'));
});

// Caps Lock warning under any password field while it's on (a classic reason a
// correct password "doesn't work"). The hint is created next to the field's
// .pw-wrap on first use, so every password form gets it for free.
function syncCapsHint(e) {
  const input = e.target;
  if (!input || input.tagName !== 'INPUT' || !e.getModifierState) return;
  const wrap = input.closest('.pw-wrap'); if (!wrap) return;
  let hint = wrap.nextElementSibling;
  if (!hint || !hint.classList.contains('caps-hint')) {
    hint = document.createElement('span');
    hint.className = 'caps-hint'; hint.hidden = true; hint.setAttribute('role', 'status');
    wrap.insertAdjacentElement('afterend', hint);
  }
  const on = e.type === 'blur' ? false : e.getModifierState('CapsLock');
  hint.textContent = '⇪ ' + t('Caps Lock is on');
  hint.hidden = !on;
}
['keydown', 'keyup'].forEach(type => document.addEventListener(type, syncCapsHint, true));
document.addEventListener('blur', (e) => { if (e.target && e.target.closest && e.target.closest('.pw-wrap')) syncCapsHint(e); }, true);

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
// The dates already on the rejected claim currently being edited. A resubmit may
// always keep them, even after the window has closed (the server grants the
// same exemption), so a claim rejected late never becomes unfixable. Empty for a
// fresh claim.
let claimDateCarried = new Set();
function setClaimDateCarried(lines) {
  claimDateCarried = new Set((lines || []).map(l => String(l.line_date || '')).filter(Boolean));
}
// The floor a resubmit is held to, from the claim payload (`date_floor`): the
// earlier of today's window and the window the claim was first submitted into,
// so anything that was claimable when it first went in can still be re-dated to.
// undefined on a fresh claim, which just uses today's window.
let claimResubmitFloor;
// The live date-change request on the claim being edited, if any. A granted
// request (from before re-dating became automatic) lifts the claim window for
// this one resubmit.
let claimDateChange = null;
const claimDateUnlocked = () => !!claimDateChange && claimDateChange.status === 'granted';
// Seed everything the date column needs from the claim a form is opening on.
function setClaimDateContext(existing) {
  claimDateChange = (existing && existing.date_change) || null;
  claimResubmitFloor = existing ? (existing.date_floor || '') : undefined;
  // Unlocked claims edit their dates freely, so nothing needs carrying.
  setClaimDateCarried(existing && !claimDateUnlocked() ? existing.lines : null);
}
const claimIsResubmit = () => claimResubmitFloor !== undefined;
// The earliest date this form accepts, or '' when unrestricted.
const claimFloor = () => claimDateUnlocked() ? '' : claimIsResubmit() ? claimResubmitFloor : claimEarliest();
// Is this line date claimable — inside the floor, or carried over from the claim?
const claimDateOk = (d) => {
  const e = claimFloor();
  return !e || String(d || '') >= e || claimDateCarried.has(String(d || ''));
};
// The latest date any expense may carry: today in the region's own time zone.
// An expense that hasn't happened yet can't be claimed, so unlike the window
// floor this ceiling is fixed — no policy setting or date change lifts it.
const claimLatest = () => todayWIB();
// Is this line date still in the future? Carried dates are exempt, so a claim
// that somehow already holds one can still be fixed up and resubmitted.
const claimDateFuture = (d) => String(d || '') > claimLatest() && !claimDateCarried.has(String(d || ''));
// `min`/`max` for a date picker. A line carried in from the returned claim may
// keep its own date even when that sits outside them, so its bounds stretch to
// include it — otherwise the browser would refuse to submit an untouched row.
function claimDateBounds(value, carried) {
  const v = carried ? String(value || '') : '';
  let min = claimFloor();
  let max = claimLatest();
  if (v && min && v < min) min = v;
  if (v && v > max) max = v;
  return `${min ? `min="${esc(min)}" ` : ''}max="${esc(max)}"`;
}
// The date cell for a line. Every row is re-datable, a carried one included.
function claimDateInput(name, value, carried) {
  return `<input name="${name}" type="date" ${claimDateBounds(value, carried)} value="${esc(value || '')}" />`;
}
// The message for a line dated outside the floor, phrased for the situation.
const claimDateError = () => claimIsResubmit()
  ? t('Dates on this claim must be {date} or later — the claim window when it was first submitted.', { date: claimFloor() })
  : t('Expenses dated before {date} can no longer be claimed.', { date: claimFloor() });
// The first problem among a claim's line dates, or null when all are claimable.
// The future check comes first: it has its own message and applies even when no
// claim window is set at all.
function claimDatesError(dates) {
  if (dates.some(d => claimDateFuture(d))) return t('Expenses cannot be dated in the future.');
  if (dates.some(d => !claimDateOk(d))) return claimDateError();
  return null;
}
// A small note under a date field: the floor this form is held to, or nothing.
function claimLimitNote() {
  const e = claimFloor();
  let msg = '';
  if (claimDateUnlocked()) msg = t('A date change was approved — the dates on this claim are editable for this resubmit.');
  else if (claimIsResubmit() && e) msg = t('You can change these dates to {date} or later — the claim window when this claim was first submitted.', { date: e });
  else if (e) msg = t('Only expenses dated {date} or later can be claimed.', { date: e });
  return msg ? `<p class="form-note" style="margin-top:4px">${esc(msg)}</p>` : '';
}
// Rendered into #claimDateBox so the note sits under the lines table.
function renderClaimDateBox() {
  const box = $('#claimDateBox');
  if (box) box.innerHTML = claimLimitNote();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginError'); err.hidden = true;
  const fd = new FormData(e.target);
  // Busy state: a slow network shouldn't invite a second click or look frozen.
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = t('Signing in…');
  const done = () => { btn.disabled = false; btn.classList.remove('is-busy'); btn.textContent = t('Sign in'); };
  try {
    const { user } = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
    });
    state.user = user;
    e.target.reset();
    adoptAccountLang(user);
    done();
    showApp();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; done(); }
});

$('#forgotLink').addEventListener('click', () => {
  $('#loginError').hidden = true;
  $('#forgotError').hidden = true;
  const id = $('#forgotForm [name="identifier"]');
  // Carry over whatever was typed as the username — usually the right account.
  id.value = $('#loginForm [name="username"]').value.trim();
  showSignInPane('forgot');
  id.focus();
});
$('#loginView').addEventListener('click', (e) => {
  if (!e.target.closest('.forgot-cancel')) return;
  showSignInPane();
  $('#loginForm [name="username"]').focus();
});
$('#forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#forgotError'); err.hidden = true;
  const identifier = new FormData(e.target).get('identifier').trim();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = t('Sending…');
  try {
    await api('/forgot-password', { method: 'POST', body: JSON.stringify({ identifier }) });
    e.target.reset();
    showSignInPane('sent');
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  finally { btn.disabled = false; btn.classList.remove('is-busy'); btn.textContent = t('Send reset link'); }
});

$('#logoutBtn').addEventListener('click', () => {
  // It's an icon right beside other buttons, so a stray tap is easy — confirm
  // first, in the app's own centred window rather than the browser's confirm().
  openModal(`
    <div class="modal-head"><h2>${esc(t('Sign out of the portal?'))}</h2>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button></div>
    <div class="modal-body">
      <p style="margin:0">${esc(t("You'll need to sign in again to keep using the portal."))}</p>
      <div class="modal-actions" style="margin-top:22px">
        <button type="button" class="btn btn-ghost" id="signoutCancel">${esc(t('Cancel'))}</button>
        <button type="button" class="btn btn-danger" id="signoutConfirm">${esc(t('Sign out'))}</button>
      </div>
    </div>`);
  $('#modal').classList.add('modal-confirm');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#signoutCancel').addEventListener('click', closeModal);
  $('#signoutConfirm').addEventListener('click', signOut);
  $('#signoutCancel').focus();
});
async function signOut() {
  $('#signoutConfirm').disabled = true;
  try { await api('/logout', { method: 'POST' }); } catch { /* clear the session locally regardless */ }
  // Hard reload on sign-out rather than a client-side view swap. This wipes all
  // in-memory DOM/state so nothing from the previous account (e.g. their Insights
  // charts) can linger into the next login, and it guarantees the next session
  // loads the latest app.js instead of running a stale bundle in the same tab.
  window.location.replace('/');
}
$('#backHome').addEventListener('click', goHome);

// ---- Top-bar "+ New" menu -------------------------------------------------
// New claim / meal allowance / cash advance live in one dropdown. The items
// keep their old ids, so everything that gates them (showApp, the advance hold,
// draft dots) is untouched; syncNewMenu() derives the trigger's state from them.
// The GPS meal allowance: the meal allowance's own gate, in a region that has
// it switched on (Settings → Meal allowance (GPS)).
function showMealGpsItem() {
  $('#newMealGpsBtn').hidden = !(state.user && state.user.meal_gps && state.user.meal_gps.allowed);
  syncNewMenu();
}
const NEW_ITEMS = ['#newClaimBtn', '#newMealBtn', '#newMealGpsBtn', '#newAdvanceBtn'];
function newMenuItems(enabledOnly) {
  return NEW_ITEMS.map(s => $(s)).filter(b => b && !b.hidden && !(enabledOnly && b.disabled));
}
function syncNewMenu() {
  const items = newMenuItems(false);
  $('#newMenuWrap').hidden = !items.length;
  $('#newMenuBtn').classList.toggle('has-draft', items.some(b => b.classList.contains('has-draft')));
  if (!items.length) closeNewMenu(false);
}
function openNewMenu(focusFirst) {
  $('#newMenu').hidden = false;
  $('#newMenuBtn').setAttribute('aria-expanded', 'true');
  if (focusFirst) { const first = newMenuItems(true)[0]; if (first) first.focus(); }
}
function closeNewMenu(refocus) {
  const menu = $('#newMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('#newMenuBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('#newMenuBtn').focus();
}
$('#newMenuBtn').addEventListener('click', (e) => {
  // detail === 0 means keyboard activation (Enter/Space): move focus into the menu.
  if ($('#newMenu').hidden) openNewMenu(e.detail === 0); else closeNewMenu(false);
});
$('#newMenuBtn').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); openNewMenu(true); }
});
$('#newMenu').addEventListener('click', (e) => {
  // Picking an item closes the menu; the item's own handler opens its form.
  if (e.target.closest('.new-item:not(:disabled)')) closeNewMenu(false);
});
$('#newMenu').addEventListener('keydown', (e) => {
  const items = newMenuItems(true);
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(i + step + items.length) % items.length].focus();
  } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNewMenu(true); }
  else if (e.key === 'Tab') closeNewMenu(false);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#newMenuWrap')) closeNewMenu(false);
});

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
  await Promise.all([loadDcPending(), loadHelpSummary()]);
}
// The Super Admin's date-change queue depth, for the tile badge. Nobody else has
// a queue, and a failure here must not cost anyone their menu.
async function loadDcPending() {
  if (!isSuperUser()) { state.dcPending = 0; return; }
  try {
    const r = await api('/date-change-requests');
    state.dcPending = (r.requests || []).filter(x => x.status === 'pending').length;
  } catch { state.dcPending = 0; }
  renderHome();
}

// True when any filter narrows the ledger away from the full set.
function anyFilterActive() {
  const f = state.filters;
  return !!(f.status || f.department || f.q || f.claimant || f.paidFrom || f.paidTo);
}

const totalCardLabel = () => anyFilterActive() ? t('Filtered total') : t('Total value');

// The summary cards describe exactly the rows currently in view, so they track
// every active filter (status, department, search, claimant). Both claim types
// share one ledger, so visibleClaims already spans reimbursement + meal.
function renderSummaryCards() {
  const claims = visibleClaims();
  const count = st => claims.filter(c => c.status === st).length;
  // "Pending" splits by which approver is next: step 1 is with the department
  // Manager; step >= 2 means the Manager approved and it now waits on FinanceAP.
  const pending = bucket => claims.filter(c => c.status === 'submitted'
    && ((Number(c.current_step) || 0) >= 2) === (bucket === 'finance')).length;
  const total = claims.reduce((sum, c) => sum + Number(rowView(c).amount || 0), 0);
  // status key doubles as the filter value; the total card is display-only.
  const cards = [
    { k: 'submitted', l: t('Pending - Manager'), n: pending('manager'), status: 'pending_manager' },
    { k: 'submitted', l: t('Pending - FinanceAP'), n: pending('finance'), status: 'pending_finance' },
    { k: 'approved', l: t('Approved'), n: count('approved'), status: 'approved' },
    { k: 'rejected', l: t('Rejected'), n: count('rejected'), status: 'rejected' },
    { k: 'paid', l: t('Paid'), n: count('paid'), status: 'paid' },
    // Headline reads compact (e.g. IDR 123.3M) so it fits on one line even at
    // billions; the exact figure sits just below for anyone who needs it.
    { k: 'total', l: totalCardLabel(), n: moneyShort(total, regionCurrency()), sub: money(total, regionCurrency()) }
  ];
  enterKeep($('#summaryCards'));
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

// --- Ledger window ------------------------------------------------------------
// By default the ledger holds every open item (anything still waiting on
// someone, whatever its age) plus whatever was active in the last 90 days, so
// it stays quick as years of history pile up. The server applies the rule
// (?since=); see applyLedgerWindow in the server's app.js.
const LEDGER_WINDOW_DAYS = 90;
function ledgerSince() {
  const d = new Date();
  d.setDate(d.getDate() - LEDGER_WINDOW_DAYS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Full history is needed when asked for, when searching (finding an old claim
// number is the point of a search), or when the payment-date range reaches back
// past the window — otherwise those would silently miss older claims.
function needsAllHistory() {
  const { q, paidFrom, paidTo } = state.filters;
  const since = ledgerSince();
  return state.ledgerAll || !!q || (!!paidFrom && paidFrom < since) || (!!paidTo && paidTo < since);
}
// The one-line note under the filters saying what the list covers, with the
// switch. Hidden while a search / old date range has already widened the load.
function renderLedgerScope() {
  const el = $('#ledgerScope');
  if (!el) return;
  const auto = state.ledgerLoadedAll && !state.ledgerAll;
  el.hidden = auto;
  if (auto) return;
  el.innerHTML = state.ledgerAll
    ? `<span>${esc(t('Showing all history.'))}</span>
       <button type="button" class="link-btn" data-scope="recent">${esc(t('Show the last 90 days only'))}</button>`
    : `<span>${esc(t('Showing open claims and anything active in the last 90 days.'))}</span>
       <button type="button" class="link-btn" data-scope="all">${esc(t('Show all history'))}</button>`;
}
$('#ledgerScope').addEventListener('click', e => {
  const b = e.target.closest('[data-scope]');
  if (!b) return;
  const prev = state.ledgerAll;
  state.ledgerAll = b.dataset.scope === 'all';
  b.disabled = true;
  // On failure, put the switch back so the note matches what is on screen.
  loadClaims().catch(err => { state.ledgerAll = prev; renderLedgerScope(); throw err; });
});

async function loadClaims() {
  const p = new URLSearchParams();
  if (state.filters.status) p.set('status', state.filters.status);
  if (state.filters.department) p.set('department', state.filters.department);
  if (state.filters.q) p.set('q', state.filters.q);
  const loadAll = needsAllHistory();
  if (!loadAll) p.set('since', ledgerSince());
  // All-region viewers may scope the ledger (and thus the home tiles) to one region.
  if (state.viewRegion) p.set('region', state.viewRegion);
  const qs = p.toString();
  // Reimbursement + meal allowance claims share one ledger. Tag each with a
  // type so rows, the drawer, and actions can branch to the right endpoints.
  const [r, m, a] = await Promise.all([api('/claims?' + qs), api('/meal-claims?' + qs), api('/cash-advances?' + qs)]);
  const reimb = (r.claims || []).map(c => ({ ...c, type: 'reimbursement' }));
  const meal = (m.claims || []).map(c => ({ ...c, type: 'meal' }));
  const adv = (a.claims || []).map(c => ({ ...c, type: 'advance' }));
  // Read the hold off the response rather than counting the rows just fetched:
  // those are filtered, my_unrealized is not.
  if (state.user && typeof a.my_unrealized === 'number') {
    state.user.my_unrealized_advances = a.my_unrealized;
  }
  applyAdvanceHold();
  state.claims = [...reimb, ...meal, ...adv].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  state.ledgerLoadedAll = loadAll; // renderClaims() below redraws the scope note
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
    return { typeLabel: c.scheme === 'gps' ? t('Meal allowance (GPS)') : t('Meal allowance'), date: first, amount: c.total_amount, db: site };
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
  sel.innerHTML = `<option value="">${esc(t('All departments'))}</option>` +
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
  sel.innerHTML = `<option value="">${esc(t('All claimants'))}</option>` +
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
  // List rows arrive without history; the server works this out for them.
  if (typeof c.reviewed_by_me === 'boolean') return c.reviewed_by_me;
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
// (the claimant must resubmit), and so is an approved one with an unused
// balance still to be refunded (owesRefund) — it clears when Finance settles. Request-stage advances (submitted/approved/
// rejected — not yet disbursed) belong to the claim queues, not here.
const ADV_UNREALIZED = ['paid', 'realize_submitted', 'rejected_realize'];
const ADV_REALIZED = ['realize_approved', 'settled'];
// Oversight roles see every advance; everyone else only their own.
function advanceScope() {
  const u = state.user;
  const all = seesAllAdvances(u);
  return state.claims.filter(c => c.type === 'advance' && (all || c.employee_id === (u && u.id)));
}
const unrealizedQueue = () => advanceScope().filter(c => ADV_UNREALIZED.includes(c.status) || owesRefund(c));
const realizedQueue = () => advanceScope().filter(c => ADV_REALIZED.includes(c.status) && !owesRefund(c));

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

// The payment date Finance entered on "Mark as paid". It is stored as midnight
// UTC (the DB session zone), so the ISO date part is exactly the picked date.
const paidDate = c => String(c.paid_at || '').slice(0, 10);

// Rows currently shown, after the client-side claimant + payment-date filters.
function visibleClaims() {
  const { claimant: cl, paidFrom: pf, paidTo: pt } = state.filters;
  let rows = viewClaims();
  if (cl) rows = rows.filter(c => c.claimant_name === cl);
  if (state.view === 'paid' && (pf || pt)) {
    rows = rows.filter(c => {
      const d = paidDate(c);
      return d && (!pf || d >= pf) && (!pt || d <= pt);
    });
  }
  return rows;
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
  $('#homeGreeting').textContent = u.full_name ? t('Hi {name}', { name: u.full_name.split(' ')[0] }) : '';
  // Two greyed-out buttons in the top bar need a reason on the page, plus a way
  // straight to the advances that caused it.
  const hold = advanceHold();
  const notice = $('#advanceHoldNotice');
  if (notice) {
    notice.hidden = !hold;
    if (hold) {
      notice.innerHTML = `<span class="home-notice-txt">${esc(hold === 1
          ? t('You have a cash advance that is not cleared yet. New claims and meal allowances are on hold until it is realized and any unused balance is returned.')
          : t('You have {n} cash advances that are not cleared yet. New claims and meal allowances are on hold until they are realized and any unused balance is returned.', { n: hold }))}</span>
        <button type="button" class="btn btn-amber-soft btn-sm" id="holdGo">${esc(t('View cash advances'))}</button>`;
      $('#holdGo').addEventListener('click', () => openView('unrealized'));
    } else {
      notice.innerHTML = '';
    }
  }
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
  // …and, because the grant is per-account and revocable, whenever the account
  // still holds advances of its own: revoking mid-flight must not hide an
  // already-paid advance the holder still has to realize.
  // advanceHold() leads deliberately — it is the server's UNFILTERED count, so an
  // outstanding advance keeps its tiles even when the ledger is filtered down to
  // nothing (a status/search filter, or an all-regions viewer scoped elsewhere).
  // The queue lengths only add the already-realized-history case; the counts ON
  // the tiles still follow the current view, which is what a count should do.
  if (seesAllAdvances(u) || (u.purposes && u.purposes.advance)
      || advanceHold() || unrealizedQueue().length || realizedQueue().length) {
    tiles.push({ key: 'unrealized', title: t('Unrealized cash advances'), desc: t('Advances paid — awaiting realization or refund'), count: unrealizedQueue().length });
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
  // Date changes. Claimants re-date returned claims themselves now (within the
  // window the claim was first submitted into), so only a Super Admin sees this
  // — to clear any request raised before that, while some are still waiting.
  if (isSuperUser() && state.dcPending > 0) {
    tiles.push({
      key: 'datechange',
      title: t('Request change of date'),
      desc: t('Unlock the dates on a returned claim'),
      count: state.dcPending,
      badge: true,
      link: t('Open') });
  }
  // Help: everyone's helpdesk and feedback. The counts are the account's
  // unread answers, or for the helpdesk (Super Admins) what's waiting on them.
  const help = (state.help && state.help.summary) || { tickets: 0, feedback: 0 };
  const helpStaff = isSuperUser();
  tiles.push({
    key: 'helpdesk', title: t('Helpdesk'),
    desc: helpStaff ? t('Answer questions from staff') : t('Ask a question or report a problem'),
    count: help.tickets, badge: true, link: help.tickets ? '' : t('Open'),
    unit: (n) => helpStaff ? t('waiting') : (n === 1 ? t('new reply') : t('new replies')),
    attnLabel: (n) => helpStaff ? t('{n} waiting for an answer', { n }) : t('{n} new replies', { n })
  });
  tiles.push({
    key: 'feedback', title: t('Feedback & suggestions'),
    desc: helpStaff ? t('Read criticism and suggestions from staff') : t('Tell us what could be better'),
    count: helpStaff ? help.feedback : 0, badge: helpStaff, link: helpStaff && help.feedback ? '' : t('Open'),
    unit: () => t('new'), attnLabel: (n) => t('{n} new', { n })
  });
  // Where the bases are, with the GPS meal allowance radius around each (js/map.js).
  tiles.push({ key: 'basemap', title: t('Bases map'), desc: t('Every base and its {km} km radius', { km: mgRules().minKm }), link: t('Open') });
  // One line under the greeting saying what needs doing, for anyone who
  // approves (or has something waiting).
  const summary = $('#homeSummary');
  if (summary) {
    summary.hidden = !(iAmApprover || need);
    summary.textContent = need === 1 ? t('1 claim is waiting for your approval.')
      : need ? t('{n} claims are waiting for your approval.', { n: need })
      : t('Nothing is waiting for your approval right now.');
    summary.classList.toggle('has-work', need > 0);
  }
  // Tiles grouped under short headings, in this order; a group with no visible
  // tile is left out.
  const groups = [
    ['Your claims', ['mine']],
    ['Approvals', ['approval', 'approved', 'reviewed']],
    ['Finance', ['paid']],
    ['Cash advances', ['unrealized', 'realized']],
    ['Overview', ['all', 'insights', 'datechange']],
    ['Locations', ['basemap']],
    ['Help', ['helpdesk', 'feedback']]
  ];
  const tileHtml = (tile) => {
    const attn = tile.badge && tile.count > 0;
    const count = tile.link
      ? `<span class="ht-go"><span class="ht-go-t">${esc(tile.link)}</span> <span aria-hidden="true">→</span></span>`
      : `<span class="ht-n">${tile.count > 999 ? '999+' : tile.count}</span><span class="ht-unit">${esc(tile.unit ? tile.unit(tile.count) : tile.count === 1 ? t('claim') : t('claims'))}</span>`;
    const attnText = tile.attnLabel ? tile.attnLabel(tile.count) : t('{count} awaiting approval', { count: tile.count });
    return `<button class="home-tile ht-${tile.key}${attn ? ' ht-attn' : ''}" data-view="${tile.key}" type="button"${attn ? ` aria-label="${esc(tile.title)} — ${esc(attnText)}"` : ''}>
      <span class="ht-ic" aria-hidden="true">${HOME_ICONS[tile.key] || ''}</span>
      <span class="ht-text"><span class="tile-title">${esc(tile.title)}</span><span class="tile-desc">${esc(tile.desc)}</span></span>
      <span class="ht-count">${count}</span>
    </button>`;
  };
  enterKeep(menu);
  menu.innerHTML = groups.map(([label, keys]) => {
    const list = keys.map(k => tiles.find(x => x.key === k)).filter(Boolean);
    return list.length ? `<section class="home-group"><h3 class="home-group-l">${esc(t(label))}</h3>
      <div class="home-group-grid">${list.map(tileHtml).join('')}</div></section>` : '';
  }).join('');
  $$('.home-tile', menu).forEach(el => el.addEventListener('click', () => {
    const v = el.dataset.view;
    if (v === 'insights') openInsights();
    else if (v === 'datechange') openDateChanges();
    else if (v === 'basemap') openBasesMap();
    else if (v === 'helpdesk' || v === 'feedback') openHelp(v === 'feedback' ? 'feedback' : 'tickets');
    else openView(v);
  }));
}
// Line icons for the home tiles (24px grid, stroke = currentColor).
const svgI = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const HOME_ICONS = {
  mine: svgI('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>'),
  approval: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  approved: svgI('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'),
  reviewed: svgI('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>'),
  paid: svgI('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'),
  unrealized: svgI('<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>'),
  realized: svgI('<path d="M20 7H6a2 2 0 0 1 0-4h12v4"/><path d="M4 5v14a2 2 0 0 0 2 2h14V7"/><path d="M9 14l2 2 4-4"/>'),
  all: svgI('<path d="M12 2l10 6-10 6L2 8z"/><path d="M2 16l10 6 10-6"/>'),
  insights: svgI('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  datechange: svgI('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  helpdesk: svgI('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>'),
  basemap: svgI('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  feedback: svgI('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>')
};

// Open one list view; go back to the clean menu.
function openView(key) {
  state.view = key;
  state.selected.clear();
  $('#homeView').hidden = true;
  $('#listView').hidden = false;
  playEnter($('#summaryCards'));
  playEnter($('#claimRows'));
  $('#listTitle').textContent = viewLabel(key);
  // The payment date column + range filter belong to the Paid claims view only.
  const paid = key === 'paid';
  $('#paidRange').hidden = !paid;
  $('.ledger').classList.toggle('show-paid', paid);
  // My claims are all the viewer's own: phone cards lead with the expense, not the name.
  $('.ledger').classList.toggle('view-mine', key === 'mine');
  setSelectMode(false);
  if (!paid) setPaidRange('', '');
  renderClaims();
}
function goHome() {
  state.view = 'home';
  // Clean slate: clear filters so the menu counts reflect everything.
  state.filters = { status: '', department: '', claimant: '', q: '', paidFrom: '', paidTo: '' };
  state.ledgerAll = false; // back to the recent window, like the filters
  setPaidRange('', '');
  const si = $('#searchInput'); if (si) si.value = '';
  const sf = $('#statusFilter'); if (sf) { sf.value = ''; if (sf._mselRefresh) sf._mselRefresh(); }
  $('#listView').hidden = true;
  const iv = $('#insightsView'); if (iv) iv.hidden = true;
  const dv = $('#dcView'); if (dv) dv.hidden = true;
  const hv = $('#helpView'); if (hv) hv.hidden = true;
  $('#homeView').hidden = false;
  playEnter($('#homeMenu'));
  loadClaims(); // refetch unfiltered, then renderHome via loadClaims
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
  paid: c => paidDate(c),
  status: c => c.status === 'submitted' ? pendingReviewBase(c.current_step) : (STATUS_LABEL[c.status] || c.status || '')
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
  renderLedgerScope();
  syncFilterUI();
  const wrap = $('#claimRows');
  const claims = sortClaims(visibleClaims());
  if (!claims.length) {
    wrap.innerHTML = '';
    const empty = $('#emptyState');
    if (anyFilterActive()) {
      empty.innerHTML = `<span>${esc(t('No claims match your filters.'))}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-clear-filters>${esc(t('Clear filters'))}</button>`;
      empty.querySelector('[data-clear-filters]').addEventListener('click', () => $('#clearFiltersBtn').click());
    } else {
      empty.textContent = viewEmpty(state.view);
    }
    empty.hidden = false;
    updateSelectionUI(); renderSummaryCards(); return;
  }
  $('#emptyState').hidden = true;
  enterKeep(wrap);
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
      <span class="col-paid mono" data-label="${esc(t('Paid on'))}">${esc(paidDate(c)) || '—'}</span>
      <span class="col-amt">${esc(money(v.amount, c.currency))}</span>
      <span class="col-status"><span class="pill ${pillClass(c)}">${esc(statusLabelFor(c))}</span></span>
    </div>`; }).join('');
  if (typeof markOpenRow === 'function') markOpenRow();
  $$('.ledger-row', wrap).forEach(el => {
    const open = () => {
      if (selectMode()) { const cb = el.querySelector('.row-check'); cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); return; }
      openDrawer(el.dataset.id, el.dataset.type);
    };
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

// Header count, the phone "Filters" badge (dropdown filters only — the search
// box is always in view) and the Clear filters button follow the active filters.
function syncFilterUI() {
  const n = visibleClaims().length;
  $('#listCount').textContent = n === 1 ? t('{n} claim', { n }) : t('{n} claims', { n });
  const f = state.filters;
  const folded = [f.status, f.department, f.claimant, f.paidFrom || f.paidTo].filter(Boolean).length;
  const badge = $('#filterCount');
  badge.textContent = folded; badge.hidden = !folded;
  $('#filterToggle').classList.toggle('has-active', !!folded);
  $('#clearFiltersBtn').hidden = !anyFilterActive();
}
$('#filterToggle').addEventListener('click', () => {
  const panel = $('#filterPanel');
  const open = !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  $('#filterToggle').setAttribute('aria-expanded', String(open));
});
// Reset every filter of the current list view (search included) in one go.
$('#clearFiltersBtn').addEventListener('click', () => {
  state.filters = { status: '', department: '', claimant: '', q: '', paidFrom: '', paidTo: '' };
  setPaidRange('', '');
  $('#searchInput').value = '';
  for (const id of ['#statusFilter', '#deptFilter', '#claimantFilter']) {
    const sel = $(id); sel.value = ''; if (sel._mselRefresh) sel._mselRefresh();
  }
  loadClaims();
});

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
// Payment-date range (Paid claims view). Client-side like the claimant filter.
// Each end bounds the other's picker so the range can't be entered backwards.
function setPaidRange(from, to) {
  state.filters.paidFrom = from;
  state.filters.paidTo = to;
  const f = $('#paidFrom'), tt = $('#paidTo');
  f.value = from; tt.value = to;
  f.max = to; tt.min = from;
  $('#paidRange').classList.toggle('active', !!(from || to));
  $('#paidRangeClear').hidden = !(from || to);
}
// A range reaching back past the ledger window fetches the full history first;
// otherwise the claims already loaded cover it.
const rerenderForPaidRange = () => (needsAllHistory() && !state.ledgerLoadedAll ? loadClaims() : renderClaims());
const onPaidRange = () => { setPaidRange($('#paidFrom').value, $('#paidTo').value); rerenderForPaidRange(); };
$('#paidFrom').addEventListener('change', onPaidRange);
$('#paidTo').addEventListener('change', onPaidRange);
$('#paidRangeClear').addEventListener('click', () => { setPaidRange('', ''); rerenderForPaidRange(); });
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
// Modal helpers
// ---------------------------------------------------------------------------
// Freeze the page behind any open modal / drawer so the background can't scroll.
function syncScrollLock() {
  const m2 = $('#modal2');
  // A side-by-side claim window (Glass, wide screens) leaves the list scrollable.
  const drawerBlocks = !$('#drawer').hidden && !document.body.classList.contains('glass-split');
  const open = !$('#modal').hidden || (m2 && !m2.hidden) || drawerBlocks;
  document.body.classList.toggle('no-scroll', !!open);
}
// A callback run once the next time #modal closes, then cleared. Lets a modal
// (e.g. the insights drill-down window) clean up page state on every close path
// — its ×, the scrim, or Escape — which all funnel through closeModal().
let modalCloseHook = null;
function openModal(html) {
  if (surveyLock) return; // the survey stays until it's answered
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
  if (surveyLock) return;
  leaveGhost($('#modal')); leaveGhost($('#modalScrim'));
  $('#modal').hidden = true; $('#modalScrim').hidden = true;
  $('#modal').classList.remove('modal-wide', 'modal-xwide', 'modal-flex', 'modal-confirm', 'modal-ws', 'modal-ma', 'modal-adv', 'modal-export', 'modal-profile', 'modal-survey', 'modal-help', 'modal-help-thread');
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
function closeModal2() { leaveGhost($('#modal2')); leaveGhost($('#modal2Scrim')); $('#modal2').hidden = true; $('#modal2Scrim').hidden = true; $('#modal2').classList.remove('modal-wide', 'modal-xwide', 'modal-flex', 'modal-ue', 'modal-rp', 'modal-hp-lb'); syncScrollLock(); }
$('#modal2Scrim').addEventListener('click', closeModal2);

// Open a receipt <input type="file">. `camera` (the phone-only "Take photo"
// buttons, .rc-cam) goes straight to the rear camera; otherwise the usual
// picker with files and the gallery. One input serves both, so the attributes
// are set per press.
function pickFiles(inp, camera) {
  if (inp.dataset.accept == null) inp.dataset.accept = inp.accept;
  if (camera) { inp.setAttribute('capture', 'environment'); inp.accept = 'image/*'; }
  else { inp.removeAttribute('capture'); inp.accept = inp.dataset.accept; }
  inp.click();
}

// Phone Back button / iOS swipe-back closes the topmost panel instead of
// leaving the app. While any panel is open, one extra history entry sits on
// top; Back consumes it and we "tap" that panel's scrim, so every close path
// (draft auto-save, the photo editor's cancel, the survey lock) behaves exactly
// like tapping outside. Closing by ×/Escape/submit pops the entry back off.
// Synced from a MutationObserver, so a modal replaced by another in the same
// tick never touches history.
const OVERLAY_LAYERS = [ // topmost first
  ['#tbSheet', '#tbSheetScrim'],
  ['#modal2', '#modal2Scrim'],
  ['#drawer.over-modal', '#drawerScrim'],
  ['#modal', '#modalScrim'],
  ['#drawer', '#drawerScrim']
];
let overlayArmed = false;     // our history entry is on top
let overlaySkipPop = false;   // the next popstate is our own history.back()
// Reloaded while a panel was open: this entry is a leftover; nothing is open now.
if (history.state && history.state.rbOverlay) history.replaceState(null, '');
function overlayOpen() { return OVERLAY_LAYERS.some(([p]) => { const el = $(p); return el && !el.hidden; }); }
function syncOverlayHistory() {
  const open = overlayOpen();
  if (open && !overlayArmed) {
    history.pushState({ rbOverlay: true }, '');
    overlayArmed = true;
  } else if (!open && overlayArmed) {
    overlayArmed = false;
    overlaySkipPop = true;
    history.back();
  }
}
window.addEventListener('popstate', () => {
  if (overlaySkipPop) { overlaySkipPop = false; return; }
  if (!overlayArmed) return;
  overlayArmed = false; // Back just consumed our entry
  const layer = OVERLAY_LAYERS.find(([p]) => { const el = $(p); return el && !el.hidden; });
  if (layer) $(layer[1]).click();
  // Still open (another layer below, or a locked modal): re-arm for the next Back.
  syncOverlayHistory();
});
// Phones fit Search · Filters · Select on one row, where the long placeholder
// gets cut off mid-word: use the short one there. Setting data-i18n-ph keeps a
// language switch picking the right one.
const phoneQuery = window.matchMedia('(max-width: 720px)');
function syncSearchPlaceholder() {
  const el = $('#searchInput');
  el.dataset.i18nPh = phoneQuery.matches ? 'Search…' : 'Search claim no, name, type, DB…';
  el.placeholder = t(el.dataset.i18nPh);
}
syncSearchPlaceholder();
phoneQuery.addEventListener('change', syncSearchPlaceholder);

new MutationObserver(syncOverlayHistory).observe(document.body,
  { attributes: true, attributeFilter: ['hidden'], subtree: true });
