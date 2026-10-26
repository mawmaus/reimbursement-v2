'use strict';

// Settings: regions, a region's workspace and its pages (claim window, meal rates, currency, roles, lookups).
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Admin: Settings (accounts, departments, positions, expense types)
// ---------------------------------------------------------------------------
// Tabs inside a region workspace. Regions themselves live one level up (the
// Regions landing), so there is no Regions tab here.
// `group` places the page in the side menu; `desc` heads the page ({region} is
// filled in). Order here is menu order.
const SETTINGS_GROUPS = ['People', 'Organisation', 'Claims', 'Region'];
const SETTINGS_TABS = [
  { key: 'accounts', label: 'Accounts', group: 'People', accounts: true,
    desc: 'Everyone who can sign in to {region}: their role, department, position and approval limit.' },
  { key: 'roles', label: 'Roles', group: 'People', roleMatrix: true,
    desc: 'Set what each role in {region} can do. Super Admin always has every permission and is not shown. The Employee row is shown for reference. These grants are added on top of what a user already gets from their job position and department.' },
  { key: 'departments', label: 'Departments', group: 'Organisation', cap: 'manage_settings',
    desc: 'The departments in {region}, and which kinds of claim their members may raise.' },
  { key: 'positions', label: 'Job positions', group: 'Organisation', cap: 'manage_settings',
    desc: 'The job positions in {region}, most senior first. A position may manage the accounts ranked below it.' },
  { key: 'expense-types', label: 'Expense types', group: 'Claims', cap: 'manage_settings',
    desc: 'The expense types claimants in {region} choose from on each reimbursement line.' },
  { key: 'meal-rates', label: 'Meal allowance', group: 'Claims', cap: 'manage_settings',
    desc: 'Set the preset amounts the Meal Allowance form offers in its Amount dropdown.' },
  { key: 'meal-gps', label: 'Meal allowance (GPS)', group: 'Claims', cap: 'manage_settings',
    desc: 'Switch the GPS meal allowance on or off for {region}. When it is on, claimants record their location and attach a receipt for every day, measured against the base on their account.' },
  { key: 'bases', label: 'Bases', group: 'Claims', cap: 'manage_settings',
    desc: 'The places accounts in {region} work from. The GPS meal allowance measures each day’s distance from the account’s base. Choose which accounts belong to each base here.' },
  { key: 'claim-window', label: 'Claim window', group: 'Claims', cap: 'manage_settings',
    desc: 'Set how far back an expense may be dated and still be claimable. Both rules apply — the effective earliest date is whichever is later. A rejected claim can always be resubmitted with the dates it already had.' },
  { key: 'region-prefs', label: 'Currency, time zone & bank', group: 'Region', regionPrefs: true,
    desc: 'Set the default currency and time zone for {region}. New claims use this currency, and the time zone decides what counts as “today” for claim dates.' }
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
// Phones clamp long page descriptions to two lines (.clamp-desc); a tap
// toggles the full text.
document.addEventListener('click', (e) => {
  const d = e.target.closest && e.target.closest('.clamp-desc');
  if (d) d.classList.toggle('open');
});
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

// Regions landing (super admin): one row per region — its headcount and open
// workload, an Open button into its workspace, and a ⋯ menu to rename, disable
// or delete it. Disabled regions sit in their own group below. "Add region"
// lives in the header; search appears only once the list is long enough.
function openRegionsLanding() {
  openModal(`
    <div class="modal-head">
      <div>
        <h2>${esc(t('Regions'))}</h2>
        <p class="rg-sub">${esc(t('Each region has its own accounts, departments, job positions, expense types, claim window and roles.'))}</p>
      </div>
      <div class="rg-head-acts">
        <button type="button" class="btn btn-primary btn-sm" id="rgAddBtn">+ ${esc(t('Add region'))}</button>
        <button class="x-btn">×</button>
      </div>
    </div>
    <div class="modal-body"><div id="settingsPanel"></div></div>`);
  // "← Regions" swaps the workspace out in place, so shed its sizing first.
  $('#modal').classList.remove('modal-xwide', 'modal-ws');
  $('#modal').classList.add('modal-wide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#rgAddBtn').addEventListener('click', () => {
    const form = $('#rgAddForm'); if (!form) return;
    form.hidden = false; form.querySelector('input').focus();
  });
  renderRegionsLanding();
}

async function renderRegionsLanding() {
  const panel = $('#settingsPanel');
  closeRowMenu();
  if (!panel.children.length) panel.innerHTML = `<p class="muted" style="padding:20px 0">${esc(t('Loading…'))}</p>`;
  let items, stats = {};
  try {
    const [list, overview] = await Promise.all([api('/regions'), api('/regions/overview').catch(() => ({ items: {} }))]);
    items = list.items; stats = overview.items || {};
  } catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const active = items.filter(r => r.active), disabled = items.filter(r => !r.active);
  const stat = (r) => stats[r.name] || { accounts: 0, open: 0 };
  const row = (r) => {
    const s = stat(r);
    return `
      <div class="rg-row${r.active ? '' : ' rg-off'}" data-id="${r.id}">
        <div class="rg-main">
          <div class="rg-name">${esc(r.name)}</div>
          <div class="rg-stats">
            <span>${esc(t(s.accounts === 1 ? '{n} account' : '{n} accounts', { n: s.accounts }))}</span>
            <span aria-hidden="true">·</span>
            <span class="${s.open ? 'rg-open' : ''}">${esc(t(s.open === 1 ? '{n} open document' : '{n} open documents', { n: s.open }))}</span>
          </div>
        </div>
        <div class="rg-acts">
          ${r.active ? `<button type="button" class="btn btn-brand-soft btn-sm" data-open="${esc(r.name)}">${esc(t('Open settings'))} →</button>` : ''}
          <button type="button" class="row-more" data-menu="${r.id}" aria-haspopup="menu" aria-label="${esc(t('More actions'))}" title="${esc(t('More actions'))}">⋯</button>
        </div>
      </div>`;
  };
  panel.innerHTML = `
    <form id="rgAddForm" class="rg-add" hidden>
      <input name="name" class="input" required maxlength="60" placeholder="${esc(t('New region name'))}" aria-label="${esc(t('New region name'))}" />
      <button type="submit" class="btn btn-primary btn-sm">${esc(t('Add'))}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cancel>${esc(t('Cancel'))}</button>
      <p class="form-error" id="rgAddErr" hidden></p>
    </form>
    ${items.length > 8 ? `<div class="rg-search"><input id="rgSearch" class="input" type="search" placeholder="${esc(t('Search {noun}…', { noun: t('region') }))}" /></div>` : ''}
    <div class="rg-scroll">
      ${active.length ? `<div class="rg-list">${active.map(row).join('')}</div>`
        : `<p class="rg-empty">${esc(t('No regions yet. Add one to get started.'))}</p>`}
      ${disabled.length ? `<div class="section-label">${esc(t('Disabled'))} · ${disabled.length}</div>
        <div class="rg-list">${disabled.map(row).join('')}</div>` : ''}
    </div>
    <button type="button" class="rg-survey" id="rgSurveyBtn">
      <span class="rg-survey-ic" aria-hidden="true">★</span>
      <span class="rg-survey-text"><strong>${esc(t('Experience survey'))}</strong><span>${esc(t('How staff rate paper vs digital reimbursing'))}</span></span>
      <span class="rg-survey-go">${esc(t('View results'))} →</span>
    </button>`;

  $('#rgSurveyBtn').addEventListener('click', openSurveyResults);
  const byId = (id) => items.find(x => x.id == id);
  const addForm = $('#rgAddForm');
  if (!items.length) addForm.hidden = false;
  addForm.querySelector('[data-cancel]').addEventListener('click', () => { addForm.reset(); addForm.hidden = true; $('#rgAddErr').hidden = true; });
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(addForm).get('name').trim();
    try { await api('/regions', { method: 'POST', body: JSON.stringify({ name }) }); toast(t('Added')); refreshAfterSettings(); }
    catch (ex) { const el = $('#rgAddErr'); el.textContent = ex.message; el.hidden = false; }
  });
  const search = $('#rgSearch');
  if (search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    $$('#settingsPanel .rg-row').forEach(r => { r.hidden = !!q && !r.querySelector('.rg-name').textContent.toLowerCase().includes(q); });
  });
  $$('#settingsPanel [data-open]').forEach(b => b.addEventListener('click', () => {
    settingsState.region = b.dataset.open;
    settingsState.tab = 'accounts';
    openRegionWorkspace();
  }));
  $$('#settingsPanel [data-menu]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const it = byId(b.dataset.menu);
    openRowMenu(b, 'region:' + it.id, [
      { act: 'rename', label: t('Rename') },
      { act: 'toggle', label: it.active ? t('Disable') : t('Enable') },
      { act: 'delete', label: t('Delete'), danger: true }
    ], (act) => regionAction(act, it, stat(it)));
  }));
}

