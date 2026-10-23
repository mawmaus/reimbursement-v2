'use strict';

// Accounts: the Super Admin's account table and form, and delegated account management.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// --- Accounts (users) --------------------------------------------------------
// Current sort for the accounts table: key + direction (1 = A→Z, -1 = Z→A).
let accountsSort = { key: 'full_name', dir: 1 };
// Sort a copy of the accounts by the active column, always tie-breaking on name.
function sortAccounts(users) {
  const { key, dir } = accountsSort;
  const val = (u) => key === 'allow_advance' ? (hasAdvanceGrant(u) ? 1 : 0)
    : key === 'active' ? (u.active ? 1 : 0)
    : String(u[key] || '').toLowerCase();
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

// The team screen non-superadmins get — the "Manage accounts" modal and the
// Accounts page of their Settings workspace render the same table from here.
// Scope copy: which accounts the viewer sees and what they may do with them.
function teamScopeCopy() {
  const dept = state.user.department || '';
  const canCreate = uCan('create_accounts');
  return state.user.sees_all_departments
    ? (canCreate
        ? t('All departments. You can create accounts, reset passwords and enable/disable any account ranked below yours.')
        : t('All departments. You can reset passwords and enable/disable any account ranked below yours. Only a super admin can create new accounts.'))
    : (canCreate
        ? t('Accounts in {dept}. You can create accounts, reset passwords and enable/disable your team (positions ranked below yours).', { dept: dept || '—' })
        : t('Accounts in {dept}. You can reset passwords and enable/disable your team (positions ranked below yours). Only a super admin can create new accounts.', { dept: dept || '—' }));
}
// Toolbar (search + status chips) and the table card. Director-and-above
// viewers see every department (server-computed), so they get a Department
// column to keep cross-department rows legible.
function teamAccountsHtml(users) {
  const wide = !!state.user.sees_all_departments;
  const shown = users.filter(u => accountsFilter === 'all' || (accountsFilter === 'active') === !!u.active);
  const cols = wide ? 5 : 4;
  return `
    <div class="settings-controls">
      <div class="ws-toolbar">
        <input id="acctSearch" class="input" type="search" placeholder="${esc(t('Search users…'))}" />
        ${acctFilterChips(users)}
      </div>
    </div>
    <div class="settings-list ws-table">
      <table class="utable utable-manage${wide ? ' utable-manage--wide' : ''}">
        <thead><tr><th>${esc(t('User'))}</th>${wide ? `<th>${esc(t('Department'))}</th>` : ''}<th>${esc(t('Position'))}</th><th>${esc(t('Status'))}</th><th class="u-actions-h"></th></tr></thead>
        <tbody>${shown.length ? shown.map(u => `
          <tr${u.active ? '' : ' class="row-off"'}>
            <td data-label="${esc(t('User'))}"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub"><span class="mono">${esc(u.username)}</span>${u.email ? ` · ${esc(u.email)}` : ''}</div>${creatorLine(u)}</td>
            ${wide ? `<td data-label="${esc(t('Department'))}">${u.department ? esc(u.department) : '<span class="muted">—</span>'}</td>` : ''}
            <td data-label="${esc(t('Position'))}">${u.position ? esc(u.position) : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Status'))}">${acctStatusPill(u)}</td>
            <td class="act-cell" data-label="${esc(t('Actions'))}">${maCanManage(u) ? `<div class="u-actions">
              <button type="button" class="btn btn-brand-soft btn-sm" data-reset="${u.id}">${esc(t('Reset password'))}</button>
              <button type="button" class="row-more" data-menu="${u.id}" aria-haspopup="menu" aria-label="${esc(t('More actions'))}" title="${esc(t('More actions'))}">⋯</button>
            </div>` : `<span class="team-ro">${esc(t('View only'))}</span>`}</td>
          </tr>`).join('') : `<tr><td colspan="${cols}" class="muted" style="padding:16px">${esc(users.length ? t('No matches') : t('No accounts yet.'))}</td></tr>`}</tbody>
      </table>
    </div>`;
}
// Paint the team table into `root` and wire it; `refetch` reloads after a change.
function paintTeam(root, users, refetch) {
  const repaint = () => repaintKeepingSearch(() => paintTeam(root, users, refetch));
  root.querySelector('.team-mount').innerHTML = teamAccountsHtml(users);
  wireTableSearch($('#acctSearch'), `#${root.id} .settings-list`);
  root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { accountsFilter = b.dataset.filter; repaint(); }));
  root.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () =>
    renderResetPasswordForm(users.find(x => x.id == b.dataset.reset))));
  root.querySelectorAll('[data-menu]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const u = users.find(x => x.id == b.dataset.menu);
    openRowMenu(b, 'team:' + u.id, [u.active
      ? { act: 'toggle', label: t('Disable account'), danger: true }
      : { act: 'toggle', label: t('Enable account') }], async () => {
      if (u.active && !confirm(t("Disable {name}'s account? They won't be able to sign in until re-enabled.", { name: u.full_name }))) return;
      try {
        await api('/users/' + u.id + '/set-active', { method: 'POST', body: JSON.stringify({ active: !u.active }) });
        toast(u.active ? t('Account disabled') : t('Account enabled'));
        refetch();
      } catch (ex) { toast(ex.message, true); }
    });
  }));
}