async function regionAction(act, it, s) {
  if (act === 'rename') {
    const name = prompt(t('Rename region'), it.name);
    if (name === null || !name.trim() || name.trim() === it.name) return;
    try { await api(`/regions/${it.id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) }); toast(t('Renamed')); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  } else if (act === 'toggle') {
    if (it.active && (s.accounts || s.open) && !confirm(t('Disable {name}? Its {accounts} account(s) and {open} open document(s) are kept, but it can no longer be chosen for new accounts.', { name: it.name, accounts: s.accounts, open: s.open }))) return;
    try { await api(`/regions/${it.id}`, { method: 'PUT', body: JSON.stringify({ active: !it.active }) }); toast(t('Saved')); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  } else if (act === 'delete') {
    const msg = (s.accounts || s.open)
      ? t('Delete {name}? It still has {accounts} account(s) and {open} open document(s), which would be left without a valid region. Consider disabling it instead.', { name: it.name, accounts: s.accounts, open: s.open })
      : t('Delete {name}? This cannot be undone.', { name: it.name });
    if (!confirm(msg)) return;
    try { await api(`/regions/${it.id}`, { method: 'DELETE' }); toast(t('Deleted')); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  }
}

// A row's ⋯ menu (Regions list, settings lookups). Portaled to <body> and
// fixed-positioned under its button so a scrolling list never clips it; an
// outside click, Escape or any scroll closes it, and clicking the same button
// again toggles it shut. `items` are { act, label, danger }; a danger item gets
// a divider above it. `onPick(act)` runs after the menu closes.
let rowMenuKey = null;
function closeRowMenu() {
  const m = $('#rowMenu'); if (m) m.remove();
  $$('.row-more[aria-expanded]').forEach(b => b.removeAttribute('aria-expanded'));
  rowMenuKey = null;
  document.removeEventListener('click', closeRowMenu);
  document.removeEventListener('keydown', rowMenuEsc, true);
  document.removeEventListener('scroll', closeRowMenu, true);
}
function rowMenuEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeRowMenu(); } }
function openRowMenu(btn, key, items, onPick) {
  if (rowMenuKey === key) return closeRowMenu();
  closeRowMenu();
  rowMenuKey = key;
  btn.setAttribute('aria-expanded', 'true');
  const menu = document.createElement('div');
  menu.id = 'rowMenu'; menu.className = 'row-menu'; menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) =>
    `${it.danger && i ? '<div class="row-menu-sep"></div>' : ''}<button type="button" role="menuitem"${it.danger ? ' class="row-menu-danger"' : ''} data-act="${esc(it.act)}">${esc(it.label)}</button>`).join('');
  document.body.appendChild(menu);
  // Rects are visual px but lengths set here get scaled by :root zoom (see the
  // custom select menu), so work in visual px and divide the zoom back out.
  const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const r = btn.getBoundingClientRect();
  const h = menu.offsetHeight * z, w = menu.offsetWidth * z;
  const below = r.bottom + 6 + h <= window.innerHeight;
  menu.style.top = `${Math.max(8, below ? r.bottom + 6 : r.top - 6 - h) / z}px`;
  menu.style.left = `${Math.max(8, r.right - w) / z}px`;
  setTimeout(() => {
    document.addEventListener('click', closeRowMenu);
    document.addEventListener('keydown', rowMenuEsc, true);
    document.addEventListener('scroll', closeRowMenu, true);
  });
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = e.target.closest('[data-act]'); if (!act) return;
    closeRowMenu();
    onPick(act.dataset.act);
  });
  menu.querySelector('button').focus();
}

// A region's workspace: a grouped side menu of that region's settings pages,
// and the open page with its own header (title, what it controls, its main
// action). Super admins get a "← Regions" button to go back and switch regions;
// region-pinned managers do not (they only ever see their own).
function openRegionWorkspace() {
  const u = state.user;
  const isSuper = u && u.role === 'superadmin';
  const region = settingsState.region;
  const tabs = visibleSettingsTabs();
  if (!tabs.some(x => x.key === settingsState.tab)) settingsState.tab = tabs.length ? tabs[0].key : 'roles';
  const groups = SETTINGS_GROUPS.map(g => ({ g, items: tabs.filter(x => x.group === g) })).filter(x => x.items.length);
  openModal(`
    <div class="modal-head">
      <div class="ws-head">
        ${isSuper ? `<button type="button" class="btn btn-ghost btn-sm ws-back" id="wsBack">← ${esc(t('Regions'))}</button>` : ''}
        <h2>${esc(t('Settings'))}${region ? ` <span class="ws-region">${esc(region)}</span>` : ''}</h2>
      </div>
      <div style="display:flex;gap:8px;align-items:center"><button class="x-btn">×</button></div>
    </div>
    <div class="modal-body ws-body">
      <nav class="ws-nav" id="settingsTabs" aria-label="${esc(t('Settings'))}">
        ${groups.map(({ g, items }) => `
          <div class="ws-nav-group">
            <div class="ws-nav-label">${esc(t(g))}</div>
            ${items.map(tab => `<button type="button" class="ws-nav-item" data-tab="${tab.key}">${esc(t(tab.label))}</button>`).join('')}
          </div>`).join('')}
      </nav>
      <section class="ws-main">
        <header class="ws-page-head">
          <div class="ws-page-text"><h3 id="wsTitle"></h3><p id="wsDesc" class="clamp-desc"></p></div>
          <div class="ws-page-acts" id="wsActs"></div>
        </header>
        <div id="settingsPanel"></div>
      </section>
    </div>`);
  $('#modal').classList.remove('modal-wide');
  $('#modal').classList.add('modal-xwide', 'modal-flex', 'modal-ws');
  $('#modal .x-btn').addEventListener('click', closeModal);
  const back = $('#wsBack');
  if (back) back.addEventListener('click', () => { settingsState.region = null; openRegionsLanding(); });
  $$('#settingsTabs .ws-nav-item').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tab === settingsState.tab) return;
    settingsState.tab = b.dataset.tab;
    showWorkspacePage();
  }));
  showWorkspacePage();
}

// Mark the active menu item, fill the page header and render the page. Pages
// put their main button in the header through setWsPage().
function showWorkspacePage() {
  const tab = SETTINGS_TABS.find(x => x.key === settingsState.tab);
  $$('#settingsTabs .ws-nav-item').forEach(b => {
    const on = b.dataset.tab === settingsState.tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const active = $('#settingsTabs .ws-nav-item.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#wsTitle').textContent = tab ? t(tab.label) : '';
  setWsPage({ desc: tab && tab.desc ? t(tab.desc, { region: settingsState.region || t('this region') }) : '' });
  renderSettingsTab();
}
function setWsPage({ desc, actions } = {}) {
  const d = $('#wsDesc'), a = $('#wsActs');
  if (d && desc !== undefined) { d.textContent = desc; d.hidden = !desc; d.classList.remove('open'); }
  if (a) a.innerHTML = actions || '';
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
  if (settingsState.tab === 'meal-gps') return renderMealGpsTab();
  if (settingsState.tab === 'bases') return renderBasesTab();
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
// Editor for the region's two date rules — a rolling limit (N days back from
// today) and a fixed cutoff date. Either, both or neither may be on; the later
// floor wins. A summary shows what is claimable today under the pending
// settings, and before saving it spells out which dates the change blocks or
// reopens. Mirrors lib/claim-window.js claimEarliestFrom.
async function renderClaimWindowTab() {
  const panel = $('#settingsPanel');
  // Scoped to the workspace region. This is a separate context from the logged-in
  // user's own claim limit (state.claimLimit, set by loadLookups), so it must not
  // overwrite it.
  const region = settingsState.region || '';
  const regionQS = region ? `?region=${encodeURIComponent(region)}` : '';
  let cw;
  try { cw = await api('/claim-window' + regionQS); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const today = cw.latest;
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
  const floorOf = (p) => {
    const bounds = [];
    if (p.daysOn && p.days > 0) bounds.push(addDays(today, -p.days));
    if (p.dateOn && p.date) bounds.push(p.date);
    return bounds.length ? bounds.reduce((a, b) => (a > b ? a : b)) : null;
  };
  const saved = { daysOn: cw.max_age_days != null, days: cw.max_age_days || 0, dateOn: !!cw.earliest_date, date: cw.earliest_date || '' };
  const savedFloor = floorOf(saved);
  const monthStart = today.slice(0, 8) + '01', yearStart = today.slice(0, 5) + '01-01';

  panel.innerHTML = `
    <div class="settings-controls ws-card cw-card">
      <div class="cw-now" id="cwNow"></div>
      <div class="cw-rule" id="cwDaysRule">
        <label class="cw-switch"><input type="checkbox" id="cwDaysOn" ${saved.daysOn ? 'checked' : ''} />
          <span><b>${esc(t('Rolling limit'))}</b><small>${esc(t('Expenses older than a set number of days can’t be claimed.'))}</small></span></label>
        <div class="cw-body">
          <div class="cw-days"><input id="cwDays" class="input" type="number" min="1" max="3650" inputmode="numeric"
            value="${saved.days || 60}" aria-label="${esc(t('Maximum age (days)'))}" /><span>${esc(t('days'))}</span></div>
          <div class="cw-presets">${[30, 60, 90, 180].map(n => `<button type="button" class="cw-preset" data-days="${n}">${esc(t('{n} days', { n }))}</button>`).join('')}</div>
        </div>
      </div>
      <div class="cw-rule" id="cwDateRule">
        <label class="cw-switch"><input type="checkbox" id="cwDateOn" ${saved.dateOn ? 'checked' : ''} />
          <span><b>${esc(t('Fixed cutoff date'))}</b><small>${esc(t('Nothing dated before this day can be claimed — for example after the books are closed.'))}</small></span></label>
        <div class="cw-body">
          <input id="cwDate" class="input cw-date" type="date" max="${esc(today)}" value="${esc(saved.date || monthStart)}" aria-label="${esc(t('Earliest allowed expense date'))}" />
          <div class="cw-presets">
            <button type="button" class="cw-preset" data-date="${monthStart}">${esc(t('Start of this month'))}</button>
            <button type="button" class="cw-preset" data-date="${yearStart}">${esc(t('Start of this year'))}</button>
          </div>
        </div>
      </div>
      <div class="cw-impact" id="cwImpact" hidden></div>
      <p class="mr-hint">${esc(t('No expense can be dated after today. A returned claim is judged by the window it was first submitted into.'))}</p>
      <p class="form-error" id="cwErr" hidden></p>
      <div class="ws-card-foot mr-foot">
        <span class="mr-dirty" id="cwDirty" hidden>${esc(t('Unsaved changes'))}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="cwDiscard" hidden>${esc(t('Discard'))}</button>
        <button type="button" class="btn btn-primary btn-sm" id="cwSave" disabled>${esc(t('Save'))}</button>
      </div>
    </div>`;

  const read = () => ({
    daysOn: $('#cwDaysOn').checked, days: parseInt($('#cwDays').value, 10) || 0,
    dateOn: $('#cwDateOn').checked, date: $('#cwDate').value || ''
  });
  // What would be wrong with the pending settings, or '' when they can be saved.
  const problem = (p) => {
    if (p.daysOn && !(p.days >= 1 && p.days <= 3650)) return t('Enter a number of days between 1 and 3650.');
    if (p.dateOn && !p.date) return t('Choose a cutoff date.');
    if (p.dateOn && p.date > today) return t('The cutoff can’t be in the future — nothing could be claimed until then.');
    return '';
  };
  const range = (a, b) => (a === b ? a : `${a} – ${b}`);
  const paint = () => {
    const p = read();
    $('#cwDaysRule').classList.toggle('off', !p.daysOn);
    $('#cwDateRule').classList.toggle('off', !p.dateOn);
    $('#cwDays').disabled = !p.daysOn; $('#cwDate').disabled = !p.dateOn;
    $$('#cwDaysRule [data-days]').forEach(b => { b.disabled = !p.daysOn; b.classList.toggle('on', p.daysOn && +b.dataset.days === p.days); });
    $$('#cwDateRule [data-date]').forEach(b => { b.disabled = !p.dateOn; b.classList.toggle('on', p.dateOn && b.dataset.date === p.date); });
    const bad = problem(p);
    const dirty = p.daysOn !== saved.daysOn || p.dateOn !== saved.dateOn
      || (p.daysOn && p.days !== saved.days) || (p.dateOn && p.date !== saved.date);
    const floor = bad ? savedFloor : floorOf(p);
    // Summary: the claimable range today under the pending settings.
    const byDays = p.daysOn && p.days > 0 ? addDays(today, -p.days) : null;
    const source = !floor ? '' : (byDays === floor ? t('Set by the {n}-day limit', { n: p.days }) : t('Set by the cutoff date'));
    $('#cwNow').innerHTML = `
      <div class="cw-now-label">${esc(dirty && !bad ? t('Claimable today, after saving') : t('Claimable today'))}</div>
      <div class="cw-range">${floor ? `<strong>${esc(floor)}</strong><span aria-hidden="true">→</span><strong>${esc(today)}</strong>`
        : `<strong>${esc(t('Any date up to {date}', { date: today }))}</strong>`}</div>
      <div class="cw-now-sub">${esc([floor ? t('{n} days', { n: daysBetween(floor, today) + 1 }) : t('No limit'), source,
        cw.timezone ? t('today in {zone}', { zone: cw.timezone }) : ''].filter(Boolean).join(' · '))}</div>`;
    // Impact of the change against what is saved now.
    const imp = $('#cwImpact');
    let msg = '', kind = '';
    if (dirty && !bad && floor !== savedFloor) {
      if (floor && (!savedFloor || floor > savedFloor)) {
        kind = 'block';
        msg = savedFloor ? t('Saving blocks expenses dated {range}.', { range: range(savedFloor, addDays(floor, -1)) })
          : t('Saving blocks every expense dated before {date}.', { date: floor });
      } else {
        kind = 'open';
        msg = floor ? t('Saving reopens expenses dated {range}.', { range: range(floor, addDays(savedFloor, -1)) })
          : t('Saving removes the limit — expenses of any date become claimable.');
      }
    }
    imp.hidden = !msg; imp.className = 'cw-impact ' + kind; imp.textContent = msg;
    const err = $('#cwErr'); err.textContent = bad; err.hidden = !bad || !dirty;
    $('#cwDirty').hidden = !dirty; $('#cwDiscard').hidden = !dirty;
    $('#cwSave').disabled = !dirty || !!bad;
  };
  ['#cwDaysOn', '#cwDateOn'].forEach(s => $(s).addEventListener('change', paint));
  $('#cwDays').addEventListener('input', paint);
  $('#cwDate').addEventListener('input', paint);
  $('#cwDate').addEventListener('change', paint);
  $$('#settingsPanel [data-days]').forEach(b => b.addEventListener('click', () => { $('#cwDays').value = b.dataset.days; paint(); }));
  $$('#settingsPanel [data-date]').forEach(b => b.addEventListener('click', () => { $('#cwDate').value = b.dataset.date; paint(); }));
  $('#cwDiscard').addEventListener('click', () => renderClaimWindowTab());
  $('#cwSave').addEventListener('click', async () => {
    const p = read();
    const btn = $('#cwSave'); btn.disabled = true;
    try {
      await api('/claim-window', { method: 'PUT', body: JSON.stringify({
        max_age_days: p.daysOn ? p.days : '', earliest_date: p.dateOn ? p.date : '',
        ...(region ? { region } : {})
      }) });
      toast(t('Claim date limit saved'));
      renderClaimWindowTab();
    } catch (ex) { const err = $('#cwErr'); err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
  paint();
}

// --- Meal allowance rates (per-region dropdown presets) ----------------------
// Editor for the preset amounts the Meal Allowance form's Amount dropdown offers,
// scoped to the workspace region; saved via PUT /api/meal-rates (manage_settings).
// Each row shows how often that amount was claimed; a live preview shows what
// claimants will pick from (lowest first, which is also how it is saved).
async function renderMealRatesTab() {
  const panel = $('#settingsPanel');
  const region = settingsState.region || '';
  const regionQS = region ? `?region=${encodeURIComponent(region)}&manage=1` : '?manage=1';
  let data;
  try { data = await api('/meal-rates' + regionQS); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const cur = data.currency || '';
  const max = data.max || 20;
  const usage = new Map((data.usage || []).map(u => [Math.round(u.amount), u]));
  const saved = (data.rates || []).slice();
  let rows = saved.length ? saved.slice() : [0];
  const money = (n) => `${cur ? cur + ' ' : ''}${groupAmount(String(n))}`;
  const usageText = (n) => {
    const u = n > 0 && usage.get(n);
    if (!n) return '';
    if (!u || !u.uses) return `<span class="mr-use none">${esc(t('Not claimed yet'))}</span>`;
    return `<span class="mr-use">${esc(t(u.uses === 1 ? 'Claimed once' : 'Claimed {n} times', { n: u.uses })
      + (u.last_used ? ' · ' + t('last {date}', { date: u.last_used }) : ''))}</span>`;
  };
  const clean = (list) => [...new Set(list.filter(n => n > 0))].sort((a, b) => a - b);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  panel.innerHTML = `
    <div class="settings-controls ws-card mr-card">
      ${data.isDefault ? `<div class="mr-note">${esc(t('{region} is using the built-in default amounts. Save to make this list the region’s own.', { region: region || t('This region') }))}</div>` : ''}
      <div class="ws-card-label mr-head"><span>${esc(t('Amounts'))}</span><span class="mr-count" id="mrCount"></span></div>
      <div id="mrRows" class="mr-rows"></div>
      <div class="mr-add">
        <button type="button" class="btn btn-brand-soft btn-sm" id="mrAddRow">${esc(t('+ Add amount'))}</button>
        <span class="mr-max" id="mrMax" hidden>${esc(t('Up to {n} amounts', { n: max }))}</span>
      </div>
      <div class="ws-card-label ws-card-split">${esc(t('Claimants choose from'))}</div>
      <div class="mr-preview" id="mrPreview"></div>
      <p class="mr-hint">${esc(t('Shown lowest first. Claims already filed keep their amount.'))}</p>
      <p class="mr-other" id="mrOther" hidden></p>
      <p class="form-error" id="mrErr" hidden></p>
      <div class="ws-card-foot mr-foot">
        <span class="mr-dirty" id="mrDirty" hidden>${esc(t('Unsaved changes'))}</span>
        <button type="button" class="btn btn-ghost btn-sm" id="mrDiscard" hidden>${esc(t('Discard'))}</button>
        <button type="button" class="btn btn-primary btn-sm" id="mrSave" disabled>${esc(t('Save'))}</button>
      </div>
    </div>`;

  const read = () => { rows = $$('#mrRows .mr-amt').map(inp => mealAmount(inp.value)); };
  // Everything that depends on the current rows: duplicates, usage, preview,
  // counter, the "other amounts on filed claims" line and the Save state.
  const paint = () => {
    const seen = new Map();
    rows.forEach((n, i) => { if (n > 0) seen.set(n, (seen.get(n) || 0) + 1); });
    $$('#mrRows .mr-row').forEach((row, i) => {
      const n = rows[i];
      const dup = n > 0 && seen.get(n) > 1;
      row.classList.toggle('mr-dup', dup);
      row.querySelector('.mr-meta').innerHTML = dup ? `<span class="mr-dup-msg">${esc(t('Listed twice'))}</span>` : usageText(n);
    });
    const list = clean(rows);
    $('#mrPreview').innerHTML = list.length
      ? list.map(n => `<span class="mr-chip">${esc(money(n))}</span>`).join('')
      : `<span class="mr-empty">${esc(t('No amounts — nobody in {region} can claim a meal allowance.', { region: region || t('this region') }))}</span>`;
    $('#mrCount').textContent = t('{n} of {m}', { n: rows.filter(n => n > 0).length, m: max });
    const full = rows.length >= max;
    $('#mrAddRow').disabled = full; $('#mrMax').hidden = !full;
    const others = [...usage.values()].filter(u => u.uses && !list.includes(Math.round(u.amount)))
      .sort((a, b) => b.uses - a.uses).slice(0, 6);
    const other = $('#mrOther');
    other.hidden = !others.length;
    other.textContent = others.length ? t('Also on filed claims: {list}', { list: others.map(u => `${money(Math.round(u.amount))} (${u.uses}×)`).join(', ') }) : '';
    const dirty = !same(list, clean(saved));
    const dups = [...seen.values()].some(c => c > 1);
    const note = $('#mrDirty');
    note.hidden = !dirty && !dups;
    note.textContent = dups ? t('Remove the duplicate to save') : t('Unsaved changes');
    $('#mrDiscard').hidden = !dirty && !dups;
    $('#mrSave').disabled = !(dirty || data.isDefault) || dups;
  };
  const drawRows = (focusIdx) => {
    $('#mrRows').innerHTML = rows.map((n, i) => `
      <div class="mr-row">
        <div class="mr-field">${cur ? `<span class="mr-cur">${esc(cur)}</span>` : ''}
          <input class="input mr-amt" inputmode="numeric" autocomplete="off" value="${n ? esc(groupAmount(String(n))) : ''}" placeholder="0"
            aria-label="${esc(t('Amount {n}', { n: i + 1 }))}" /></div>
        <div class="mr-meta"></div>
        <button type="button" class="x-btn mr-rm" data-rm="${i}" aria-label="${esc(t('Remove'))}" title="${esc(t('Remove'))}">×</button>
      </div>`).join('');
    $$('#mrRows .mr-amt').forEach((inp, i) => {
      inp.addEventListener('input', () => { inp.value = groupAmount(inp.value.replace(/\./g, '')); read(); paint(); });
      // Enter moves on to the next amount, adding a row at the end.
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault(); read();
        if (i === rows.length - 1) { if (rows.length < max) { rows.push(0); drawRows(rows.length - 1); } }
        else $$('#mrRows .mr-amt')[i + 1].focus();
      });
    });
    $$('#mrRows [data-rm]').forEach(b => b.addEventListener('click', () => {
      read(); rows.splice(+b.dataset.rm, 1); if (!rows.length) rows.push(0);
      drawRows(Math.min(+b.dataset.rm, rows.length - 1));
    }));
    paint();
    if (focusIdx != null) { const f = $$('#mrRows .mr-amt')[focusIdx]; if (f) f.focus(); }
  };
  drawRows();
  $('#mrAddRow').addEventListener('click', () => { read(); if (rows.length < max) { rows.push(0); drawRows(rows.length - 1); } });
  $('#mrDiscard').addEventListener('click', () => { rows = saved.length ? saved.slice() : [0]; $('#mrErr').hidden = true; drawRows(); });
  $('#mrSave').addEventListener('click', async () => {
    const err = $('#mrErr'); err.hidden = true;
    read();
    const rates = clean(rows);
    const removedInUse = clean(saved).filter(n => !rates.includes(n) && usage.get(n) && usage.get(n).uses);
    const btn = $('#mrSave'); btn.disabled = true;
    try {
      const res = await api('/meal-rates', { method: 'PUT', body: JSON.stringify({ rates, ...(region ? { region } : {}) }) });
      // If this is the signed-in user's own region, refresh the presets the meal
      // form uses so a new claim reflects the change without a reload.
      if (!region || region === state.user.region) state.mealRates = res.rates || [];
      toast(removedInUse.length ? t('Saved. Removed amounts stay on claims already filed.') : t('Meal allowance amounts saved'));
      renderMealRatesTab();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; paint(); }
  });
}

// --- GPS meal allowance (per-region on/off) -------------------------------------
// One switch per region, saved via PUT /api/meal-gps-settings (manage_settings).
// The page also shows the fixed rules and how many of the region's accounts
// already have a base — an account without one can't submit.
async function renderMealGpsTab() {
  const panel = $('#settingsPanel');
  const region = settingsState.region || '';
  let data;
  try { data = await api('/meal-gps-settings' + (region ? `?region=${encodeURIComponent(region)}` : '')); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const r = data.rules || {};
  const cur = data.currency || regionCurrency();
  const where = region || t('this region');
  const missing = Math.max(0, (data.accounts || 0) - (data.with_base || 0));
  panel.innerHTML = `
    <div class="settings-controls ws-card cw-card mgs-card">
      <div class="cw-now mgs-now ${data.enabled ? 'on' : 'off'}">
        <div class="cw-now-label">${esc(data.enabled ? t('On') : t('Off'))}</div>
        <div class="mgs-now-txt">${esc(data.enabled
          ? t('Employees in {region} whose department and job position allow the meal allowance see “New meal allowance (GPS)” in the New menu.', { region: where })
          : t('Nobody in {region} sees the GPS meal allowance. The standard meal allowance is not affected.', { region: where }))}</div>
      </div>
      <div class="cw-rule">
        <label class="cw-switch"><input type="checkbox" id="mgsOn" ${data.enabled ? 'checked' : ''} />
          <span><b>${esc(t('Offer the GPS meal allowance in {region}', { region: where }))}</b>
          <small>${esc(t('Days from {date} can be claimed. Claims already submitted carry on through approval and payment whichever way this is set.', { date: r.effectiveFrom || '2026-11-01' }))}</small></span></label>
      </div>
      <div class="cw-rule">
        <div class="ws-card-label">${esc(t('Rules'))}</div>
        ${radiusNoteHtml(r.minKm)}
        <ul class="mgs-rules">
          <li>${withRadius(t('In town, within {min} km {radius}: not claimable', { min: r.minKm }))}</li>
          <li>${withRadius(t('In town, {min} km {radius} or more: up to {cap} a day', { min: r.minKm, cap: money((r.inTownCapCents || 0) / 100, cur) }))}</li>
          <li>${esc(t('Out of town: up to {n} meals, {cap} a day', { n: r.maxMeals, cap: money((r.outOfTownCapCents || 0) / 100, cur) }))}</li>
          <li>${esc(t('Every day needs the claimant’s location and its receipt'))}</li>
          <li>${esc(t('The Manager or Finance AP may lower a day’s approved amount, never above what was claimed'))}</li>
        </ul>
      </div>
      <div class="cw-rule">
        <div class="ws-card-label">${esc(t('Bases'))}</div>
        <p class="mgs-bases ${missing ? 'warn' : ''}">${esc(missing
          ? t('{n} of {m} active accounts in {region} have no base location yet — they can’t submit until one is set.', { n: missing, m: data.accounts || 0, region: where })
          : t('Every active account in {region} has a base location.', { region: where }))}</p>
        <button type="button" class="btn btn-ghost btn-sm" id="mgsAccounts">${esc(t('Manage bases'))}</button>
      </div>
      <p class="form-error" id="mgsErr" hidden></p>
    </div>`;
  const acc = $('#mgsAccounts');
  if (acc) acc.addEventListener('click', () => { const b = $('#settingsTabs [data-tab="bases"]'); if (b) b.click(); });
  $('#mgsOn').addEventListener('change', async (e) => {
    const box = e.target;
    box.disabled = true;
    try {
      await api('/meal-gps-settings', { method: 'PUT', body: JSON.stringify({ enabled: box.checked, ...(region ? { region } : {}) }) });
      toast(box.checked ? t('GPS meal allowance switched on for {region}', { region: where }) : t('GPS meal allowance switched off for {region}', { region: where }));
      // The signed-in account's own menu follows a change to its own region.
      if (!region || region === state.user.region) {
        try { const me = await api('/me'); state.user = { ...state.user, meal_gps: me.user.meal_gps }; showMealGpsItem(); } catch { /* next sign-in picks it up */ }
      }
      renderMealGpsTab();
    } catch (ex) { box.checked = !box.checked; box.disabled = false; const err = $('#mgsErr'); err.textContent = ex.message; err.hidden = false; }
  });
}

// --- Bases (per region) -----------------------------------------------------------
// The places the region's accounts work from. Each row can be renamed / moved
// (accounts on it follow), deleted once empty, and given its accounts through a
// checklist, so a base is set for many people at once instead of one account
// editor at a time.
const coordsReadHtml = (v) => {
  const s = String(v || '').trim();
  const ll = parseCoordsText(s);
  if (!s) return esc(t('Paste "latitude, longitude" or a Google Maps link from the address bar.'));
  if (ll) return `${esc(t('Reads as {lat}, {lng}', { lat: ll.lat, lng: ll.lng }))} · <a href="https://www.google.com/maps?q=${encodeURIComponent(ll.lat + ',' + ll.lng)}" target="_blank" rel="noopener">${esc(t('Open in Maps'))}</a>`;
  return esc(/goo\.gl|maps\.app/i.test(s)
    ? t('Short share links don’t carry coordinates — open the link, then copy the full address-bar link or right-click the spot to copy its coordinates.')
    : t('Can’t read coordinates from this — use "latitude, longitude", e.g. -6.2088, 106.8456.'));
};
// A name + coordinates pair with its live "reads as" line; `id` prefixes the fields.
const baseFieldsHtml = (id, name, coords) => `
  <label class="bs-field">${esc(t('Base name'))}<input class="input" id="${id}Name" maxlength="120" value="${esc(name)}" placeholder="${esc(t('e.g. Jakarta office'))}" /></label>
  <label class="bs-field">${esc(t('Coordinates or Google Maps link'))}<input class="input" id="${id}Coords" autocomplete="off" value="${esc(coords)}" placeholder="-6.2088, 106.8456" /></label>
  <p class="bs-read" id="${id}Read">${coordsReadHtml(coords)}</p>`;
function wireCoordsRead(id) {
  const inp = $(`#${id}Coords`), out = $(`#${id}Read`);
  const paint = () => { out.innerHTML = coordsReadHtml(inp.value); out.classList.toggle('bad', !!inp.value.trim() && !parseCoordsText(inp.value)); };
  inp.addEventListener('input', paint); paint();
}

async function renderBasesTab(editingId = null) {
  const panel = $('#settingsPanel');
  const region = settingsState.region || '';
  let data;
  try { data = await api('/bases?manage=1' + (region ? `&region=${encodeURIComponent(region)}` : '')); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const where = region || t('this region');
  const accounts = data.accounts || [];
  const without = accounts.filter(a => a.base_id == null && a.custom_base == null).length;
  const custom = accounts.filter(a => a.custom_base != null).length;
  const bases = data.bases || [];
  const minKm = data.min_km || 30;
  const row = (b) => b.id === editingId ? `
      <div class="bs-row bs-editing" data-id="${b.id}">
        <div class="bs-edit">${baseFieldsHtml('bsEdit', b.name, `${b.lat}, ${b.lng}`)}</div>
        <div class="bs-acts">
          <button type="button" class="btn btn-ghost btn-sm" data-cancel>${esc(t('Cancel'))}</button>
          <button type="button" class="btn btn-primary btn-sm" data-save="${b.id}">${esc(t('Save'))}</button>
        </div>
        ${b.members ? `<p class="bs-note">${esc(t('The {n} account(s) on this base move with it.', { n: b.members }))}</p>` : ''}
      </div>` : `
      <div class="bs-row" data-id="${b.id}">
        <span class="bs-ic" aria-hidden="true">🏢</span>
        <div class="bs-main"><button type="button" class="bs-name" data-focus="${b.id}" title="${esc(t('Show on the map'))}">${esc(b.name)}</button>
          <span>${esc(`${b.lat}, ${b.lng}`)} · <a href="https://www.google.com/maps?q=${encodeURIComponent(b.lat + ',' + b.lng)}" target="_blank" rel="noopener">${esc(t('Open in Maps'))}</a></span></div>
        <button type="button" class="bs-count" data-members="${b.id}">${esc(b.members === 1 ? t('1 account') : t('{n} accounts', { n: b.members }))}</button>
        <div class="bs-acts">
          <button type="button" class="btn btn-brand-soft btn-sm" data-members="${b.id}">${esc(t('Choose accounts'))}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-edit="${b.id}">${esc(t('Edit'))}</button>
          <button type="button" class="x-btn" data-del="${b.id}" aria-label="${esc(t('Delete'))}" title="${esc(t('Delete'))}">×</button>
        </div>
      </div>`;
  panel.innerHTML = `
    <div class="settings-controls ws-card bs-card">
      <p class="bs-summary ${without ? 'warn' : ''}">${esc(without
        ? t('{n} of {m} active accounts in {region} have no base yet.', { n: without, m: accounts.length, region: where })
        : t('Every active account in {region} has a base.', { region: where }))}${custom ? ' ' + esc(t('{n} account(s) use a location typed into the account instead of a base from this list.', { n: custom })) : ''}</p>
      <div class="bs-map-wrap">
        <div class="bs-map" id="bsMap"><p class="bs-map-msg">${esc(t('Loading map…'))}</p></div>
        <p class="bs-map-key"><span class="bs-map-ring" aria-hidden="true"></span>${esc(t('Each ring is the {km} km straight-line radius around a base — in-town meals inside it can’t be claimed.', { km: minKm }))}
          <span class="bs-map-tip">${esc(editingId != null ? t('Click the map to move this base there.') : t('Click the map to fill in a new base’s location.'))}</span></p>
      </div>
      <div class="bs-list">${bases.length ? bases.map(row).join('') : `<p class="bs-empty">${esc(t('No bases in {region} yet — add the first one below.', { region: where }))}</p>`}</div>
      <div class="ws-card-label ws-card-split">${esc(t('Add a base'))}</div>
      <div class="bs-add">${baseFieldsHtml('bsNew', '', '')}
        <button type="button" class="btn btn-primary btn-sm" id="bsAdd">${esc(t('Add base'))}</button></div>
      <p class="form-error" id="bsErr" hidden></p>
    </div>`;
  const fail = (ex) => { const e = $('#bsErr'); e.textContent = ex.message; e.hidden = false; };
  wireCoordsRead('bsNew');
  if (editingId != null && $('#bsEditCoords')) { wireCoordsRead('bsEdit'); $('#bsEditName').focus(); }
  $('#bsAdd').addEventListener('click', async () => {
    try {
      await api('/bases', { method: 'POST', body: JSON.stringify({ name: $('#bsNewName').value, coords: $('#bsNewCoords').value, ...(region ? { region } : {}) }) });
      toast(t('Base added')); renderBasesTab();
    } catch (ex) { fail(ex); }
  });
  panel.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => renderBasesTab(Number(b.dataset.edit))));
  panel.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => renderBasesTab()));
  panel.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api('/bases/' + b.dataset.save, { method: 'PUT', body: JSON.stringify({ name: $('#bsEditName').value, coords: $('#bsEditCoords').value }) });
      toast(t('Base saved')); renderBasesTab();
    } catch (ex) { fail(ex); }
  }));
  panel.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const base = bases.find(x => x.id === Number(b.dataset.del));
    if (!confirm(t('Delete {name}?', { name: base.name }))) return;
    try { await api('/bases/' + base.id, { method: 'DELETE' }); toast(t('Base deleted')); renderBasesTab(); }
    catch (ex) { fail(ex); }
  }));
  panel.querySelectorAll('[data-members]').forEach(b => b.addEventListener('click', () =>
    openBaseAccountsModal(bases.find(x => x.id === Number(b.dataset.members)), bases, accounts)));
  drawBasesMap(bases, minKm, editingId);
}

// --- Bases map ---------------------------------------------------------------------
// Leaflet (vendored, loaded on first use) over OpenStreetMap tiles: every base
// with its minimum-distance ring, a dashed ring previewing the coordinates being
// typed into the add / edit form, and a click on the map fills that form in.
let _leafletPromise;
function loadLeaflet() {
  if (!_leafletPromise) _leafletPromise = new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'vendor/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = () => { _leafletPromise = null; reject(new Error('Could not load the map')); };
    document.head.appendChild(s);
  });
  return _leafletPromise;
}

async function drawBasesMap(bases, km, editingId) {
  const el = $('#bsMap');
  if (!el) return;
  let L;
  try { L = await loadLeaflet(); }
  catch { el.innerHTML = `<p class="bs-map-msg">${esc(t('The map couldn’t load. Check your connection and open this tab again.'))}</p>`; return; }
  if (!el.isConnected) return; // the tab was re-rendered while the map loaded
  el.innerHTML = '';
  const css = getComputedStyle(document.documentElement);
  const brand = css.getPropertyValue('--pine').trim() || '#f7982a';
  const deep = css.getPropertyValue('--pine-deep').trim() || '#ad5300';
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.5 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  // Wheel zoom only once the map is clicked, so scrolling the page never gets stuck on it.
  map.on('click', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());

  const rings = new Map();
  for (const b of bases) {
    const editing = b.id === editingId;
    const ring = L.circle([b.lat, b.lng], { radius: km * 1000, color: brand, weight: 2, opacity: editing ? 0.35 : 0.9, fillColor: brand, fillOpacity: editing ? 0.04 : 0.12, interactive: false }).addTo(map);
    const dot = L.circleMarker([b.lat, b.lng], { radius: 6, color: '#fff', weight: 2, fillColor: deep, fillOpacity: 1 }).addTo(map);
    dot.bindTooltip(esc(b.name), { permanent: true, direction: 'top', offset: [0, -8], className: 'bs-map-label' });
    dot.bindPopup(`<b>${esc(b.name)}</b><br>${esc(b.members === 1 ? t('1 account') : t('{n} accounts', { n: b.members || 0 }))}<br><span class="bs-map-ll">${esc(`${b.lat}, ${b.lng}`)}</span>`);
    rings.set(b.id, { ring, dot, area: L.latLng(b.lat, b.lng).toBounds(km * 2000) });
  }
  // Circle bounds need a map view, so frame each ring from its centre instead.
  const all = [...rings.values()].map(r => r.area);
  if (all.length) map.fitBounds(all.reduce((acc, bd) => acc.extend(bd), L.latLngBounds(all[0].getSouthWest(), all[0].getNorthEast())), { padding: [24, 24], maxZoom: 11 });
  else map.setView([5, 112], 4); // nothing yet: the whole of South-East Asia

  // The dashed preview ring follows the add (or edit) form's coordinates.
  const id = editingId != null && $('#bsEditCoords') ? 'bsEdit' : 'bsNew';
  const inp = $(`#${id}Coords`);
  let draft = null;
  const paintDraft = (pan) => {
    const ll = inp && parseCoordsText(inp.value);
    if (!ll) { if (draft) { draft.remove(); draft = null; } return; }
    if (!draft) draft = L.circle([ll.lat, ll.lng], { radius: km * 1000, color: deep, weight: 2, dashArray: '6 6', fillColor: deep, fillOpacity: 0.08, interactive: false }).addTo(map);
    else draft.setLatLng([ll.lat, ll.lng]);
    const area = L.latLng(ll.lat, ll.lng).toBounds(km * 2000);
    if (pan && !map.getBounds().contains(area)) map.flyToBounds(area, { padding: [24, 24], duration: 0.6 });
  };
  if (inp) {
    inp.addEventListener('input', () => paintDraft(true));
    paintDraft(id === 'bsEdit');
    map.on('click', (e) => {
      inp.value = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
      inp.dispatchEvent(new Event('input'));
      const name = $(`#${id}Name`);
      if (name && !name.value.trim()) name.focus({ preventScroll: true });
    });
  }
  $$('#settingsPanel [data-focus]').forEach(b => b.addEventListener('click', () => {
    const r = rings.get(Number(b.dataset.focus));
    if (!r) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    map.flyToBounds(r.area, { padding: [24, 24], duration: 0.6 });
    r.dot.openPopup();
  }));
}