// The Accounts page of a non-superadmin's Settings workspace.
function paintDelegatedAccounts() {
  const panel = $('#settingsPanel');
  setWsPage({ desc: teamScopeCopy(), actions: uCan('create_accounts') ? `<button type="button" class="btn btn-primary btn-sm" id="addUserBtn">${esc(t('+ Add user'))}</button>` : '' });
  panel.innerHTML = '<div class="team-mount"></div>';
  paintTeam(panel, settingsState.users || [], renderAccountsTab);
  const addBtn = $('#addUserBtn');
  if (addBtn) addBtn.addEventListener('click', () => openDelegatedUserForm());
}

// Status filter for the accounts list: chips above the table, with counts.
let accountsFilter = 'all';
function acctFilterChips(users) {
  const n = { all: users.length, active: users.filter(u => u.active).length };
  n.disabled = n.all - n.active;
  return `<div class="ws-chips" role="group" aria-label="${esc(t('Status'))}">${[['all', t('All')], ['active', t('Active')], ['disabled', t('Disabled')]].map(([k, label]) =>
    `<button type="button" class="ws-chip${accountsFilter === k ? ' on' : ''}" data-filter="${k}" aria-pressed="${accountsFilter === k}">${esc(label)} <span>${n[k]}</span></button>`).join('')}</div>`;
}
const acctStatusPill = (u) => u.active
  ? `<span class="pill pill-on">${esc(t('Active'))}</span>`
  : `<span class="pill pill-off">${esc(t('Disabled'))}</span>`;
// Repaint helper: keep what's typed in the search box across a re-render.
function repaintKeepingSearch(paint) {
  const q = ($('#acctSearch') || {}).value || '';
  paint();
  const s = $('#acctSearch');
  if (s && q) { s.value = q; s.dispatchEvent(new Event('input')); }
}
async function setAccountActive(u) {
  if (u.active && !confirm(t("Disable {name}'s account? They won't be able to sign in until re-enabled.", { name: u.full_name }))) return;
  try {
    await api('/users/' + u.id + '/set-active', { method: 'POST', body: JSON.stringify({ active: !u.active }) });
    toast(u.active ? t('Account disabled') : t('Account enabled'));
    renderAccountsTab();
  } catch (ex) { toast(ex.message, true); }
}