// The checklist of the region's active accounts for one base. Ticked = on this
// base; ticking someone on another base moves them here when saved.
function openBaseAccountsModal(base, bases, accounts) {
  const names = new Map(bases.map(b => [b.id, b.name]));
  const picked = new Set(accounts.filter(a => a.base_id === base.id).map(a => a.id));
  let filter = 'all';
  const where = (a) => a.base_id === base.id ? '' : a.base_id != null ? t('On {base}', { base: names.get(a.base_id) || t('another base') })
    : a.custom_base != null ? t('Typed location: {name}', { name: a.custom_base || '—' }) : t('No base');
  openModal2(`
    <div class="modal-head"><div><h2>${esc(t('Accounts on {base}', { base: base.name }))}</h2>
      <div class="lf-sub"><span>${esc(base.region)}</span></div></div>
      <button type="button" class="x-btn" id="baClose">×</button></div>
    <div class="modal-body ba-body">
      <div class="ba-tools">
        <input class="input" id="baSearch" type="search" placeholder="${esc(t('Search name, department or position…'))}" />
        <div class="ws-chips ba-chips">
          <button type="button" class="ws-chip on" data-f="all">${esc(t('All'))}</button>
          <button type="button" class="ws-chip" data-f="none">${esc(t('No base'))}</button>
          <button type="button" class="ws-chip" data-f="here">${esc(t('On this base'))}</button>
        </div>
      </div>
      <div class="ba-list" id="baList"></div>
      <div class="modal-actions ba-foot">
        <span class="ba-count" id="baCount"></span>
        <button type="button" class="btn btn-ghost" id="baCancel">${esc(t('Cancel'))}</button>
        <button type="button" class="btn btn-primary" id="baSave">${esc(t('Save'))}</button>
      </div>
    </div>`);
  $('#modal2').classList.add('modal-wide', 'modal-flex');
  const paint = () => {
    const qy = $('#baSearch').value.trim().toLowerCase();
    const shown = accounts.filter(a => (filter === 'all' || (filter === 'here' ? picked.has(a.id) : a.base_id == null && a.custom_base == null))
      && (!qy || `${a.name} ${a.department} ${a.position}`.toLowerCase().includes(qy)));
    $('#baList').innerHTML = shown.length ? shown.map(a => `
      <label class="ba-row"><input type="checkbox" data-u="${a.id}" ${picked.has(a.id) ? 'checked' : ''} />
        <span class="ba-who"><b>${esc(a.name)}</b><small>${esc([a.department, a.position].filter(Boolean).join(' · '))}</small></span>
        <span class="ba-tag ${a.base_id == null && a.custom_base == null ? 'none' : ''}">${esc(picked.has(a.id) && a.base_id !== base.id ? t('Moves here') : where(a))}</span>
      </label>`).join('') : `<p class="bs-empty">${esc(t('No accounts match.'))}</p>`;
    $('#baCount').textContent = picked.size === 1 ? t('1 account on this base') : t('{n} accounts on this base', { n: picked.size });
    $$('#baList [data-u]').forEach(cb => cb.addEventListener('change', () => {
      const id = Number(cb.dataset.u); if (cb.checked) picked.add(id); else picked.delete(id); paint();
    }));
  };
  $('#baSearch').addEventListener('input', paint);
  $$('#modal2 .ba-chips [data-f]').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.f; $$('#modal2 .ba-chips [data-f]').forEach(x => x.classList.toggle('on', x === b)); paint();
  }));
  $('#baClose').addEventListener('click', closeModal2);
  $('#baCancel').addEventListener('click', closeModal2);
  $('#baSave').addEventListener('click', async () => {
    const btn = $('#baSave'); btn.disabled = true;
    try {
      await api(`/bases/${base.id}/accounts`, { method: 'PUT', body: JSON.stringify({ user_ids: [...picked] }) });
      closeModal2(); toast(t('Accounts on {base} saved', { base: base.name })); renderBasesTab();
    } catch (ex) { toast(ex.message, true); btn.disabled = false; }
  });
  paint();
  $('#baSearch').focus();
}

// --- Currency, time zone & bank (per-region defaults) --------------------------
// Country Managers / Managing Directors (their own region) and Super Admins (any
// region) set the region's default currency — stamped onto new claims — its time
// zone, which decides what counts as "today" for claim dates, and the preferred
// (no-fee) bank with the fee other banks pay. Saved via PUT /api/region-prefs.
// Each section shows what its setting means right now: open documents by
// currency, a live clock in the chosen zone, and the payout line employees see.
const CURRENCY_NAMES = {
  IDR: 'Indonesian rupiah', USD: 'US dollar', THB: 'Thai baht', VND: 'Vietnamese đồng',
  KHR: 'Cambodian riel', MYR: 'Malaysian ringgit', KRW: 'South Korean won'
};
let rpClockTimer = null;
async function renderRegionPrefsTab() {
  const panel = $('#settingsPanel');
  clearInterval(rpClockTimer);
  const region = settingsState.region || '';
  const regionQS = region ? `?region=${encodeURIComponent(region)}&manage=1` : '?manage=1';
  let data;
  try { data = await api('/region-prefs' + regionQS); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const saved = { currency: data.currency, timezone: data.timezone, bank: data.preferredBank || '', bankFee: data.bankFee != null ? Number(data.bankFee) : 0 };
  const open = data.openByCurrency || {};
  const where = region || t('this region');
  const curOpts = (data.currencies || []).map(c =>
    `<option value="${esc(c)}" ${c === saved.currency ? 'selected' : ''}>${esc(c)}${CURRENCY_NAMES[c] ? ` — ${esc(t(CURRENCY_NAMES[c]))}` : ''}</option>`).join('');
  const tzOpts = (data.timezones || []).map(z => {
    const off = tzOffsetLabel(z);
    return `<option value="${esc(z)}" ${z === saved.timezone ? 'selected' : ''}>${esc(z)}${off ? ` (${esc(off)})` : ''}</option>`;
  }).join('');
  // Date and time "now" in a zone, as YYYY-MM-DD and HH:MM.
  const nowIn = (tz) => {
    try {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
      return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    } catch { return null; }
  };

  panel.innerHTML = `
    <div class="settings-controls ws-card rp-card">
      <form id="rpForm" class="form" novalidate>
        <section class="rp-sec">
          <div class="rp-head"><b>${esc(t('Currency'))}</b><small>${esc(t('New claims, meal allowances and cash advances in {region} use this currency.', { region: where }))}</small></div>
          <select name="currency" aria-label="${esc(t('Default currency'))}">${curOpts}</select>
          <p class="rp-note" id="rpCurNote"></p>
        </section>
        <section class="rp-sec">
          <div class="rp-head"><b>${esc(t('Time zone'))}</b><small>${esc(t('Decides what counts as “today” for claim dates in {region}.', { region: where }))}</small></div>
          <select name="timezone" aria-label="${esc(t('Default time zone'))}">${tzOpts}</select>
          <p class="rp-note" id="rpClock"></p>
        </section>
        <section class="rp-sec">
          <div class="rp-head"><b>${esc(t('Bank payouts'))}</b><small>${esc(t('Payments to the preferred bank are free; all other banks are charged this fee. This shows on each employee’s profile.'))}</small></div>
          <div class="rp-bank">
            <label>${esc(t('Preferred bank (no transfer fee)'))}
              <input name="bank" value="${esc(saved.bank)}" placeholder="${esc(t('Enter your bank name'))}" maxlength="60" autocomplete="off" /></label>
            <label>${esc(t('Fee for payments to other banks'))}
              <div class="mr-field"><span class="mr-cur" id="rpFeeCur">${esc(saved.currency)}</span>
                <input name="bankFee" class="mr-amt" inputmode="numeric" autocomplete="off" value="${esc(groupAmount(String(saved.bankFee)))}" /></div></label>
          </div>
          <div class="rp-preview"><span class="rp-preview-label">${esc(t('Employees see'))}</span><span id="rpPayLine"></span></div>
        </section>
        <p class="form-error" id="rpErr" hidden></p>
        <div class="ws-card-foot mr-foot">
          <span class="mr-dirty" id="rpDirty" hidden>${esc(t('Unsaved changes'))}</span>
          <button type="button" class="btn btn-ghost btn-sm" id="rpDiscard" hidden>${esc(t('Discard'))}</button>
          <button type="submit" class="btn btn-primary btn-sm" id="rpSave" disabled>${esc(t('Save'))}</button>
        </div>
      </form>
    </div>`;

  const f = $('#rpForm');
  const read = () => ({ currency: f.currency.value, timezone: f.timezone.value, bank: f.bank.value.trim(), bankFee: mealAmount(f.bankFee.value) });
  const paintClock = () => {
    const el = $('#rpClock');
    if (!el) return clearInterval(rpClockTimer);
    const tz = f.timezone.value, now = nowIn(tz), was = nowIn(saved.timezone);
    if (!now) { el.textContent = ''; return; }
    let txt = t('Now in {zone}: {date} {time}', { zone: tz, date: now.date, time: now.time });
    if (tz !== saved.timezone && was && was.date !== now.date) {
      txt += ' — ' + t('“today” becomes {date} there; claim dates are checked against it.', { date: now.date });
    }
    el.textContent = txt;
    el.classList.toggle('warn', tz !== saved.timezone && !!was && was.date !== now.date);
  };
  const paint = () => {
    const p = read();
    $('#rpFeeCur').textContent = p.currency;
    // Currency: what is open now, and what a change leaves alone.
    const openList = Object.entries(open).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const openTxt = openList.map(([c, n]) => t('{n} in {cur}', { n, cur: c })).join(', ');
    const cn = $('#rpCurNote');
    if (p.currency !== saved.currency) {
      cn.textContent = openList.length
        ? t('Only new claims use {cur}. Open documents keep their own currency ({list}).', { cur: p.currency, list: openTxt })
        : t('Only new claims use {cur}; claims already filed keep their currency.', { cur: p.currency });
      cn.classList.add('warn');
    } else {
      cn.textContent = openList.length ? t('Open documents now: {list}.', { list: openTxt }) : t('No open documents right now.');
      cn.classList.remove('warn');
    }
    paintClock();
    // The line employees see on their profile.
    $('#rpPayLine').textContent = !p.bank ? '—'
      : p.bankFee > 0 ? t('Transfers to {bank} are free. Other banks: {fee} per payment.', { bank: p.bank, fee: `${p.currency} ${groupAmount(String(p.bankFee))}` })
      : t('Transfers to any bank are free.');
    const dirty = p.currency !== saved.currency || p.timezone !== saved.timezone || p.bank !== saved.bank || p.bankFee !== saved.bankFee;
    const bad = !p.bank ? t('Enter the preferred (no-fee) bank name') : '';
    const note = $('#rpDirty');
    note.hidden = !dirty; note.textContent = bad && dirty ? bad : t('Unsaved changes');
    $('#rpDiscard').hidden = !dirty;
    $('#rpSave').disabled = !dirty || !!bad;
    f.bank.classList.toggle('invalid', !!bad);
  };
  f.currency.addEventListener('change', paint);
  f.timezone.addEventListener('change', paint);
  f.bank.addEventListener('input', paint);
  f.bankFee.addEventListener('input', () => { f.bankFee.value = groupAmount(f.bankFee.value.replace(/\./g, '')); paint(); });
  $('#rpDiscard').addEventListener('click', () => renderRegionPrefsTab());
  rpClockTimer = setInterval(paintClock, 20000);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#rpErr'); err.hidden = true;
    const p = read();
    const btn = $('#rpSave'); btn.disabled = true;
    try {
      await api('/region-prefs', { method: 'PUT', body: JSON.stringify({ ...p, ...(region ? { region } : {}) }) });
      toast(t('Saved'));
      // If the actor edited their own region, refresh so new-claim defaults and
      // date formatting pick up the change without a reload.
      if (state.user && String(state.user.region || '') === String(region)) {
        try { const { user } = await api('/me'); if (user) state.user = { ...state.user, ...user }; } catch { /* keep going */ }
      }
      renderRegionPrefsTab();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
  paint();
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
    + roles.map(r => `<th class="role-h"><span class="role-h-label">${esc(roleLabel(r))}</span>${editable.has(r) ? '' : `<div class="role-locked">${esc(t('Locked'))}</div>`}</th>`).join('');
  // Each tick carries its role's name: hidden under the column headers in the
  // wide grid, shown beside the box when narrow screens stack each capability
  // as a card — and always its accessible name (role + capability).
  const cell = (c, role) => {
    const on = !!(matrix[role] && matrix[role][c.key]);
    const canEdit = editable.has(role);
    const title = canEdit ? '' : (role === 'employee'
      ? t('The Employee baseline is fixed.')
      : t('This role’s permissions are managed by a more senior administrator.'));
    return `<td class="tick-cell rp-cell${canEdit ? '' : ' rp-locked'}"><label class="rp-tog"${title ? ` title="${esc(title)}"` : ''}>
      <input type="checkbox" ${canEdit ? `data-role="${role}" data-cap="${c.key}"` : 'disabled'} ${on ? 'checked' : ''}
        aria-label="${esc(roleLabel(role))}: ${esc(t(c.label))}" />
      <span class="rp-role">${esc(roleLabel(role))}${canEdit ? '' : ` <span class="rp-lock">${esc(t('Locked'))}</span>`}</span></label></td>`;
  };
  panel.innerHTML = `
    <div class="settings-list ws-table">
      <div class="matrix-wrap">
      <table class="utable utable-matrix">
        <thead><tr>${head}</tr></thead>
        <tbody>${capabilities.map(c => `
          <tr>
            <td data-label="${esc(t('Capability'))}" class="name-cell">
              <div>${esc(t(c.label))}</div>
              <div class="u-sub" style="color:var(--muted);font-size:.8rem;font-weight:400">${esc(t(c.desc))}</div>
            </td>
            ${roles.map(r => cell(c, r)).join('')}
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
// Status chip per lookup (by API path): 'all' | 'active' | 'disabled'.
const lookupFilter = {};
// Sort per lookup with usage (expense types): 'name' | 'uses' | 'recent'.
const lookupSort = {};
// Where the job-position ladder unlocks more reach. Mirrors lib/permissions.js
// (accountsSeeAllDepts / insightsSeeAll / insightsCanView): the position with
// that name, or — if it was renamed away — the seeded rank as a fallback.
const RANK_TIERS = [
  { name: 'director', fallback: 3, label: 'Above this line: account management covers every department' },
  { name: 'general manager', fallback: 5, label: 'Above this line: company-wide Insights' },
  { name: 'supervisor', fallback: 10, label: 'Above this line: can open Insights' }
];
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
  // manage=1: disabled entries too (so they can be re-enabled), plus how many
  // active accounts use each department / position.
  try { ({ items } = await api(cfg.path + (regionQS ? regionQS + '&' : '?') + 'manage=1')); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }

  // Purpose gates — New claim / New meal allowance only. Cash advance is NOT one
  // of them: it is a per-account grant in the account editor (see hasAdvanceGrant).
  const p = !!cfg.purposes;
  const ranked = !!cfg.ranked;      // reorderable seniority ladder (job positions)
  const manage = !!cfg.manage;      // "Can manage accounts" delegation flag
  const noun = t(cfg.noun);         // localised singular noun for this lookup
  // A flag toggle (persisted immediately via PUT). Its label is hidden under the
  // column header in the wide table and shown beside the box in narrow cards.
  const flagCell = (it, flag, label) =>
    `<td class="tick-cell lk-cell"><label class="lk-tog">
      <input type="checkbox" data-flag="${flag}" data-id="${it.id}" ${it[flag] ? 'checked' : ''} aria-label="${esc(it.name)}: ${esc(label)}" />
      <span class="lk-tog-label">${esc(label)}</span></label></td>`;
  // Up/down reorder controls for a ranked row (disabled at the ends).
  const orderCell = (it, i) => `<td class="ord-cell">
      <div class="ord-wrap"><span class="ord-n">${i + 1}</span><div class="ord-btns">
        <button type="button" class="ord-btn" data-move="up" data-id="${it.id}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('Move up'))}">▲</button>
        <button type="button" class="ord-btn" data-move="down" data-id="${it.id}" ${i === items.length - 1 ? 'disabled' : ''} aria-label="${esc(t('Move down'))}">▼</button>
      </div></div></td>`;
  // Under the name: how many active accounts use it, and a warning when its
  // members can raise nothing at all.
  const metaHtml = (it) => {
    const bits = [];
    if (it.members != null) bits.push(`<span class="lk-members${it.members ? '' : ' none'}">${esc(it.members
      ? t(it.members === 1 ? '{n} account' : '{n} accounts', { n: it.members }) : t('No accounts'))}</span>`);
    if (it.uses != null) bits.push(`<span class="lk-members${it.uses ? '' : ' none'}">${esc(it.uses
      ? t(it.uses === 1 ? 'Used once' : 'Used {n} times', { n: it.uses }) + (it.last_used ? ' · ' + t('last {date}', { date: it.last_used }) : '')
      : t('Never used'))}</span>`);
    if (p && it.active && !it.allow_claim && !it.allow_meal) bits.push(`<span class="lk-warn">${esc(t('Can’t raise claims or meal allowances'))}</span>`);
    return bits.join('');
  };
  const headCols = (ranked ? `<th class="ord-h">${esc(t('Order'))}</th>` : '') + `<th>${esc(t('Name'))}</th>`
    + (p ? `<th class="flag-h">${esc(t('New claim'))}</th><th class="flag-h">${esc(t('New meal allowance'))}</th>` : '')
    + (manage ? `<th class="flag-h" title="${esc(t('Can reset passwords and enable or disable accounts ranked below it in the same department.'))}">${esc(t('Manage accounts'))}</th>` : '')
    + '<th class="u-actions-h"></th>';
  const colspan = 1 + (ranked ? 1 : 0) + (p ? 2 : 0) + (manage ? 1 : 0) + 1;
  const counts = { all: items.length, active: items.filter(x => x.active).length };
  counts.disabled = counts.all - counts.active;
  if (!lookupFilter[cfg.path] || !counts.disabled) lookupFilter[cfg.path] = 'all';
  const chips = counts.disabled ? `<div class="ws-chips" role="group" aria-label="${esc(t('Status'))}">${[['all', t('All')], ['active', t('Active')], ['disabled', t('Disabled')]].map(([k, label]) =>
    `<button type="button" class="ws-chip${lookupFilter[cfg.path] === k ? ' on' : ''}" data-lkfilter="${k}" aria-pressed="${lookupFilter[cfg.path] === k}">${esc(label)} <span>${counts[k]}</span></button>`).join('')}</div>`
    : `<span class="ws-count">${esc(t('{active} active · {disabled} disabled', { active: counts.active, disabled: 0 }))}</span>`;
  const hasUsage = items.some(x => x.uses != null);
  if (!lookupSort[cfg.path]) lookupSort[cfg.path] = 'name';
  const sortSel = hasUsage ? `<label class="lk-sort"><span>${esc(t('Sort'))}</span><select id="lookupSort" class="input" aria-label="${esc(t('Sort'))}">${
    [['name', t('Name A–Z')], ['uses', t('Most used')], ['recent', t('Recently used')]].map(([k, l]) =>
      `<option value="${k}"${lookupSort[cfg.path] === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : '';
  setWsPage({ actions: `<button type="button" class="btn btn-primary btn-sm" id="lookupAddBtn">+ ${esc(t('Add {noun}', { noun }))}</button>` });
  panel.innerHTML = `
    <div class="settings-controls">
      <form id="lookupForm" class="rg-add" hidden>
        <textarea name="name" class="input lk-add-input" rows="1" required placeholder="${esc(t('Name'))}" aria-label="${esc(t('Name'))}"></textarea>
        <button type="submit" class="btn btn-primary btn-sm">${esc(t('Add'))}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cancel>${esc(t('Cancel'))}</button>
        <p class="lk-add-hint">${esc(t('Tip: paste a list, one per line, to add several at once.'))}</p>
        <p class="form-error" id="lookupErr" hidden></p>
      </form>
      <div class="ws-toolbar">
        <input id="lookupSearch" class="input" type="search" placeholder="${esc(t('Search {noun}…', { noun }))}" />
        ${chips}${sortSel}
      </div>
    </div>
    <div class="settings-list ws-table">
      <table class="utable utable-lookup${p ? ' has-flags' : ''}">
        <thead><tr>${headCols}</tr></thead>
        <tbody>${items.length ? items.map((it, i) => `
          <tr data-id="${it.id}" data-state="${it.active ? 'active' : 'disabled'}"${it.active ? '' : ' class="row-off"'}>
            ${ranked ? orderCell(it, i) : ''}
            <td class="name-cell"><div class="lk-line"><span class="lk-name">${esc(it.name)}</span>${it.active ? '' : ` <span class="pill pill-off">${esc(t('Disabled'))}</span>`}</div><div class="lk-meta">${metaHtml(it)}</div></td>
            ${p ? flagCell(it, 'allow_claim', t('New claim')) + flagCell(it, 'allow_meal', t('New meal allowance')) : ''}
            ${manage ? flagCell(it, 'can_manage', t('Manage accounts')) : ''}
            <td class="act-cell">
              <button type="button" class="row-more" data-menu="${it.id}" aria-haspopup="menu" aria-label="${esc(t('More actions'))}" title="${esc(t('More actions'))}">⋯</button>
            </td>
          </tr>`).join('') + `<tr class="lk-none" hidden><td colspan="${colspan}" class="muted">${esc(t('No matches'))}</td></tr>`
          : `<tr><td colspan="${colspan}" class="muted" style="padding:16px">${esc(t('No {noun} entries yet.', { noun }))}</td></tr>`}</tbody>
      </table>
    </div>`;
  const applySort = () => {
    if (!hasUsage) return;
    const by = lookupSort[cfg.path];
    const cmpName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
    const sorted = [...items].sort((a, b) => by === 'uses' ? (b.uses || 0) - (a.uses || 0) || cmpName(a, b)
      : by === 'recent' ? String(b.last_used || '').localeCompare(String(a.last_used || '')) || cmpName(a, b)
      : cmpName(a, b));
    const tbody = $('#settingsPanel .utable-lookup tbody');
    const end = tbody.querySelector('.lk-none');
    sorted.forEach(x => tbody.insertBefore(tbody.querySelector(`tr[data-id="${x.id}"]`), end));
  };
  if (hasUsage) {
    $('#lookupSort').addEventListener('change', (e) => { lookupSort[cfg.path] = e.target.value; applySort(); });
    applySort();
  }
  // Search and the status chips filter the same rows together.
  const applyFilter = () => {
    const q = $('#lookupSearch').value.trim().toLowerCase();
    const f = lookupFilter[cfg.path];
    let shown = 0;
    $$('#settingsPanel .utable-lookup tbody tr[data-id]').forEach(tr => {
      const hit = (!q || tr.querySelector('.lk-name').textContent.toLowerCase().includes(q)) && (f === 'all' || tr.dataset.state === f);
      tr.hidden = !hit; if (hit) shown++;
    });
    const none = $('#settingsPanel .lk-none');
    if (none) none.hidden = shown > 0;
    paintLadder();
  };
  // Ranked lists: renumber, set the arrows, and draw a line under the last
  // position of each tier, so a reorder shows what it changes as it happens.
  // Reordering is off while a search or filter hides part of the ladder.
  function paintLadder() {
    if (!ranked) return;
    const tbody = $('#settingsPanel .utable-lookup tbody');
    if (!tbody || !items.length) return;
    const filtering = !!$('#lookupSearch').value.trim() || lookupFilter[cfg.path] !== 'all';
    tbody.querySelectorAll('tr.lk-tier').forEach(r => r.remove());
    items.forEach((it, k) => {
      const tr = tbody.querySelector(`tr[data-id="${it.id}"]`);
      tr.querySelector('.ord-n').textContent = k + 1;
      const [up, down] = tr.querySelectorAll('[data-move]');
      up.disabled = filtering || k === 0;
      down.disabled = filtering || k === items.length - 1;
      up.title = down.title = filtering ? t('Clear the search and filter to reorder') : '';
    });
    if (filtering) return;
    for (const tier of RANK_TIERS) {
      let after = items.findIndex(x => String(x.name).trim().toLowerCase() === tier.name);
      if (after < 0) items.forEach((x, k) => { if ((x.rank || Infinity) <= tier.fallback) after = k; });
      if (after < 0) continue;
      let anchor = tbody.querySelector(`tr[data-id="${items[after].id}"]`);
      while (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('lk-tier')) anchor = anchor.nextElementSibling;
      anchor.insertAdjacentHTML('afterend', `<tr class="lk-tier"><td colspan="${colspan}"><span>${esc(t(tier.label))}</span></td></tr>`);
    }
  }
  $('#lookupSearch').addEventListener('input', applyFilter);
  $$('#settingsPanel [data-lkfilter]').forEach(b => b.addEventListener('click', () => {
    lookupFilter[cfg.path] = b.dataset.lkfilter;
    $$('#settingsPanel [data-lkfilter]').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
    applyFilter();
  }));
  applyFilter();

  const byId = (id) => items.find(x => x.id == id);
  let saveTimer = null;
  const saveOrder = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(`${cfg.path}/reorder`, { method: 'POST', body: JSON.stringify({ order: items.map(x => x.id), ...regionBody }) });
        toast(t('Order saved'));
      } catch (ex) { toast(ex.message, true); refreshAfterSettings(); }
    }, 400);
  };
  function moveTo(id, to) {
    const idx = items.findIndex(x => x.id == id);
    if (idx < 0 || to < 0 || to >= items.length || to === idx) return;
    const [it] = items.splice(idx, 1);
    items.splice(to, 0, it);
    items.forEach((x, k) => { x.rank = k + 1; });   // what the server will store
    const tbody = $('#settingsPanel .utable-lookup tbody');
    const end = tbody.querySelector('.lk-none');
    items.forEach(x => tbody.insertBefore(tbody.querySelector(`tr[data-id="${x.id}"]`), end));
    paintLadder();
    const row = tbody.querySelector(`tr[data-id="${id}"]`);
    row.classList.remove('lk-moved'); void row.offsetWidth; row.classList.add('lk-moved');
    row.scrollIntoView({ block: 'nearest' });
    saveOrder();
  }
  const addForm = $('#lookupForm');
  $('#lookupAddBtn').addEventListener('click', () => { addForm.hidden = false; addForm.querySelector('input').focus(); });
  addForm.querySelector('[data-cancel]').addEventListener('click', () => { addForm.reset(); addForm.hidden = true; $('#lookupErr').hidden = true; });
  // One name per line (a pasted list adds several); Enter adds, the box grows
  // to show what was pasted. Names already in the list are skipped.
  const addBox = addForm.querySelector('textarea');
  const growAdd = () => { addBox.style.height = 'auto'; addBox.style.height = Math.min(addBox.scrollHeight, 160) + 'px'; };
  addBox.addEventListener('input', growAdd);
  addBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addForm.requestSubmit(); } });
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#lookupErr'); err.hidden = true;
    const have = new Set(items.map(x => String(x.name).trim().toLowerCase()));
    const names = [];
    for (const raw of addBox.value.split(/\r?\n/)) {
      const name = raw.trim().slice(0, 80);
      if (name && !names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    const skipped = names.filter(n => have.has(n.toLowerCase()));
    const todo = names.filter(n => !have.has(n.toLowerCase()));
    const failed = [];
    let added = 0;
    const submit = addForm.querySelector('[type=submit]'); submit.disabled = true;
    for (const name of todo) {
      try { await api(cfg.path, { method: 'POST', body: JSON.stringify({ name, ...regionBody }) }); added++; }
      catch (ex) { failed.push(`${name}: ${ex.message}`); }
    }
    submit.disabled = false;
    const problems = [...skipped.map(n => t('{name} is already in the list', { name: n })), ...failed];
    const showProblems = () => {
      const f = $('#lookupForm'), box = f.querySelector('textarea'), el = $('#lookupErr');
      f.hidden = false;
      box.value = [...skipped, ...failed.map(x => x.split(': ')[0])].join('\n');
      box.dispatchEvent(new Event('input'));
      el.textContent = problems.join(' · '); el.hidden = false;
    };
    if (!added) return showProblems();
    toast(ranked ? t('Added at the bottom of the ladder — use the arrows to move it into place.')
      : added === 1 ? t('Added') : t('Added {n}', { n: added }));
    loadLookups();
    // Re-render with the new rows, then keep whatever could not be added in
    // the box with the reason beside it.
    await renderSettingsTab();
    if (problems.length) showProblems();
  });
  $$('#settingsPanel [data-menu]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const it = byId(b.dataset.menu);
    openRowMenu(b, `${cfg.path}:${it.id}`, [
      ...(ranked && items.length > 1 ? [{ act: 'top', label: t('Move to top') }, { act: 'bottom', label: t('Move to bottom') }] : []),
      { act: 'rename', label: t('Rename') },
      { act: 'toggle', label: it.active ? t('Disable') : t('Enable') },
      { act: 'delete', label: t('Delete'), danger: true }
    ], async (act) => {
      if (act === 'top' || act === 'bottom') return moveTo(it.id, act === 'top' ? 0 : items.length - 1);
      if (act === 'rename') return startInlineRename(b.closest('tr').querySelector('.name-cell'), it, cfg);
      if (act === 'toggle') {
        try { await api(`${cfg.path}/${it.id}`, { method: 'PUT', body: JSON.stringify({ active: !it.active }) }); toast(t('Saved')); refreshAfterSettings(); }
        catch (ex) { toast(ex.message, true); }
        return;
      }
      const msg = it.uses
        ? t('Used {n} times. Delete it anyway? Claims already filed keep the name, but it can no longer be chosen. Disable it instead to keep it on record.', { n: it.uses })
        : it.members
        ? t('{count} still use this {noun}. Delete it anyway? Their accounts keep the name, but it can no longer be chosen. Disable it instead to keep it on record.',
          { count: t(it.members === 1 ? '{n} account' : '{n} accounts', { n: it.members }), noun })
        : t('Delete this {noun}? Existing claims keep their recorded value.', { noun });
      if (!confirm(msg)) return;
      try { await api(`${cfg.path}/${it.id}`, { method: 'DELETE' }); toast(t('Deleted')); refreshAfterSettings(); }
      catch (ex) { toast(ex.message, true); }
    });
  }));
  // Boolean flag tickboxes (purposes + can_manage) — persist immediately; keep
  // local state in sync so a later re-render reflects the choice.
  $$('#settingsPanel input[data-flag]').forEach(cb => cb.addEventListener('change', async () => {
    const it = byId(cb.dataset.id);
    const flag = cb.dataset.flag, val = cb.checked;
    try {
      await api(`${cfg.path}/${cb.dataset.id}`, { method: 'PUT', body: JSON.stringify({ [flag]: val }) });
      if (it) { it[flag] = val; const m = cb.closest('tr').querySelector('.lk-meta'); if (m) m.innerHTML = metaHtml(it); }
      toast(t('Saved'));
    } catch (ex) { cb.checked = !val; toast(ex.message, true); }
  }));
  // Reorder arrows — move the row in place (no reload, focus stays on the
  // arrow), then save the whole ladder once the clicks stop.
  if (ranked) $$('#settingsPanel [data-move]').forEach(b => b.addEventListener('click', () => {
    const idx = items.findIndex(x => x.id == b.dataset.id);
    moveTo(b.dataset.id, b.dataset.move === 'up' ? idx - 1 : idx + 1);
    const other = b.parentNode.querySelector(`[data-move]:not([data-move="${b.dataset.move}"])`);
    (b.disabled ? other : b).focus();
  }));
}

// Replace a name cell's text with an editable input + Save/Cancel. Enter saves,
// Escape cancels. On success the whole tab re-renders (keeps ordering/flags).
function startInlineRename(cell, it, cfg) {
  if (!cell || cell.querySelector('input')) return;
  const before = cell.innerHTML;
  cell.innerHTML = `<div class="rename-row">
      <input class="input rename-input" value="${esc(it.name)}" />
      <button type="button" class="btn btn-primary btn-sm" data-save>${esc(t('Save'))}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cancel>${esc(t('Cancel'))}</button>
    </div>`;
  const input = cell.querySelector('.rename-input');
  input.focus(); input.select();
  const cancel = () => { cell.innerHTML = before; };
  const save = async () => {
    const name = input.value.trim();
    if (!name || name === it.name) return cancel();
    try {
      const r = await api(`${cfg.path}/${it.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      toast(r && r.moved ? t('Renamed — {count} moved to the new name.', { count: t(r.moved === 1 ? '{n} account' : '{n} accounts', { n: r.moved }) })
        : it.uses ? t('Renamed. Claims already filed keep the old name.') : t('Renamed'));
      refreshAfterSettings();
    }
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