function paintAccounts() {
  const panel = $('#settingsPanel');
  const users = settingsState.users || [];
  const shown = sortAccounts(users.filter(u => accountsFilter === 'all' || (accountsFilter === 'active') === !!u.active));
  // A clickable header cell that sorts by `key` and shows the active arrow.
  const th = (key, label) => {
    const on = accountsSort.key === key;
    const arrow = on ? (accountsSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-sort="${key}" role="button" tabindex="0" aria-sort="${on ? (accountsSort.dir === 1 ? 'ascending' : 'descending') : 'none'}">${esc(label)}<span class="sort-arrow">${arrow}</span></th>`;
  };
  setWsPage({ actions: `<button type="button" class="btn btn-primary btn-sm" id="addUserBtn">${esc(t('+ Add user'))}</button>` });
  panel.innerHTML = `
    <div class="settings-controls">
      <div class="ws-toolbar">
        <input id="acctSearch" class="input" type="search" placeholder="${esc(t('Search users…'))}" />
        ${acctFilterChips(users)}
      </div>
    </div>
    <div class="settings-list ws-table">
      <table class="utable utable-users">
        <thead><tr>${th('full_name', t('User'))}${th('role', t('Role'))}${th('department', t('Dept / Position'))}${th('region', t('Region'))}${th('allow_advance', t('Cash advance'))}${th('active', t('Status'))}<th class="u-actions-h"></th></tr></thead>
        <tbody>${shown.length ? shown.map(u => {
          const editable = state.user.role === 'superadmin' || u.role === 'employee';
          return `
          <tr${u.active ? '' : ' class="row-off"'}>
            <td data-label="${esc(t('User'))}"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub"><span class="mono">${esc(u.username)}</span>${u.email ? ` · ${esc(u.email)}` : ''}</div>${creatorLine(u)}</td>
            <td data-label="${esc(t('Role'))}">${esc(roleLabel(u.role))}<div class="u-sub">${u.approval_limit_cents == null ? esc(t('Approves any amount')) : esc(t('Approves ≤ {amount}', { amount: money(u.approval_limit_cents / 100) }))}</div></td>
            <td data-label="${esc(t('Dept / Position'))}"><div>${u.department ? esc(u.department) : '<span class="muted">—</span>'}</div>${u.position ? `<div class="u-sub">${esc(u.position)}</div>` : ''}</td>
            <td data-label="${esc(t('Region'))}">${esc(regionLabel(u.region))}</td>
            <td data-label="${esc(t('Cash advance'))}">${hasAdvanceGrant(u) ? `<span class="pill pill-on">${esc(t('Yes'))}</span>` : '<span class="muted">—</span>'}</td>
            <td data-label="${esc(t('Status'))}">${acctStatusPill(u)}</td>
            <td class="act-cell" data-label="${esc(t('Actions'))}">${editable
              ? `<div class="u-actions">
                <button class="btn btn-brand-soft btn-sm" data-edit="${u.id}">${esc(t('Edit'))}</button>
                ${u.id != state.user.id ? `<button type="button" class="row-more" data-menu="${u.id}" aria-haspopup="menu" aria-label="${esc(t('More actions'))}" title="${esc(t('More actions'))}">⋯</button>` : '<span class="row-more-gap"></span>'}
              </div>`
              : '<span class="muted">—</span>'}</td>
          </tr>`; }).join('') : `<tr><td colspan="7" class="muted" style="padding:16px">${esc(t('No accounts yet.'))}</td></tr>`}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#acctSearch'), '#settingsPanel .settings-list');
  // Clicking (or pressing Enter/Space on) a header sorts by that column; the same
  // header again flips the direction.
  const applySort = (key) => {
    if (accountsSort.key === key) accountsSort.dir *= -1;
    else accountsSort = { key, dir: 1 };
    repaintKeepingSearch(paintAccounts);
  };
  $$('#settingsPanel th[data-sort]').forEach(h => {
    h.addEventListener('click', () => applySort(h.dataset.sort));
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applySort(h.dataset.sort); } });
  });
  $$('#settingsPanel [data-filter]').forEach(b => b.addEventListener('click', () => {
    accountsFilter = b.dataset.filter; repaintKeepingSearch(paintAccounts);
  }));
  $('#addUserBtn').addEventListener('click', () => renderUserForm(null));
  $$('#settingsPanel [data-edit]').forEach(b =>
    b.addEventListener('click', () => renderUserForm(users.find(x => x.id == b.dataset.edit))));
  $$('#settingsPanel [data-menu]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const u = users.find(x => x.id == b.dataset.menu);
    openRowMenu(b, 'user:' + u.id, [u.active
      ? { act: 'toggle', label: t('Disable account'), danger: true }
      : { act: 'toggle', label: t('Enable account') }], () => setAccountActive(u));
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

// Coordinates out of pasted text — "lat, lng" or a Google Maps link — mirroring
// lib/meal-gps.js parseCoords. Returns { lat, lng } or null.
function parseCoordsText(input) {
  let s = String(input || '').trim();
  try { s = decodeURIComponent(s); } catch { /* keep as typed */ }
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  for (const re of [new RegExp(`!3d${num}!4d${num}`), new RegExp(`@${num},\\s*${num}`),
    new RegExp(`[?&](?:q|query|ll|center|destination)=${num},\\s*${num}`), new RegExp(`^${num}\\s*[,;\\s]\\s*${num}$`)]) {
    const m = s.match(re);
    if (!m) continue;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  }
  return null;
}
function renderUserForm(u) {
  const isEdit = !!u;
  const isSuper = state.user.role === 'superadmin';
  const excludeId = isEdit ? u.id : null;
  acctApprovers = isEdit ? (u.approver_ids || []).map(String) : [];
  acctApprover1Options = isEdit ? (u.approver1_options || []).map(String) : [];
  const initials = isEdit ? String(u.full_name || u.username || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() : '+';
  const roleField = isSuper ? `<label>${esc(t('Role'))}
          <select name="role">
            ${['superadmin', 'vp', 'admin', 'manager', 'lowmgmt', 'finance', 'employee'].map(r =>
              `<option value="${r}" ${(isEdit ? u.role === r : r === 'employee') ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}
          </select></label>`
    : (!isEdit && creatableRoles().length ? `<label>${esc(t('Role'))}
          <select name="role">
            ${creatableRoles().map((r, i, arr) =>
              `<option value="${r}" ${i === arr.length - 1 ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join('')}
          </select></label>` : '');
  const regionField = (isSuper || (!isEdit && state.user.region === '*')) ? `<label>${esc(t('Region'))}
          <select name="region">
            ${(state.lookups.regions || []).map(r => `<option value="${esc(r)}" ${(isEdit ? u.region === r : r === settingsState.region) ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            ${isSuper ? `<option value="*" ${isEdit && u.region === '*' ? 'selected' : ''}>${esc(t('All regions'))}</option>` : ''}
          </select></label>` : '';
  // One titled card per section; the side menu jumps between them.
  const sec = (id, title, desc, body) => `
        <section class="ue-sec" id="ue-${id}" data-sec="${id}">
          <header class="ue-sec-head"><h3>${esc(title)}</h3>${desc ? `<p>${esc(desc)}</p>` : ''}</header>
          ${body}
        </section>`;
  const sections = [
    ['profile', t('Profile'), t('Who this account belongs to, and where notifications and password resets are sent.'), `
          <div class="grid2">
            <label>${esc(t('Full name'))}<input name="full_name" required value="${isEdit ? esc(u.full_name) : ''}" /></label>
            <label>${esc(t('Email (for resets & notifications)'))}<input name="email" type="email" value="${isEdit ? esc(u.email || '') : ''}" placeholder="${esc(t('you@company.com'))}" /></label>
          </div>`],
    ['signin', t('Sign-in'), isEdit ? t('Leave the password blank to keep the current one.') : t('The username and first password this person signs in with.'), `
          <div class="grid2">
            <label>${esc(t('Username'))}<input name="username" required autocomplete="off" value="${isEdit ? esc(u.username) : ''}" /></label>
            <label>${isEdit ? esc(t('Reset password (optional)')) : esc(t('Password'))}
              <div class="pw-wrap">
                <input name="password" type="password" autocomplete="new-password" ${isEdit ? '' : 'required'} />
                <button type="button" class="pw-toggle" aria-label="${esc(t('Show password'))}">👁</button>
              </div></label>
          </div>`],
    ['access', t('Role & access'), t('What this account is, where it belongs, and what it may do.'), `
          <div class="grid2">
            ${roleField}${regionField}
            <label>${esc(t('Department'))}${optionSelect('department', isEdit ? u.department : '', settingsState.departments)}</label>
            <label>${esc(t('Job position'))}${optionSelect('position', isEdit ? u.position : '', settingsState.positions)}</label>
          </div>
          ${isSuper ? `
          <div class="ue-sub">${esc(t('Permissions'))}</div>
          <div class="grid2 ue-checks">
            <label class="perm-check"><input type="checkbox" name="can_mark_paid" ${isEdit && u.can_mark_paid ? 'checked' : ''} /> <span>${esc(t('Can mark claims as paid (record payment)'))}</span></label>
            <label class="perm-check"><input type="checkbox" name="allow_advance" ${isEdit && u.allow_advance ? 'checked' : ''} /> <span>${esc(t('Can request cash advances'))}</span></label>
          </div>
          <p class="ue-hint">${esc(t('Cash advance is granted per account — the department and job-position lists no longer control it.'))}</p>` : ''}`],
    ['approvals', t('Approvals'), t('How much this person may approve, and who approves their own claims.'), `
          ${isSuper ? `
          <div class="ue-sub ue-sub-first">${esc(t('Approval limit'))}</div>
          <div class="ue-limit">
            <label class="perm-check"><input type="checkbox" name="approval_unlimited" ${(isEdit ? u.approval_limit_cents == null : true) ? 'checked' : ''} /> <span>${esc(t('Unlimited — can approve a claim of any amount'))}</span></label>
            <label id="apprLimitWrap">${esc(t('Maximum claim amount this account can approve'))}
              <input name="approval_limit" inputmode="decimal" placeholder="${esc(t('e.g. 5,000,000'))}" value="${(isEdit && u.approval_limit_cents != null) ? esc(String(u.approval_limit_cents / 100)) : ''}" />
            </label>
          </div>
          <div class="ue-sub">${esc(t('Approver 1 — let the submitter choose from'))}</div>
          <p class="ue-hint ue-hint-top">${esc(t('Add two or more accounts to let this person pick their Approver 1 from a dropdown on the New Claim form. With one, it\'s used as Approver 1 automatically (no dropdown). Leave empty to use the fixed chain below as-is. Whatever ends up as Approver 1 becomes step 1, and the chain below runs after it.'))}</p>
          <div id="approver1OptionRows"></div>
          <button type="button" class="btn btn-ghost btn-sm add-approver-btn" id="addApprover1OptBtn">${esc(t('+ Add candidate'))}</button>` : ''}
          <div class="ue-sub${isSuper ? '' : ' ue-sub-first'}">${esc(t('Approval chain (approvers, in order)'))}</div>
          <div id="approverRows"></div>
          <button type="button" class="btn btn-ghost btn-sm add-approver-btn" id="addApproverBtn">${esc(t('+ Add approver'))}</button>`],
    ['bank', t('Bank details'), t('Where this person\'s reimbursements are paid.'), `
          <div class="grid2">
            <label>${esc(t('Bank name'))}<input name="bank_name" value="${isEdit ? esc(u.bank_name || '') : ''}" /></label>
            <label>${esc(t('Recipient name'))}<input name="recipient_name" value="${isEdit ? esc(u.recipient_name || '') : ''}" /></label>
            <label>${esc(t('Bank account no.'))}<input name="bank_account_no" inputmode="numeric" value="${isEdit ? esc(u.bank_account_no || '') : ''}" /></label>
          </div>`],
    ...(isSuper ? [['base', t('Base location'), t('Where this person’s GPS meal allowance distances are measured from — pick one of the region’s bases (Settings → Bases).'), `
          <div class="grid2"><label>${esc(t('Base'))}<div id="ueBasePick"><select disabled><option>${esc(t('Loading…'))}</option></select></div></label></div>
          <div class="grid2 ue-base-custom" id="ueBaseCustom" hidden>
            <label>${esc(t('Base name'))}<input name="base_name" maxlength="120" value="${isEdit ? esc(u.base_name || '') : ''}" placeholder="${esc(t('e.g. Jakarta office'))}" /></label>
            <label>${esc(t('Coordinates or Google Maps link'))}<input name="base_coords" autocomplete="off" value="${isEdit && u.base_lat != null ? esc(`${u.base_lat}, ${u.base_lng}`) : ''}" placeholder="-6.2088, 106.8456" /></label>
          </div>
          <p class="ue-hint base-read" id="baseRead"></p>`]] : [])
  ];
  openModal2(`
    <div class="modal-head ue-head">
      <div class="ue-id">
        <span class="ue-avatar${isEdit ? '' : ' ue-avatar-new'}" aria-hidden="true">${esc(initials)}</span>
        <div class="ue-id-text">
          <h2>${isEdit ? esc(u.full_name || u.username) : esc(t('New user'))}</h2>
          <div class="ue-meta">${isEdit
            ? `<span class="mono">${esc(u.username)}</span><span aria-hidden="true">·</span><span>${esc(roleLabel(u.role))}</span><span aria-hidden="true">·</span><span>${esc(regionLabel(u.region))}</span>${u.active === false ? ` <span class="pill pill-off">${esc(t('Disabled'))}</span>` : ''}`
            : `<span>${esc(t('Fill in each section, then create the account.'))}</span>`}</div>
        </div>
      </div>
      <button type="button" class="x-btn" id="uClose">×</button>
    </div>
    <div class="modal-body ue-body">
      <nav class="ue-nav" aria-label="${esc(t('Sections'))}">
        ${sections.map(([id, title], i) => `<button type="button" class="ue-nav-item${i ? '' : ' active'}" data-go="${id}">${esc(title)}</button>`).join('')}
      </nav>
      <form id="uForm" class="form ue-form">
        <div class="ue-scroll" id="ueScroll">${sections.map(s => sec(...s)).join('')}
        </div>
        <div class="ue-foot">
          <p class="form-error" id="uErr" hidden></p>
          <span class="ue-foot-note">${isEdit && u.created_by_name ? esc(t('Created by {name}', { name: u.created_by_name })) : ''}</span>
          <button type="button" class="btn btn-ghost btn-sm" id="uCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary btn-sm">${isEdit ? esc(t('Save changes')) : esc(t('Create account'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal2').classList.add('modal-xwide', 'modal-flex', 'modal-ue');
  $('#uClose').addEventListener('click', closeModal2);
  $('#uCancel').addEventListener('click', closeModal2);
  // Side menu: jump to a section; highlight whichever section is in view.
  const scroller = $('#ueScroll');
  const navItems = $$('#modal2 .ue-nav-item');
  const mark = (id) => navItems.forEach(b => {
    const on = b.dataset.go === id;
    // On phones the menu is a sideways strip: keep the active pill in view.
    if (on && !b.classList.contains('active') && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    b.classList.toggle('active', on);
  });
  navItems.forEach(b => b.addEventListener('click', () => {
    scroller.scrollTo({ top: $('#ue-' + b.dataset.go).offsetTop - 4, behavior: 'smooth' });
    mark(b.dataset.go);
  }));
  scroller.addEventListener('scroll', () => {
    const secs = $$('#ueScroll .ue-sec');
    const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    let cur = secs[0];
    for (const s of secs) if (s.offsetTop <= scroller.scrollTop + 40) cur = s;
    mark((atEnd ? secs[secs.length - 1] : cur).dataset.sec);
  });
  // A submit blocked by empty required fields: light up the section of the
  // first one (the field the browser scrolls to), not the last to report.
  let firstInvalid = true;
  $('#uForm').addEventListener('invalid', (e) => {
    if (!firstInvalid) return;
    firstInvalid = false; setTimeout(() => { firstInvalid = true; });
    const s = e.target.closest('.ue-sec'); if (s) mark(s.dataset.sec);
  }, true);
  // Base: a dropdown of the account's region's bases (Settings → Bases), or a
  // location typed for this account alone. Reloaded when the Region changes.
  if ($('#ueBasePick')) {
    const initialCustom = isEdit && u.base_id == null && u.base_lat != null;
    let current = isEdit && u.base_id != null ? String(u.base_id) : initialCustom ? 'custom' : '';
    const coords = $('#uForm [name="base_coords"]');
    const syncBase = () => {
      const custom = current === 'custom';
      $('#ueBaseCustom').hidden = !custom;
      const box = $('#baseRead');
      const v = coords.value.trim();
      const ll = parseCoordsText(v);
      box.classList.toggle('bad', custom && !!v && !ll);
      box.innerHTML = !custom ? esc(current ? '' : t('Without a base this person can’t claim the GPS meal allowance.'))
        : !v ? esc(t('Paste "latitude, longitude" or a Google Maps link from the address bar.'))
        : ll ? `${esc(t('Reads as {lat}, {lng}', { lat: ll.lat, lng: ll.lng }))} · <a href="https://www.google.com/maps?q=${encodeURIComponent(ll.lat + ',' + ll.lng)}" target="_blank" rel="noopener">${esc(t('Open in Maps'))}</a>`
        : esc(/goo.gl|maps.app/i.test(v)
          ? t('Short share links don’t carry coordinates — open the link, then copy the full address-bar link or right-click the spot to copy its coordinates.')
          : t('Can’t read coordinates from this — use "latitude, longitude", e.g. -6.2088, 106.8456.'));
    };
    const loadBases = async () => {
      const regionSel = $('#uForm select[name="region"]');
      const region = regionSel ? regionSel.value : (isEdit ? u.region : '');
      let bases = [];
      if (region && region !== '*') {
        try { bases = (await api('/bases?region=' + encodeURIComponent(region))).bases || []; } catch { bases = []; }
      }
      if (current && current !== 'custom' && !bases.some(b => String(b.id) === current)) current = '';
      $('#ueBasePick').innerHTML = `<select name="base_id">
          <option value="" ${current ? '' : 'selected'}>${esc(t('— No base —'))}</option>
          ${bases.map(b => `<option value="${b.id}" ${String(b.id) === current ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
          <option value="custom" ${current === 'custom' ? 'selected' : ''}>${esc(t('Another location (type it in)…'))}</option>
        </select>`;
      $('#ueBasePick select').addEventListener('change', (e) => { current = e.target.value; syncBase(); });
      syncBase();
    };
    coords.addEventListener('input', syncBase);
    const regionSel = $('#uForm select[name="region"]');
    if (regionSel) regionSel.addEventListener('change', loadBases);
    loadBases();
  }
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
      const syncLimit = () => { const on = unl.checked; amt.disabled = on; wrap.hidden = on; if (on) amt.value = ''; };
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
      const baseChoice = String(fd.get('base_id') || '');
      if (baseChoice === 'custom') {
        payload.base_id = null;
        payload.base_name = String(fd.get('base_name') || '').trim();
        payload.base_coords = String(fd.get('base_coords') || '').trim();
      } else if ($('#ueBasePick select[name="base_id"]')) {
        payload.base_id = baseChoice ? Number(baseChoice) : null;
      }
      payload.can_mark_paid = fd.get('can_mark_paid') === 'on';
      payload.allow_advance = fd.get('allow_advance') === 'on';
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
  const canCreate = uCan('create_accounts');
  openModal(`
    <div class="modal-head ma-head">
      <div class="ma-head-text">
        <h2>${esc(t('Manage accounts'))}</h2>
        <p class="rg-sub">${esc(teamScopeCopy())}</p>
      </div>
      <div class="rg-head-acts">
        ${canCreate ? `<button type="button" class="btn btn-primary btn-sm" id="maAddUserBtn">${esc(t('+ Add user'))}</button>` : ''}
        <button class="x-btn">×</button>
      </div>
    </div>
    <div class="modal-body" id="maBody">
      <p class="ma-desc-body clamp-desc">${esc(teamScopeCopy())}</p>
      <div class="team-mount"><p class="muted" style="padding:20px 0">${esc(t('Loading…'))}</p></div>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex', 'modal-ma');
  $('#modal .x-btn').addEventListener('click', closeModal);
  const addBtn = $('#maAddUserBtn');
  if (addBtn) addBtn.addEventListener('click', () => openDelegatedUserForm());
  renderManageAccounts();
}

async function renderManageAccounts() {
  const body = $('#maBody');
  let users;
  try { ({ users } = await api('/users')); }
  catch (ex) { body.querySelector('.team-mount').innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  // Keep the approver-combo / creatable-position helpers fed while this modal is
  // open (they read settingsState); the delegated create form reuses them.
  settingsState.users = users;
  paintTeam(body, users, renderManageAccounts);
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
  const initials = String(u.full_name || u.username || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  openModal2(`
    <div class="modal-head">
      <h2>${esc(t('Reset password'))}</h2>
      <button type="button" class="x-btn" id="rpClose">×</button>
    </div>
    <div class="modal-body">
    <form id="rpForm" class="form">
      <div class="rp-who">
        <span class="ue-avatar" aria-hidden="true">${esc(initials)}</span>
        <div class="rp-who-text"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub mono">${esc(u.username)}</div></div>
      </div>
      <label>${esc(t('New password'))}
        <div class="pw-wrap">
          <input name="password" type="password" required minlength="8" autocomplete="new-password" />
          <button type="button" class="pw-toggle" aria-label="${esc(t('Show password'))}">👁</button>
        </div>
        <span class="rp-hint">${esc(t('At least 8 characters. Share it with them privately — they can change it after signing in.'))}</span></label>
      <p class="form-error" id="rpErr" hidden></p>
      <div class="modal-actions rp-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="rpCancel">${esc(t('Cancel'))}</button>
        <button type="submit" class="btn btn-primary btn-sm">${esc(t('Reset password'))}</button>
      </div>
    </form>
    </div>`);
  $('#modal2').classList.add('modal-rp');
  setTimeout(() => { const i = $('#rpForm [name="password"]'); if (i) i.focus(); }, 50);
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
