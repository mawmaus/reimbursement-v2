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
  lookups: { departments: [], expense_types: [] },
  // Ticked claims for PDF export, keyed "type:id" (the two claim types can
  // share numeric ids, so the type must be part of the key).
  selected: new Set()
};
const claimKey = (type, id) => `${type}:${id}`;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(pathName, opts = {}) {
  const res = await fetch('/api' + pathName, {
    credentials: 'same-origin',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts
  });
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
function money(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'IDR' }).format(amount);
  } catch { return `${currency || ''} ${Number(amount).toLocaleString()}`; }
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
// Render a timestamp in Jakarta time (WIB, GMT+7) as "YYYY-MM-DD HH:MM WIB".
// Server timestamps arrive as UTC ISO strings; anything unparseable falls back
// to a plain trim so we never render "Invalid Date".
function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.replace('T', ' ').slice(0, 16);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} WIB`;
}
// Today's date (YYYY-MM-DD) in Jakarta time — used to default date pickers so a
// late-evening entry doesn't roll to "tomorrow" via UTC.
function todayWIB() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
const STATUS_LABEL = { submitted: 'Pending review', approved: 'Approved', rejected: 'Rejected', paid: 'Paid' };

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
  try {
    const { user } = await api('/me');
    state.user = user;
    showApp();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginForm').hidden = false;
  $('#loginHint').textContent =
    'Need an account, or forgot your username or password? Contact your manager.';
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  const u = state.user;
  // Role is intentionally not shown in the UI after login.
  $('#userBadge').innerHTML = `${esc(u.full_name)}`;
  // "Purpose" buttons are gated per department + job position (see Settings).
  const purposes = u.purposes || { claim: false, meal: false };
  $('#newClaimBtn').hidden = !purposes.claim;
  $('#newMealBtn').hidden = !purposes.meal;
  const isSuper = u.role === 'superadmin';
  const isAdmin = u.role === 'admin';
  // Export CSV: superadmins and admins. Settings (lookups): superadmins only.
  $('#exportBtn').hidden = !(isSuper || isAdmin);
  $('#settingsBtn').hidden = !isSuper;
  // "Manage accounts": shown to non-superadmins whose position may manage their
  // team's accounts (reset password / enable-disable). Account CREATION lives in
  // Settings and is super-admin only. Superadmins use full Settings instead.
  $('#accountsBtn').hidden = !(!isSuper && u.can_manage_accounts);
  // Only super admins can delete claims (used to clear out test data).
  $('#deleteSelBtn').hidden = !isSuper;
  // Land on the clean menu; a tile opens the corresponding list.
  state.view = 'home';
  $('#homeView').hidden = false;
  $('#listView').hidden = true;
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
    const [d, e] = await Promise.all([api('/departments'), api('/expense-types')]);
    state.lookups.departments = (d.items || []).filter(i => i.active).map(i => i.name);
    state.lookups.expense_types = (e.items || []).filter(i => i.active).map(i => i.name);
  } catch { /* form falls back to free text */ }
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
    showApp();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  state.user = null; state.claims = [];
  showLogin();
});
$('#backHome').addEventListener('click', goHome);

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

const totalCardLabel = () => anyFilterActive() ? 'Filtered total' : 'Total value';

// The summary cards describe exactly the rows currently in view, so they track
// every active filter (status, department, search, claimant). Both claim types
// share one ledger, so visibleClaims already spans reimbursement + meal.
function renderSummaryCards() {
  const claims = visibleClaims();
  const count = st => claims.filter(c => c.status === st).length;
  const total = claims.reduce((sum, c) => sum + Number(rowView(c).amount || 0), 0);
  // status key doubles as the filter value; the total card is display-only.
  const cards = [
    { k: 'submitted', l: 'Pending', n: count('submitted'), status: 'submitted' },
    { k: 'approved', l: 'Approved', n: count('approved'), status: 'approved' },
    { k: 'rejected', l: 'Rejected', n: count('rejected'), status: 'rejected' },
    { k: 'paid', l: 'Paid', n: count('paid'), status: 'paid' },
    { k: 'total', l: totalCardLabel(), n: money(total, 'IDR') }
  ];
  $('#summaryCards').innerHTML = cards.map(c => {
    if (!c.status) {
      return `<div class="card ${c.k}"><div class="card-n">${esc(c.n)}</div><div class="card-l">${esc(c.l)}</div></div>`;
    }
    const active = state.filters.status === c.status;
    const hint = active ? `Clear ${c.l.toLowerCase()} filter` : `Show only ${c.l.toLowerCase()} claims`;
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
  if (sel) sel.value = state.filters.status;
  loadClaims();
}

async function loadClaims() {
  const p = new URLSearchParams();
  if (state.filters.status) p.set('status', state.filters.status);
  if (state.filters.department) p.set('department', state.filters.department);
  if (state.filters.q) p.set('q', state.filters.q);
  const qs = p.toString();
  // Reimbursement + meal allowance claims share one ledger. Tag each with a
  // type so rows, the drawer, and actions can branch to the right endpoints.
  const [r, m] = await Promise.all([api('/claims?' + qs), api('/meal-claims?' + qs)]);
  const reimb = (r.claims || []).map(c => ({ ...c, type: 'reimbursement' }));
  const meal = (m.claims || []).map(c => ({ ...c, type: 'meal' }));
  state.claims = [...reimb, ...meal].sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  // Drop selections for claims no longer in the current view.
  const avail = new Set(state.claims.map(c => claimKey(c.type, c.id)));
  [...state.selected].forEach(k => { if (!avail.has(k)) state.selected.delete(k); });
  renderDeptOptions();
  renderClaimantOptions();
  renderClaims();
  renderHome(); // keep the landing menu counts / approval badge in sync
}

// Uniform row display fields for the two claim types.
function rowView(c) {
  if (c.type === 'meal') {
    const first = (c.lines && c.lines[0] && c.lines[0].line_date) || (c.created_at || '').slice(0, 10);
    // Meal claims carry a "DB number site" per line; surface the first one.
    const site = (c.lines && c.lines[0] && c.lines[0].site) || '';
    return { typeLabel: 'Meal allowance', date: first, amount: c.total_amount, db: site };
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
}

// Is it currently THIS user's turn to approve claim c? (The pending approver at
// the current step.) Role-agnostic: a super admin only matches claims where
// they are explicitly the current approver, not every claim.
function isMyTurn(c) {
  if (!state.user || c.status !== 'submitted') return false;
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
  return false;
}
const approvedByMeQueue = () => state.claims.filter(approvedByMe);

// Claims for the open view, before the client-side claimant filter.
function viewClaims() {
  if (state.view === 'mine') return myClaims();
  if (state.view === 'approval') return approvalQueue();
  if (state.view === 'approved') return approvedByMeQueue();
  return state.claims; // 'all' / 'home'
}

// Rows currently shown, after the client-side claimant filter.
function visibleClaims() {
  const cl = state.filters.claimant;
  const base = viewClaims();
  return cl ? base.filter(c => c.claimant_name === cl) : base;
}

// --- Home menu (clean landing) ----------------------------------------------
const VIEW_LABEL = { mine: 'My claims', approval: 'Needs my approval', approved: 'Approved by me', all: 'All activities' };
const VIEW_EMPTY = {
  mine: 'You have not submitted any claims yet.',
  approval: 'Nothing is waiting for your approval right now.',
  approved: 'You have not approved any claims that are still open to revert.',
  all: 'No claims in the system yet.'
};
function renderHome() {
  const menu = $('#homeMenu');
  if (!menu || !state.user) return;
  const u = state.user;
  $('#homeGreeting').textContent = u.full_name ? `Hi ${u.full_name.split(' ')[0]} — what would you like to open?` : '';
  const need = approvalQueue().length;
  const mine = myClaims().length;
  const approved = approvedByMeQueue().length;
  const tiles = [
    { key: 'mine', title: 'My claims', desc: 'Claims you have submitted', count: mine },
    { key: 'approval', title: 'Needs my approval', desc: 'Claims waiting for your decision', count: need, badge: true },
    // The revert safety net: claims I signed off that I can still undo. Shown
    // alongside "Needs my approval" (both are approver-facing) so a mis-approval
    // is always one click away from being reverted.
    { key: 'approved', title: 'Approved by me', desc: 'Claims you approved — revert if needed', count: approved }
  ];
  if (u.role === 'superadmin') tiles.push({ key: 'all', title: 'All activities', desc: 'Every claim in the system', count: state.claims.length });
  menu.innerHTML = tiles.map(t => `
    <button class="home-tile" data-view="${t.key}" type="button">
      ${t.badge && t.count > 0 ? `<span class="tile-badge" aria-label="${t.count} awaiting approval">${t.count > 99 ? '99+' : t.count}</span>` : ''}
      <span class="tile-title">${esc(t.title)}</span>
      <span class="tile-desc">${esc(t.desc)}</span>
      <span class="tile-count">${t.count} ${t.count === 1 ? 'claim' : 'claims'}</span>
    </button>`).join('');
  $$('.home-tile', menu).forEach(el => el.addEventListener('click', () => openView(el.dataset.view)));
}

// Open one list view; go back to the clean menu.
function openView(key) {
  state.view = key;
  state.selected.clear();
  $('#homeView').hidden = true;
  $('#listView').hidden = false;
  $('#listTitle').textContent = VIEW_LABEL[key] || 'Claims';
  renderClaims();
}
function goHome() {
  state.view = 'home';
  // Clean slate: clear filters so the menu counts reflect everything.
  state.filters = { status: '', department: '', claimant: '', q: '' };
  const si = $('#searchInput'); if (si) si.value = '';
  const sf = $('#statusFilter'); if (sf) sf.value = '';
  $('#listView').hidden = true;
  $('#homeView').hidden = false;
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
    empty.textContent = anyFilterActive() ? 'No claims match your filters.' : (VIEW_EMPTY[state.view] || 'No claims yet.');
    empty.hidden = false;
    updateSelectionUI(); renderSummaryCards(); return;
  }
  $('#emptyState').hidden = true;
  wrap.innerHTML = claims.map(c => {
    const v = rowView(c);
    const checked = state.selected.has(claimKey(c.type, c.id)) ? 'checked' : '';
    return `
    <div class="ledger-row" data-id="${c.id}" data-type="${c.type}" tabindex="0" role="button">
      <span class="row-spine ${c.status}"></span>
      <span class="col-check"><input type="checkbox" class="row-check" data-id="${c.id}" data-type="${c.type}" ${checked} aria-label="Select ${esc(c.claim_no)}" /></span>
      <span class="col-no">${esc(c.claim_no)}</span>
      <span class="col-name">${esc(c.claimant_name)}</span>
      <span class="col-db mono">${esc(v.db) || '—'}</span>
      <span class="col-type">${esc(v.typeLabel)}</span>
      <span class="col-date mono">${esc(v.date)}</span>
      <span class="col-amt">${esc(money(v.amount, c.currency))}</span>
      <span class="col-status"><span class="pill ${c.status}">${STATUS_LABEL[c.status]}</span></span>
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
  $('#selCount').textContent = `${n} claim${n === 1 ? '' : 's'} selected`;
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

// Super-admin bulk delete — permanently removes the ticked claims (both types).
async function deleteSelected() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  if (!chosen.length) return;
  if (!confirm(`Permanently delete ${chosen.length} claim${chosen.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const btn = $('#deleteSelBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    for (const c of chosen) {
      const path = c.type === 'meal' ? '/meal-claims/' : '/claims/';
      await api(path + c.id, { method: 'DELETE' });
    }
    state.selected.clear();
    toast(`Deleted ${chosen.length} claim${chosen.length === 1 ? '' : 's'}`);
    loadAll();
  } catch (ex) { toast(ex.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

async function generatePdf() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  if (!chosen.length) return;
  const btn = $('#genPdfBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    // Pull full details (approvers, history, attachment list) for each claim.
    const detailed = [];
    for (const c of chosen) {
      const path = c.type === 'meal' ? '/meal-claims/' : '/claims/';
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
    toast(`PDF ready — ${detailed.length} claim${detailed.length === 1 ? '' : 's'}`);
  } catch (ex) {
    toast(ex.message || 'Could not generate PDF', true);
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
    const hh = 19, rh = 18;
    need(hh + rh);
    y -= hh;
    page.drawRectangle({ x: M, y, width: CW, height: hh, color: rgb(0.96, 0.96, 0.94) });
    let x = M;
    cols.forEach(c => { page.drawText(pdfSafe(c.title), { x: x + 5, y: y + 6, size: 7.5, font: bold, color: muted }); x += c.w; });
    const drawRow = (cells, bg) => {
      need(rh); y -= rh;
      if (bg) page.drawRectangle({ x: M, y, width: CW, height: rh, color: bg });
      let cx = M;
      cols.forEach((col, i) => {
        const cell = cells[i] == null ? '' : cells[i];
        const val = pdfSafe(typeof cell === 'object' ? (cell.text != null ? cell.text : '') : cell);
        const f = (typeof cell === 'object' && cell.bold) ? bold : font;
        const color = (typeof cell === 'object' && cell.color) || ink;
        const tx = col.align === 'right' ? cx + col.w - 5 - f.widthOfTextAtSize(val, 9) : cx + 5;
        page.drawText(val, { x: tx, y: y + 5, size: 9, font: f, color });
        cx += col.w;
      });
      page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
    };
    rows.forEach(r => drawRow(r));
    if (footer) drawRow(footer, rgb(0.98, 0.965, 0.945));
  };

  const claimHeader = (c) => {
    newPage();
    const title = c.type === 'meal' ? 'Meal Allowance Claim' : 'Reimbursement Claim';
    if (logo) { const lw = 104, lh = lw * 213 / 631; page.drawImage(logo, { x: M, y: H - M - lh, width: lw, height: lh }); }
    else page.drawText('Cibes', { x: M, y: H - M - 20, size: 22, font: bold, color: orange });
    const rx = M + 128;
    page.drawText(title, { x: rx, y: H - M - 8, size: 16, font: bold, color: ink });
    page.drawText(`${pdfSafe(c.claim_no)}   ${(STATUS_LABEL[c.status] || c.status).toUpperCase()}`,
      { x: rx, y: H - M - 26, size: 9.5, font: bold, color: stColor[c.status] || muted });
    page.drawText(`Submitted ${fmtDateTime(c.created_at)}`, { x: rx, y: H - M - 40, size: 8.5, font, color: muted });
    y = H - M - 58;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.5, color: orange });
    y -= 6;
  };

  const drawDetails = (c) => {
    if (c.type === 'meal') {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      section('Meal allowance lines');
      const cols = [
        { title: 'Date', w: 70 }, { title: 'DB Number Site', w: 120 }, { title: 'Job Category', w: 90 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Description', w: CW - 360 }
      ];
      const rows = (c.lines || []).map(l => [l.line_date, l.site, l.job_category, money(l.amount, c.currency), l.description]);
      table(cols, rows.length ? rows : [['', '', 'No lines', '', '']],
        [{ text: 'TOTAL', bold: true }, '', '', { text: money(c.total_amount, c.currency), bold: true, align: 'right' }, '']);
    } else {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Expense type', c.expense_type, 'Expense date', c.expense_date);
      if (c.db_no) kvRow('DB No.', c.db_no);
      need(20); y -= 13;
      page.drawText('Amount', { x: M, y, size: 8, font, color: muted });
      page.drawText(pdfSafe(money(c.amount, c.currency)), { x: M + 84, y, size: 13, font: bold, color: ink });
      y -= 8;
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      if (c.description) kvWide('Description', c.description);
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
        const res = await fetch(`/api/claims/${c.id}/attachments/${att.id}`, { credentials: 'same-origin' });
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
    const atts = c.attachments || [];
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
function closeDrawer() { $('#drawer').hidden = true; $('#drawerScrim').hidden = true; }
$('#drawerScrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });

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
const STEP_STATE_LABEL = { done: 'Approved', current: 'Pending', rejected: 'Rejected', pending: 'Upcoming' };

// --- Shared drawer builders (both claim types share these shapes) ------------
function renderChainProgress(c) {
  if (!c.approvers || !c.approvers.length) return '';
  return `
    <div class="section-label">Approval chain</div>
    <ol class="chain-progress">
      ${c.approvers.map((a, idx) => {
        const st = stepStateFor(c, idx + 1);
        return `<li class="cp ${st}">
          <span class="cp-dot">${st === 'done' ? '✓' : (st === 'rejected' ? '×' : idx + 1)}</span>
          <div class="cp-body"><div class="cp-label">${esc(a.name)}</div></div>
          <span class="cp-state">${STEP_STATE_LABEL[st]}</span></li>`;
      }).join('')}
    </ol>`;
}
function renderHistory(c) {
  return `
    <div class="section-label">History</div>
    <ul class="timeline">
      ${c.history.map(h => `
        <li><span class="t-action">${esc(h.action)}</span>
          <div class="t-meta">${esc(h.actor_name)} · ${fmtDateTime(h.created_at)}</div>
          ${h.comment ? `<div class="t-comment">${esc(h.comment)}</div>` : ''}</li>`).join('')}
    </ul>`;
}
// Whether the current user may revert (undo one step of) this claim, mirroring
// the server's planRevert: the payer can unpay, the final approver can unapprove,
// the previous-step approver can undo their approval, and the claimant can cancel
// a still-pending submission back to an editable state.
function canRevert(c, u, isOwner) {
  const ids = (c.approvers || []).map(a => a.id);
  const step = c.current_step || 0;
  const isSuper = u.role === 'superadmin';
  if (c.status === 'paid') return isSuper || !!u.can_mark_paid;
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
  if (c.status === 'paid') return { label: 'Revert payment', confirm: 'Revert this payment? The claim will go back to Approved.' };
  if (c.status === 'approved') return { label: 'Revert approval', confirm: 'Revert your approval? The claim will go back to pending review.' };
  if (c.status === 'submitted' && step > 1) return { label: 'Revert approval', confirm: 'Revert your approval? The claim will return to the previous approver.' };
  return { label: 'Cancel to edit', confirm: 'Cancel this submission so you can edit it? It will move to Rejected, ready to edit and resubmit.' };
}
function buildActions(c, u, isOwner) {
  const btns = [];
  if (c.status === 'submitted' && canApprove(u, c)) {
    btns.push(`<button class="btn btn-approve" data-act="approve">Approve</button>`);
    btns.push(`<button class="btn btn-danger" data-act="reject">Reject &amp; return</button>`);
  }
  if ((u.role === 'superadmin' || u.can_mark_paid) && c.status === 'approved') {
    btns.push(`<button class="btn btn-primary" data-act="paid">Mark as paid</button>`);
  }
  if (isOwner && c.status === 'rejected') {
    btns.push(`<button class="btn btn-primary" data-act="edit">Edit &amp; resubmit</button>`);
  }
  if (canRevert(c, u, isOwner)) {
    btns.push(`<button class="btn btn-ghost" data-act="revert">${revertInfo(c).label}</button>`);
  }
  return btns.join('\n            ');
}

// Body for a reimbursement claim: key/value details + attachments.
function reimbursementBody(c) {
  const attachments = c.attachments.length ? `
    <div class="section-label">Attachments</div>
    <ul class="attach-list">
      ${c.attachments.map(a => `
        <li><a href="/api/claims/${c.id}/attachments/${a.id}" target="_blank" rel="noopener">
          📎 <span>${esc(a.original_name)}</span><span class="fsize">${fmtBytes(a.size_bytes)}</span></a></li>`).join('')}
    </ul>` : '<div class="section-label">Attachments</div><p class="muted">None uploaded.</p>';
  return `
    <dl class="kv">
      <dt>Claimant</dt><dd>${esc(c.claimant_name)}</dd>
      <dt>Department</dt><dd>${esc(c.department)}</dd>
      ${c.db_no ? `<dt>DB No.</dt><dd>${esc(c.db_no)}</dd>` : ''}
      <dt>Expense type</dt><dd>${esc(c.expense_type)}</dd>
      <dt>Expense date</dt><dd>${esc(c.expense_date)}</dd>
      <dt>Amount</dt><dd class="amt">${esc(money(c.amount, c.currency))}</dd>
      <dt>Recipient</dt><dd>${esc(c.recipient_name)}</dd>
      <dt>Bank</dt><dd>${esc(c.bank_name)}</dd>
      <dt>Account no.</dt><dd class="mono">${esc(c.bank_account_no)}</dd>
      ${c.description ? `<dt>Description</dt><dd>${esc(c.description)}</dd>` : ''}
    </dl>
    ${attachments}`;
}

// Body for a meal allowance claim: account/bank details + the line-item table.
function mealBody(c) {
  const rows = (c.lines || []).map(l => `
    <tr>
      <td class="mono" data-label="Date">${esc(l.line_date)}</td>
      <td data-label="DB Number Site">${esc(l.site)}</td>
      <td data-label="Job Category">${esc(l.job_category)}</td>
      <td class="meal-amt" data-label="Amount">${esc(money(l.amount, c.currency))}</td>
      <td data-label="Additional Description">${esc(l.description)}</td>
    </tr>`).join('');
  return `
    <dl class="kv">
      <dt>Claimant</dt><dd>${esc(c.claimant_name)}</dd>
      ${c.department ? `<dt>Department</dt><dd>${esc(c.department)}</dd>` : ''}
      <dt>Recipient</dt><dd>${esc(c.recipient_name)}</dd>
      <dt>Bank</dt><dd>${esc(c.bank_name)}</dd>
      <dt>Account no.</dt><dd class="mono">${esc(c.bank_account_no)}</dd>
    </dl>
    <div class="section-label">Meal allowance lines</div>
    <div class="meal-table-wrap">
      <table class="meal-table">
        <thead><tr><th>Date</th><th>DB Number Site</th><th>Job Category</th><th>Amount</th><th>Additional Description</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted" style="padding:12px">No lines.</td></tr>'}</tbody>
        <tfoot><tr>
          <td colspan="3" class="meal-total-label">TOTAL CLAIM MEAL ALLOWANCE</td>
          <td class="meal-total">${esc(money(c.total_amount, c.currency))}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>`;
}

async function openDrawer(id, type = 'reimbursement') {
  const path = type === 'meal' ? '/meal-claims/' : '/claims/';
  const { claim: c } = await api(path + id);
  c.type = type;
  const u = state.user;
  const isOwner = c.employee_id === u.id;

  const rejectedNote = (c.status === 'rejected' && c.manager_comment) ? `
    <div class="note-box"><div class="nb-label">Returned by manager</div>
      <div>${esc(c.manager_comment)}</div></div>` : '';
  const body = type === 'meal' ? mealBody(c) : reimbursementBody(c);
  const actions = buildActions(c, u, isOwner);

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div><h2>${esc(c.claim_no)} <span class="pill ${c.status}">${STATUS_LABEL[c.status]}</span></h2>
        <p class="muted" style="margin:4px 0 0;font-size:.85rem">Submitted ${fmtDateTime(c.created_at)}</p></div>
      <button class="x-btn" aria-label="Close">×</button>
    </div>
    <div class="drawer-body">
      ${rejectedNote}
      ${body}
      ${renderChainProgress(c)}
      ${renderHistory(c)}
      <div class="drawer-actions">${actions || '<span class="muted" style="font-size:.85rem">No actions available for your role at this stage.</span>'}</div>
    </div>`;

  $('#drawer .x-btn').addEventListener('click', closeDrawer);
  $$('#drawer [data-act]').forEach(b => b.addEventListener('click', () => handleAction(b.dataset.act, c)));

  $('#drawerScrim').hidden = false;
  $('#drawer').hidden = false;
}

async function handleAction(act, c) {
  const base = c.type === 'meal' ? '/meal-claims/' : '/claims/';
  try {
    if (act === 'approve') {
      await api(`${base}${c.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      toast('Claim approved');
    } else if (act === 'paid') {
      return openPaidModal(c);
    } else if (act === 'revert') {
      const info = revertInfo(c);
      if (!confirm(info.confirm)) return;
      await api(`${base}${c.id}/revert`, { method: 'POST', body: JSON.stringify({}) });
      toast('Reverted');
    } else if (act === 'reject') {
      return openRejectModal(c);
    } else if (act === 'edit') {
      return c.type === 'meal' ? openMealAllowanceModal(c) : openClaimModal(c);
    }
    closeDrawer(); loadAll();
  } catch (ex) { toast(ex.message, true); }
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalScrim').hidden = false;
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modalScrim').hidden = true; $('#modal').classList.remove('modal-wide', 'modal-xwide', 'modal-flex'); }
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
}
function closeModal2() { $('#modal2').hidden = true; $('#modal2Scrim').hidden = true; $('#modal2').classList.remove('modal-wide', 'modal-xwide', 'modal-flex'); }
$('#modal2Scrim').addEventListener('click', closeModal2);

// ---------------------------------------------------------------------------
// New / Edit claim
// ---------------------------------------------------------------------------
let pendingFiles = [];

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
      <option value="" ${cur ? '' : 'selected'} disabled>Select…</option>
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
    return `<label>Type of expense<input name="expense_type" required placeholder="Travel, Meals, Supplies…" value="${esc(cur)}" /></label>`;
  }
  const isOther = !!cur && !options.some(o => o.toLowerCase() === cur.toLowerCase());
  const selectVal = isOther ? 'Others' : cur;
  return `<label>Type of expense
      <select name="expense_type" id="expType" required>
        <option value="" ${cur ? '' : 'selected'} disabled>Select…</option>
        ${options.map(o => `<option value="${esc(o)}" ${o === selectVal ? 'selected' : ''}>${esc(o)}</option>`).join('')}
        <option value="Others" ${selectVal === 'Others' ? 'selected' : ''}>Others</option>
      </select></label>
    <label class="full" id="expOtherWrap" ${isOther ? '' : 'hidden'}>Please specify the expense type
      <input name="expense_type_other" id="expOther" value="${isOther ? esc(cur) : ''}" placeholder="Enter the expense type" /></label>`;
}
function wireExpenseTypeField() {
  const sel = $('#expType');
  if (!sel) return;
  const wrap = $('#expOtherWrap'), other = $('#expOther');
  const sync = () => {
    const on = sel.value === 'Others';
    wrap.hidden = !on;
    if (other) other.required = on;
  };
  sel.addEventListener('change', () => { sync(); if (sel.value === 'Others' && other) other.focus(); });
  sync();
}

// Optional inline calculator on the claim form: a running tally that lets a
// claimant add up several receipt amounts and drop the sum into the Amount field.
function calcPanelHtml() {
  return `<div class="calc-panel" id="calcPanel" hidden>
    <div class="calc-input-row">
      <input id="calcInput" inputmode="decimal" placeholder="Add an amount…" />
      <button type="button" class="btn btn-ghost btn-sm" id="calcAdd">Add</button>
    </div>
    <ul class="calc-list" id="calcList"></ul>
    <div class="calc-foot">
      <div class="calc-total-wrap"><span>Total</span><strong id="calcTotal">0</strong></div>
      <div class="calc-foot-btns">
        <button type="button" class="btn btn-ghost btn-sm" id="calcClear">Clear</button>
        <button type="button" class="btn btn-primary btn-sm" id="calcApply">Use total</button>
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
             <button type="button" data-i="${i}" aria-label="Remove">×</button></li>`).join('')
      : `<li class="calc-empty">No amounts added yet.</li>`;
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

function openClaimModal(existing = null) {
  const u = state.user;
  const isEdit = !!existing;
  pendingFiles = [];
  const v = existing || {
    claimant_name: u.full_name,
    // Only prefill the department if it is a registered one; otherwise leave it
    // for the user to pick from the list.
    department: state.lookups.departments.includes(u.department) ? u.department : '',
    currency: 'IDR',
    expense_date: todayWIB()
  };
  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? 'Edit &amp; resubmit claim' : 'New reimbursement claim'}</h2>
      <button class="x-btn" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form id="claimForm" class="form">
        <div class="grid2">
          <label>Date<input name="expense_date" type="date" required value="${esc(v.expense_date || '')}" /></label>
          <label>DB No.<input name="db_no" value="${esc(v.db_no || '')}" placeholder="DB 500 309" /></label>
          ${expenseTypeField(v.expense_type)}
          <label>Amount
            <div class="amount-field">
              <span class="amount-cur">${esc(v.currency || 'IDR')}</span>
              <input type="hidden" name="currency" value="${esc(v.currency || 'IDR')}" />
              <input name="amount" required inputmode="decimal" placeholder="0" value="${existing ? existing.amount : ''}" />
              <button type="button" class="amount-calc-btn" id="calcToggle" aria-expanded="false"
                aria-controls="calcPanel" title="Add up amounts">🧮</button>
            </div>
            ${calcPanelHtml()}
          </label>
          <label class="full">Description / purpose
            <textarea name="description" placeholder="What was this purchase for?">${esc(v.description || '')}</textarea>
          </label>
          ${isEdit ? `<label class="full">Note to manager (optional)
            <input name="resubmit_note" placeholder="What you changed since the rejection" /></label>` : ''}
          <div class="full">
            <div class="section-label" style="margin-top:4px">Receipts / files</div>
            <div class="drop" id="dropZone">
              <strong>Click to choose files</strong> or drag &amp; drop<br>
              <span style="font-size:.8rem">PDF or images only · up to 8 files · 10 MB each (large images auto-compressed)</span>
              <input id="fileInput" type="file" multiple hidden
                accept=".pdf,image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif" />
            </div>
            <div class="file-chips" id="fileChips"></div>
          </div>
        </div>
        <p class="form-error" id="claimError" hidden></p>
        <div class="modal-actions sticky-foot">
          <button type="button" class="btn btn-ghost" id="cancelClaim">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Resubmit claim' : 'Submit claim'}</button>
        </div>
      </form>
    </div>`);

  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#cancelClaim').addEventListener('click', closeModal);

  const fileInput = $('#fileInput'), drop = $('#dropZone');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); addFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => addFiles(fileInput.files));

  attachAmountGrouping($('#claimForm [name="amount"]'));
  wireExpenseTypeField();
  wireClaimCalculator();
  $('#claimForm').addEventListener('submit', e => submitClaim(e, existing));
}

// Only PDFs and images are accepted. The <input accept> covers the file picker,
// but drag & drop bypasses it, so validate by MIME type (falling back to the
// extension when the browser doesn't report one).
function isAllowedUpload(f) {
  if (f.type) return f.type === 'application/pdf' || f.type.startsWith('image/');
  return /\.(pdf|jpe?g|png|gif|webp|heic|heif|bmp|tiff?|svg)$/i.test(f.name);
}
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB

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

async function addFiles(list) {
  for (const f of Array.from(list)) {
    if (pendingFiles.length >= 8) { toast('Maximum 8 files', true); break; }
    if (!isAllowedUpload(f)) { toast(`${f.name}: only PDF or image files are allowed`, true); continue; }
    let file = f;
    // iPhone HEIC/HEIF photos aren't viewable in browsers, so convert them to
    // JPEG up front (regardless of size) before the 10 MB check below.
    if (isHeic(file)) {
      toast(`Converting ${f.name}…`);
      try { file = await heicToJpeg(file); }
      catch { toast(`${f.name}: couldn't read this iPhone photo`, true); continue; }
    }
    if (file.size > MAX_UPLOAD) {
      // Images can be re-compressed to fit; PDFs and animated GIFs can't, so
      // those are still rejected when over the limit.
      const compressible = file.type && file.type.startsWith('image/') && file.type !== 'image/gif';
      if (!compressible) { toast(`${f.name} exceeds 10 MB`, true); continue; }
      toast(`Compressing ${f.name}…`);
      try { file = await compressImage(file, MAX_UPLOAD); }
      catch { toast(`${f.name}: couldn't compress — please shrink it and retry`, true); continue; }
      if (file.size > MAX_UPLOAD) { toast(`${f.name}: still over 10 MB after compressing`, true); continue; }
      toast(`${f.name} compressed to fit`);
    }
    pendingFiles.push(file);
  }
  renderChips();
}
function renderChips() {
  $('#fileChips').innerHTML = pendingFiles.map((f, i) =>
    `<span class="file-chip">${esc(f.name)} <button type="button" data-i="${i}" aria-label="Remove">×</button></span>`).join('');
  $$('#fileChips button').forEach(b => b.addEventListener('click', () => {
    pendingFiles.splice(+b.dataset.i, 1); renderChips();
  }));
}

async function submitClaim(e, existing) {
  e.preventDefault();
  const err = $('#claimError'); err.hidden = true;
  const fd = new FormData(e.target);
  // Resolve an "Others" expense type to the free-text value the user entered.
  if (fd.get('expense_type') === 'Others') {
    const other = String(fd.get('expense_type_other') || '').trim();
    if (!other) { err.textContent = 'Please specify the expense type.'; err.hidden = false; return; }
    fd.set('expense_type', other);
  }
  fd.delete('expense_type_other');
  pendingFiles.forEach(f => fd.append('files', f));
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    if (existing) {
      await api('/claims/' + existing.id, { method: 'PUT', body: fd });
      toast('Claim resubmitted');
    } else {
      await api('/claims', { method: 'POST', body: fd });
      toast('Claim submitted');
    }
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false; btn.disabled = false;
  }
}

$('#newClaimBtn').addEventListener('click', () => openClaimModal());

// ---------------------------------------------------------------------------
// New meal allowance — a line-item claim form mirroring the paper
// "Meal Allowance Claim Form": a title, an editable table (one row per day),
// a live total, and the rate note at the bottom.
// ---------------------------------------------------------------------------
// Indonesian rupiah, no decimals — "Rp 120.000".
function idr(n) {
  try { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0); }
  catch { return 'Rp ' + Math.round(n || 0).toLocaleString('id-ID'); }
}
const mealAmount = (s) => { const n = Number(String(s == null ? '' : s).replace(/[^0-9]/g, '')); return Number.isFinite(n) ? n : 0; };

// The two fixed meal-allowance rates (see the note at the bottom of the form):
// Bodetabek area 75.000, outside Bodetabek 120.000. Amount is chosen from these.
const MEAL_RATES = [75000, 120000];
function mealAmountSelect(val) {
  const cur = mealAmount(val);
  // Preserve any legacy/custom amount from an older claim so editing never
  // silently drops it — show it as an extra selected option.
  const opts = [...MEAL_RATES];
  if (cur && !opts.includes(cur)) opts.unshift(cur);
  return `<select name="amount" class="meal-amt">
    <option value="" ${cur ? '' : 'selected'}>— select —</option>
    ${opts.map(n => `<option value="${n}" ${cur === n ? 'selected' : ''}>${groupAmount(String(n))}</option>`).join('')}
  </select>`;
}

let mealRows = [];
function mealRowHtml(r, i) {
  return `<tr data-i="${i}">
    <td data-label="Date"><input name="date" type="date" value="${esc(r.date || '')}" /></td>
    <td data-label="DB Number Site"><input name="site" value="${esc(r.site || '')}" placeholder="DB 500 309" /></td>
    <td data-label="Job Category"><input name="category" value="${esc(r.category || '')}" placeholder="Install / Repair / Service…" /></td>
    <td data-label="Amount">${mealAmountSelect(r.amount)}</td>
    <td data-label="Additional Description"><input name="desc" value="${esc(r.desc || '')}" placeholder="Surabaya" /></td>
    <td class="meal-x"><button type="button" class="x-btn" data-rm="${i}" aria-label="Remove row">×</button></td>
  </tr>`;
}
function readMealRows() {
  mealRows = $$('#mealRows tr').map(tr => ({
    date: tr.querySelector('[name="date"]').value,
    site: tr.querySelector('[name="site"]').value,
    category: tr.querySelector('[name="category"]').value,
    amount: tr.querySelector('[name="amount"]').value,
    desc: tr.querySelector('[name="desc"]').value
  }));
}
function mealTotal() { return mealRows.reduce((s, r) => s + mealAmount(r.amount), 0); }
function renderMealRows() {
  $('#mealRows').innerHTML = mealRows.length
    ? mealRows.map(mealRowHtml).join('')
    : `<tr><td colspan="6" class="muted" style="padding:14px;text-align:center">No rows yet — add one below.</td></tr>`;
  $('#mealTotal').textContent = idr(mealTotal());
  $$('#mealRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    readMealRows(); mealRows.splice(+b.dataset.rm, 1); renderMealRows();
  }));
  $$('#mealRows .meal-amt').forEach(sel => sel.addEventListener('change', () => {
    readMealRows(); $('#mealTotal').textContent = idr(mealTotal());
  }));
}

function openMealAllowanceModal(existing = null) {
  const isEdit = !!existing;
  if (isEdit) {
    // Prefill from the claim being resubmitted.
    mealRows = (existing.lines || []).map(l => ({
      date: l.line_date, site: l.site, category: l.job_category,
      amount: l.amount != null ? Math.round(l.amount) : '', desc: l.description
    }));
    if (!mealRows.length) mealRows = [{ date: '', site: '', category: '', amount: '', desc: '' }];
  } else {
    // Start with a handful of blank rows, like the paper form.
    mealRows = Array.from({ length: 5 }, () => ({ date: '', site: '', category: '', amount: '', desc: '' }));
  }
  openModal(`
    <div class="modal-head">
      <h2>${isEdit ? 'Edit &amp; resubmit meal allowance' : 'Meal Allowance Claim Form'}</h2>
      <button class="x-btn" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <form id="mealForm" class="form">
        <div class="meal-topbar">
          <button type="button" class="btn btn-brand-soft btn-sm" id="mealAddRow">+ Add row</button>
        </div>
        <p class="form-error" id="mealError" hidden></p>
        <div class="meal-scroll">
          <div class="meal-table-wrap">
            <table class="meal-table">
              <thead>
                <tr>
                  <th>Date</th><th>DB Number Site</th><th>Job Category</th>
                  <th>Amount</th><th>Additional Description</th><th aria-label="Remove"></th>
                </tr>
              </thead>
              <tbody id="mealRows"></tbody>
              <tfoot>
                <tr>
                  <td colspan="3" class="meal-total-label">TOTAL CLAIM MEAL ALLOWANCE</td>
                  <td class="meal-total" id="mealTotal">Rp 0</td>
                  <td colspan="2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
          ${isEdit ? `<label class="full" style="margin-top:10px">Note to manager (optional)
            <input name="resubmit_note" placeholder="What you changed since the rejection" /></label>` : ''}
          <div class="meal-note">
            <strong>MEAL ALLOWANCE CLAIM</strong>
            BODETABEK AREA — IDR 75.000,-
            EXCLUDE BODETABEK AREA — IDR 120.000,-
          </div>
        </div>
        <div class="modal-actions meal-foot">
          <button type="button" class="btn btn-ghost" id="mealCancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Resubmit claim' : 'Submit claim'}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#mealCancel').addEventListener('click', closeModal);
  $('#mealAddRow').addEventListener('click', () => {
    readMealRows(); mealRows.push({ date: '', site: '', category: '', amount: '', desc: '' }); renderMealRows();
  });
  $('#mealForm').addEventListener('submit', e => submitMealClaim(e, existing));
  renderMealRows();
}

async function submitMealClaim(e, existing) {
  e.preventDefault();
  readMealRows();
  const err = $('#mealError'); err.hidden = true;
  const lines = mealRows
    .filter(r => r.date || r.site || r.category || r.desc || mealAmount(r.amount))
    .map(r => ({ date: r.date, site: r.site, category: r.category, amount: mealAmount(r.amount), desc: r.desc }));
  if (!lines.length) { err.textContent = 'Add at least one line with a date and amount'; err.hidden = false; return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const payload = { lines };
  if (existing) payload.resubmit_note = (new FormData(e.target).get('resubmit_note') || '').trim();
  try {
    if (existing) {
      await api('/meal-claims/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Meal claim resubmitted');
    } else {
      await api('/meal-claims', { method: 'POST', body: JSON.stringify(payload) });
      toast('Meal claim submitted');
    }
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
}
$('#newMealBtn').addEventListener('click', () => openMealAllowanceModal());

// ---------------------------------------------------------------------------
// Reject modal
// ---------------------------------------------------------------------------
// Mark as paid — a payment date must be chosen before the claim can be recorded
// as paid. Defaults to today; the confirm button stays disabled until a date is
// present.
function openPaidModal(c) {
  const today = todayWIB();
  openModal(`
    <div class="modal-head"><h2>Mark ${esc(c.claim_no)} as paid</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="paidForm" class="form">
        <label>Payment date
          <input type="date" name="payment_date" value="${today}" max="${today}" required /></label>
        <p class="muted" style="margin:2px 0 0;font-size:.85rem">The date the payment was actually made.</p>
        <p class="form-error" id="paidErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="paidCancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="paidConfirm">Mark as paid</button>
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
    const base = c.type === 'meal' ? '/meal-claims/' : '/claims/';
    try {
      await api(`${base}${c.id}/mark-paid`, { method: 'POST', body: JSON.stringify({ payment_date }) });
      toast('Marked as paid');
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#paidErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
function openRejectModal(c) {
  openModal(`
    <div class="modal-head"><h2>Reject ${esc(c.claim_no)}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="rejectForm" class="form">
        <label>Reason for rejection (sent back to the claimant)
          <textarea name="comment" required placeholder="Explain what needs to change…"></textarea></label>
        <p class="form-error" id="rejErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="rejCancel">Cancel</button>
          <button type="submit" class="btn btn-danger">Reject &amp; return</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#rejCancel').addEventListener('click', closeModal);
  $('#rejectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const comment = new FormData(e.target).get('comment').trim();
    const base = c.type === 'meal' ? '/meal-claims/' : '/claims/';
    try {
      await api(`${base}${c.id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) });
      toast('Claim returned to claimant');
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
  try { ({ users } = await api('/users')); } catch (ex) { toast(ex.message, true); return; }
  users.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));

  openModal(`
    <div class="modal-head"><h2>Export claims to CSV</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="exportForm" class="form">
        <div class="grid2">
          <label>From date<input name="from" type="date" value="${esc(state.filters.exportFrom || '')}" /></label>
          <label>To date<input name="to" type="date" value="${esc(state.filters.exportTo || '')}" /></label>
        </div>
        <div class="section-label" style="margin-top:6px">Statuses to include</div>
        <div class="check-group">
          ${EXPORT_STATUS_OPTS.map(o => `
            <label class="check-item"><input type="checkbox" name="status" value="${o.v}" checked /> ${o.l}</label>`).join('')}
        </div>
        <div class="section-label" style="margin-top:6px">Claim types</div>
        <div class="check-group">
          <label class="check-item"><input type="checkbox" name="types" value="reimbursement" checked /> Reimbursement claims</label>
          <label class="check-item"><input type="checkbox" name="types" value="meal" checked /> Meal allowances</label>
        </div>
        <div class="section-label" style="margin-top:6px">Users (submitters)</div>
        <div class="user-filter">
          <div class="uf-toolbar">
            <input id="ufSearch" class="input" type="search" placeholder="Search names…" />
            <button type="button" class="btn btn-ghost btn-sm" id="ufAll">Select all</button>
            <button type="button" class="btn btn-ghost btn-sm" id="ufNone">Clear</button>
          </div>
          <div class="uf-list" id="ufList">
            ${users.length ? users.map(u => `
              <label class="uf-item" data-name="${esc((u.full_name + ' ' + u.username).toLowerCase())}">
                <span class="uf-name">${esc(u.full_name)} <span class="muted">(${esc(u.username)})</span></span>
                <input type="checkbox" name="employee" value="${u.id}" checked />
              </label>`).join('') : '<p class="muted" style="padding:8px">No users.</p>'}
          </div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:10px 0 0">Leave dates blank to export all dates. Dates apply to the expense / meal date.</p>
        <p class="form-error" id="exportErr" hidden></p>
        <div class="modal-actions sticky-foot">
          <button type="button" class="btn btn-ghost" id="exportCancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Download CSV</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#exportCancel').addEventListener('click', closeModal);

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
    if (!types.length) { err.textContent = 'Pick at least one claim type.'; err.hidden = false; return; }
    if (!emps.length) { err.textContent = 'Pick at least one user.'; err.hidden = false; return; }
    const from = fd.get('from'), to = fd.get('to');
    if (from && to && from > to) { err.textContent = 'The “from” date is after the “to” date.'; err.hidden = false; return; }
    const p = new URLSearchParams();
    if (statuses.length && statuses.length < EXPORT_STATUS_OPTS.length) p.set('status', statuses.join(','));
    if (types.length < 2) p.set('types', types.join(','));
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

// Bank name is picked from a short list (BCA / Others). "Others" reveals a free
// text field for the actual bank name and shows a red fee note, since any
// non-BCA payout is charged IDR 2,500. Returns the markup; wiring is done by
// wireBankNameField after the modal is in the DOM.
function bankNameField(current) {
  const cur = String(current || '').trim();
  const isBca = cur.toLowerCase() === 'bca';
  const isOther = !!cur && !isBca;
  const choice = isBca ? 'BCA' : (isOther ? 'Others' : 'BCA'); // default to BCA when unset
  return `
    <label>Bank name
      <select name="bank_choice" id="bankChoice">
        <option value="BCA" ${choice === 'BCA' ? 'selected' : ''}>BCA</option>
        <option value="Others" ${choice === 'Others' ? 'selected' : ''}>Others</option>
      </select></label>
    <label id="bankOtherWrap" ${choice === 'Others' ? '' : 'hidden'}>Bank name (please specify)
      <input name="bank_name_custom" id="bankNameCustom" value="${isOther ? esc(cur) : ''}" placeholder="Enter your bank name" /></label>
    <p class="fee-note" id="bankFeeNote" ${choice === 'BCA' ? 'hidden' : ''}>⚠ A fee of IDR 2,500 is charged for every payment to a non-BCA bank account.</p>`;
}
// Toggle the custom field + fee note as the bank choice changes. Returns a
// getter for the effective bank name to use on submit.
function wireBankNameField() {
  const choice = $('#bankChoice');
  if (!choice) return () => '';
  const wrap = $('#bankOtherWrap'), custom = $('#bankNameCustom'), note = $('#bankFeeNote');
  const sync = () => {
    const other = choice.value === 'Others';
    wrap.hidden = !other;
    note.hidden = choice.value === 'BCA';
  };
  choice.addEventListener('change', () => { sync(); if (choice.value === 'Others' && custom) custom.focus(); });
  sync();
  return () => choice.value === 'BCA' ? 'BCA' : String((custom && custom.value) || '').trim();
}

async function openProfileModal() {
  // Fetch the current values (login response omits bank details).
  let me = state.user || {};
  try { ({ user: me } = await api('/me')); } catch { /* fall back to state.user */ }
  openModal(`
    <div class="modal-head"><h2>My profile</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="profileForm" class="form">
        <div class="section-label">Contact</div>
        <label>Email (used for password resets &amp; notifications)
          <input name="email" type="email" value="${esc(me.email || '')}" placeholder="you@company.com" /></label>
        <div class="section-label" style="margin-top:14px">Bank / payout details</div>
        ${bankNameField(me.bank_name)}
        <label>Recipient bank account name<input name="recipient_name" value="${esc(me.recipient_name || '')}" placeholder="Name on the account" /></label>
        <label>Bank account number<input name="bank_account_no" inputmode="numeric" value="${esc(me.bank_account_no || '')}" placeholder="Account number" /></label>
        <p class="form-error" id="profileErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="profileCancel">Close</button>
          <button type="submit" class="btn btn-primary">Save details</button>
        </div>
      </form>
      <form id="pwForm" class="form" style="border-top:1px solid var(--line);margin-top:18px;padding-top:16px">
        <div class="section-label">Change password</div>
        <label>Current password
          <div class="pw-wrap"><input name="current_password" type="password" required />
            <button type="button" class="pw-toggle" aria-label="Show password">👁</button></div></label>
        <label>New password (min 8 characters)
          <div class="pw-wrap"><input name="new_password" type="password" required minlength="8" />
            <button type="button" class="pw-toggle" aria-label="Show password">👁</button></div></label>
        <p class="form-error" id="pwErr" hidden></p>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">Update password</button>
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
      err.textContent = 'Please enter your bank name.'; err.hidden = false; return;
    }
    try {
      const { user } = await api('/me', { method: 'PUT', body: JSON.stringify({
        email: fd.get('email'),
        bank_name: effectiveBank, recipient_name: fd.get('recipient_name'),
        bank_account_no: fd.get('bank_account_no') }) });
      if (user) state.user = { ...state.user, ...user };
      toast('Profile saved');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#pwErr'); err.hidden = true;
    const fd = new FormData(e.target);
    try {
      await api('/me/password', { method: 'POST', body: JSON.stringify({
        current_password: fd.get('current_password'), new_password: fd.get('new_password') }) });
      toast('Password updated'); e.target.reset();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Admin: Settings (accounts, departments, positions, expense types)
// ---------------------------------------------------------------------------
const SETTINGS_TABS = [
  { key: 'accounts', label: 'Accounts' },
  { key: 'departments', label: 'Departments' },
  { key: 'positions', label: 'Job positions' },
  { key: 'expense-types', label: 'Expense types' }
];
const settingsState = { tab: 'accounts', positions: [], departments: [], users: [] };

$('#settingsBtn').addEventListener('click', () => openSettingsModal());
// Admins and delegated seniors share the same department-scoped, rank-limited
// "Manage accounts" screen; superadmins use full Settings instead.
$('#accountsBtn').addEventListener('click', () => openManageAccountsModal());

// Human-readable role labels used across the account tables.
const ROLE_LABELS = { superadmin: 'Super Admin', admin: 'Admin', user: 'User' };
const roleLabel = (r) => ROLE_LABELS[r] || r;
// Creation-audit sub-line for the account tables: who created this account, or
// "—" for accounts made directly (seed scripts) or before creator tracking.
const creatorLine = (u) =>
  `<div class="u-sub u-creator">Created by ${u.created_by_name ? esc(u.created_by_name) : '—'}</div>`;

function openSettingsModal() {
  openModal(`
    <div class="modal-head">
      <h2>Settings</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <button type="button" class="btn btn-indigo-soft btn-sm" id="testEmailBtn">Send test email</button>
        <button class="x-btn">×</button>
      </div>
    </div>
    <div class="modal-body">
      <div class="tabs" id="settingsTabs">
        ${SETTINGS_TABS.map(t =>
          `<button class="tab ${t.key === settingsState.tab ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
      </div>
      <div id="settingsPanel"></div>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#testEmailBtn').addEventListener('click', sendTestEmail);
  $$('#settingsTabs .tab').forEach(b =>
    b.addEventListener('click', () => { settingsState.tab = b.dataset.tab; openSettingsModal(); }));
  renderSettingsTab();
}

// Confirm email delivery: sends a test message (default: the admin's own email).
async function sendTestEmail() {
  const to = prompt('Send a test email to:', (state.user && state.user.email) || '');
  if (to === null) return; // cancelled
  const btn = $('#testEmailBtn');
  btn.disabled = true;
  try {
    const r = await api('/test-email', { method: 'POST', body: JSON.stringify({ to: to.trim() }) });
    toast(`Test email sent to ${r.to}`);
  } catch (ex) { toast(ex.message, true); }
  finally { btn.disabled = false; }
}

function renderSettingsTab() {
  const panel = $('#settingsPanel');
  settingsState.departments = state.lookups.departments;
  panel.innerHTML = '<p class="muted" style="padding:20px 0">Loading…</p>';
  if (settingsState.tab === 'accounts') return renderAccountsTab();
  const cfg = {
    departments: { path: '/departments', noun: 'department', purposes: true },
    positions: { path: '/positions', noun: 'job position', purposes: true, ranked: true, manage: true },
    'expense-types': { path: '/expense-types', noun: 'expense type' }
  }[settingsState.tab];
  return renderLookupTab(cfg);
}

// --- Generic lookup manager (departments / positions / expense types) --------
async function renderLookupTab(cfg) {
  const panel = $('#settingsPanel');
  let items;
  try { ({ items } = await api(cfg.path)); }
  catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }

  const p = !!cfg.purposes;         // purpose gates (New claim / New meal allowance)
  const ranked = !!cfg.ranked;      // reorderable seniority ladder (job positions)
  const manage = !!cfg.manage;      // "Can manage accounts" delegation flag
  // A tick cell wires a boolean flag column (persisted immediately via PUT).
  const flagCell = (it, flag, label) =>
    `<td class="tick-cell" data-label="${label}"><input type="checkbox" data-flag="${flag}" data-id="${it.id}" ${it[flag] ? 'checked' : ''} /></td>`;
  // Up/down reorder controls for a ranked row (disabled at the ends).
  const orderCell = (it, i) => `<td class="ord-cell" data-label="Order">
      <div class="ord-btns">
        <button type="button" class="ord-btn" data-move="up" data-id="${it.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button type="button" class="ord-btn" data-move="down" data-id="${it.id}" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
      </div></td>`;
  const headCols = (ranked ? '<th style="width:64px">Order</th>' : '') + '<th>Name</th><th>Active</th>'
    + (p ? '<th>New claim</th><th>New meal allowance</th>' : '')
    + (manage ? '<th>Manage accounts</th>' : '')
    + '<th style="width:220px"></th>';
  const colspan = 2 + (ranked ? 1 : 0) + (p ? 2 : 0) + (manage ? 1 : 0) + 1;
  panel.innerHTML = `
    <div class="settings-controls">
      <form id="lookupForm" class="form" style="margin-bottom:14px;border-bottom:1px solid var(--line);padding-bottom:14px">
        <div style="display:flex;gap:8px;align-items:flex-end">
          <label style="flex:1;margin:0">Add ${cfg.noun}<input name="name" required placeholder="Name" /></label>
          <button type="submit" class="btn btn-primary btn-sm">Add</button>
        </div>
        <p class="form-error" id="lookupErr" hidden></p>
      </form>
      <div class="settings-search">
        <input id="lookupSearch" class="input" type="search" placeholder="Search ${cfg.noun}s…" />
      </div>
    </div>
    <div class="settings-list">
      <table class="utable">
        <thead><tr>${headCols}</tr></thead>
        <tbody>${items.length ? items.map((it, i) => `
          <tr data-id="${it.id}">
            ${ranked ? orderCell(it, i) : ''}
            <td data-label="Name" class="name-cell">${esc(it.name)}</td>
            <td data-label="Active">${it.active ? 'Yes' : 'No'}</td>
            ${p ? flagCell(it, 'allow_claim', 'New claim') + flagCell(it, 'allow_meal', 'New meal allowance') : ''}
            ${manage ? flagCell(it, 'can_manage', 'Manage accounts') : ''}
            <td class="act-cell" data-label="Actions">
              <div class="u-actions">
                <button class="btn btn-brand-soft btn-sm" data-rename="${it.id}">Edit</button>
                <button class="btn ${it.active ? 'btn-amber-soft' : 'btn-green-soft'} btn-sm" data-toggle="${it.id}">${it.active ? 'Disable' : 'Enable'}</button>
                <button class="btn btn-danger-ghost btn-sm" data-del="${it.id}">Delete</button>
              </div>
            </td>
          </tr>`).join('') : `<tr><td colspan="${colspan}" class="muted" style="padding:16px">No ${cfg.noun}s yet.</td></tr>`}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#lookupSearch'), '#settingsPanel .settings-list');

  const byId = (id) => items.find(x => x.id == id);
  $('#lookupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    try { await api(cfg.path, { method: 'POST', body: JSON.stringify({ name }) }); toast('Added'); refreshAfterSettings(); }
    catch (ex) { const el = $('#lookupErr'); el.textContent = ex.message; el.hidden = false; }
  });
  $$('#settingsPanel [data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const it = byId(b.dataset.toggle);
    try { await api(`${cfg.path}/${it.id}`, { method: 'PUT', body: JSON.stringify({ active: !it.active }) }); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  }));
  $$('#settingsPanel [data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Delete this ${cfg.noun}? Existing claims keep their recorded value.`)) return;
    try { await api(`${cfg.path}/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted'); refreshAfterSettings(); }
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
      toast('Saved');
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
      await api(`${cfg.path}/reorder`, { method: 'POST', body: JSON.stringify({ order: items.map(x => x.id) }) });
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
      <button type="button" class="btn btn-primary btn-sm" data-save>Save</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cancel>Cancel</button>
    </div>`;
  const input = cell.querySelector('.rename-input');
  input.focus(); input.select();
  const cancel = () => { cell.textContent = it.name; };
  const save = async () => {
    const name = input.value.trim();
    if (!name || name === it.name) return cancel();
    try { await api(`${cfg.path}/${it.id}`, { method: 'PUT', body: JSON.stringify({ name }) }); toast('Renamed'); refreshAfterSettings(); }
    catch (ex) { toast(ex.message, true); }
  };
  cell.querySelector('[data-save]').addEventListener('click', save);
  cell.querySelector('[data-cancel]').addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
}

// Re-render the current tab and keep the claim-form dropdowns in sync.
function refreshAfterSettings() { loadLookups(); renderSettingsTab(); }

// --- Accounts (users) --------------------------------------------------------
async function renderAccountsTab() {
  const panel = $('#settingsPanel');
  let users, positions;
  try {
    [{ users }, { items: positions }] = await Promise.all([api('/users'), api('/positions')]);
  } catch (ex) { panel.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  settingsState.positions = positions.map(p => p.name);
  settingsState.users = users;

  panel.innerHTML = `
    <div class="settings-controls">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
        <input id="acctSearch" class="input" type="search" placeholder="Search users…" style="flex:1" />
        <button class="btn btn-primary btn-sm" id="addUserBtn">+ Add user</button>
      </div>
    </div>
    <div class="settings-list">
      <table class="utable utable-users">
        <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Dept / Position</th><th>Active</th><th></th></tr></thead>
        <tbody>${users.map(u => `
          <tr>
            <td data-label="User"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub mono">${esc(u.username)}</div>${creatorLine(u)}</td>
            <td class="u-wrap" data-label="Email">${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
            <td data-label="Role">${esc(roleLabel(u.role))}</td>
            <td data-label="Dept / Position"><div>${u.department ? esc(u.department) : '<span class="muted">—</span>'}</div>${u.position ? `<div class="u-sub">${esc(u.position)}</div>` : ''}</td>
            <td data-label="Active">${u.active ? 'Yes' : 'No'}</td>
            <td class="act-cell" data-label="Actions">${(state.user.role === 'superadmin' || u.role === 'user')
              ? `<div class="u-actions">
                <button class="btn btn-brand-soft btn-sm" data-edit="${u.id}">Edit</button>
                ${u.id != state.user.id ? `<button class="btn btn-sm ${u.active ? 'btn-danger-ghost' : 'btn-green-soft'}" data-active="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}
              </div>`
              : '<span class="muted">—</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#acctSearch'), '#settingsPanel .settings-list');
  $('#addUserBtn').addEventListener('click', () => renderUserForm(null));
  $$('#settingsPanel [data-edit]').forEach(b =>
    b.addEventListener('click', () => renderUserForm(users.find(x => x.id == b.dataset.edit))));
  $$('#settingsPanel [data-active]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id == b.dataset.active);
    if (u.active && !confirm(`Disable ${u.full_name}'s account? They won't be able to sign in until re-enabled.`)) return;
    try {
      await api('/users/' + u.id + '/set-active', { method: 'POST', body: JSON.stringify({ active: !u.active }) });
      toast(u.active ? 'Account disabled' : 'Account enabled');
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
    <option value="">— none —</option>
    ${opts.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}
  </select>`;
}

// A searchable combobox of the created users (value = user id) for an approver
// row. The account being edited is excluded so it can't approve its own claims.
// A hidden input carries the selected id (name="appr_i") so the existing
// read/submit logic is unchanged; a text input filters the list as you type.
function approverRowSelect(i, value, excludeId) {
  const cur = value == null ? '' : String(value);
  const sel = settingsState.users.find(x => String(x.id) === cur && x.id !== excludeId);
  const label = sel ? `${sel.full_name} (${sel.username})` : '';
  return `<div class="combo" data-combo="${i}">
    <input type="hidden" name="appr_${i}" value="${esc(cur)}" />
    <input type="text" class="combo-input" autocomplete="off" spellcheck="false"
      role="combobox" aria-expanded="false" aria-autocomplete="list"
      placeholder="Search user…" value="${esc(label)}" />
    <div class="combo-list" role="listbox" hidden></div>
  </div>`;
}

// Wire one combobox: type-to-filter, click / arrow-keys / Enter to choose,
// Escape to close. Selecting sets the hidden id; leaving without a valid pick
// restores the last confirmed selection (or clears it).
function wireApproverCombo(container, excludeId) {
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
      : '<div class="combo-empty">No matches</div>';
  };
  const open = (q) => { render(q == null ? '' : q); list.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const highlight = () => {
    [...list.querySelectorAll('.combo-opt')].forEach((el, idx) => el.classList.toggle('active', idx === active));
    const el = list.querySelector('.combo-opt.active'); if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const choose = (u) => { hidden.value = String(u.id); input.value = labelFor(u); close(); syncApproverRows(); };

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
      <button type="button" class="x-btn" data-rm="${i}" aria-label="Remove approver">×</button>
    </div>`).join('') : '<p class="muted" style="font-size:.85rem;margin:4px 0">No approvers — only a Super Admin can approve.</p>';
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

function renderUserForm(u) {
  const isEdit = !!u;
  const excludeId = isEdit ? u.id : null;
  acctApprovers = isEdit ? (u.approver_ids || []).map(String) : [];
  openModal2(`
    <div class="modal-head">
      <h2>${isEdit ? 'Edit ' + esc(u.username) : 'New user'}</h2>
      <button type="button" class="x-btn" id="uClose">×</button>
    </div>
    <div class="modal-body">
    <form id="uForm" class="form">
      <div class="grid2">
        <label>Username<input name="username" required value="${isEdit ? esc(u.username) : ''}" /></label>
        <label>Full name<input name="full_name" required value="${isEdit ? esc(u.full_name) : ''}" /></label>
        <label>Email (for resets &amp; notifications)<input name="email" type="email" value="${isEdit ? esc(u.email || '') : ''}" placeholder="you@company.com" /></label>
        ${state.user.role === 'superadmin' ? `<label>Role
          <select name="role">
            <option value="superadmin" ${isEdit && u.role === 'superadmin' ? 'selected' : ''}>Super Admin</option>
            <option value="admin" ${isEdit && u.role === 'admin' ? 'selected' : ''}>Admin</option>
            <option value="user" ${!isEdit || u.role === 'user' ? 'selected' : ''}>User</option>
          </select></label>` : ''}
        <label>Department${optionSelect('department', isEdit ? u.department : '', settingsState.departments)}</label>
        <label>Job position${optionSelect('position', isEdit ? u.position : '', settingsState.positions)}</label>
        <label>${isEdit ? 'Reset password (optional)' : 'Password'}
          <div class="pw-wrap">
            <input name="password" type="password" ${isEdit ? '' : 'required'} />
            <button type="button" class="pw-toggle" aria-label="Show password">👁</button>
          </div></label>
      </div>
      ${state.user.role === 'superadmin' ? `
      <div class="section-label" style="margin-top:8px">Permissions</div>
      <label class="perm-check"><input type="checkbox" name="can_mark_paid" ${isEdit && u.can_mark_paid ? 'checked' : ''} /> <span>Can mark claims as paid (record payment)</span></label>` : ''}
      <div class="section-label" style="margin-top:8px">Approval chain (approvers, in order)</div>
      <div id="approverRows"></div>
      <button type="button" class="btn btn-ghost btn-sm add-approver-btn" id="addApproverBtn">+ Add approver</button>
      <div class="section-label" style="margin-top:8px">Bank / payout details</div>
      <div class="grid2">
        <label>Bank name<input name="bank_name" value="${isEdit ? esc(u.bank_name || '') : ''}" /></label>
        <label>Recipient name<input name="recipient_name" value="${isEdit ? esc(u.recipient_name || '') : ''}" /></label>
        <label>Bank account no.<input name="bank_account_no" inputmode="numeric" value="${isEdit ? esc(u.bank_account_no || '') : ''}" /></label>
      </div>
      <p class="form-error" id="uErr" hidden></p>
      <div class="modal-actions sticky-foot">
        <button type="button" class="btn btn-ghost btn-sm" id="uCancel">Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Save' : 'Create'}</button>
      </div>
    </form>
    </div>`);
  $('#modal2').classList.add('modal-wide');
  $('#uClose').addEventListener('click', closeModal2);
  $('#uCancel').addEventListener('click', closeModal2);
  renderApproverRows(excludeId);
  $('#addApproverBtn').addEventListener('click', () => { syncApproverRows(); acctApprovers.push(''); renderApproverRows(excludeId); });
  $('#uForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    syncApproverRows();
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
    if (state.user.role === 'superadmin') payload.can_mark_paid = fd.get('can_mark_paid') === 'on';
    const pw = fd.get('password');
    if (pw && (!isEdit || pw.length)) payload.password = pw;
    try {
      if (isEdit) await api('/users/' + u.id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/users', { method: 'POST', body: JSON.stringify(payload) });
      closeModal2(); toast('User saved'); renderAccountsTab();
    } catch (ex) { const el = $('#uErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Delegated account creation (senior positions — not superadmins)
// ---------------------------------------------------------------------------
// A user in a senior job position may create accounts for junior positions in
// their own department. The server enforces the same rules; this is the UI.
function openManageAccountsModal() {
  openModal(`
    <div class="modal-head">
      <h2>Manage accounts</h2>
      <button class="x-btn">×</button>
    </div>
    <div class="modal-body" id="maBody">
      <p class="muted" style="padding:20px 0">Loading…</p>
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
  body.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
      <input id="maSearch" class="input" type="search" placeholder="Search users…" style="flex:1" />
    </div>
    <p class="muted" style="margin:0 0 12px;font-size:.85rem">Accounts in <strong>${esc(dept) || '—'}</strong>. You can reset passwords and enable/disable your team (positions ranked below yours). Only a super admin can create new accounts.</p>
    <div class="settings-list">
      <table class="utable utable-manage">
        <thead><tr><th>User</th><th>Email</th><th>Position</th><th>Active</th><th class="u-actions-h">Actions</th></tr></thead>
        <tbody>${users.length ? users.map(u => `
          <tr>
            <td data-label="User"><div class="u-name">${esc(u.full_name)}</div><div class="u-sub mono">${esc(u.username)}</div>${creatorLine(u)}</td>
            <td class="u-wrap" data-label="Email">${u.email ? esc(u.email) : '<span class="muted">—</span>'}</td>
            <td data-label="Position">${u.position ? esc(u.position) : '<span class="muted">—</span>'}</td>
            <td data-label="Active">${u.active
                ? '<span class="pill pill-on">Active</span>'
                : '<span class="pill pill-off">Disabled</span>'}</td>
            <td class="act-cell" data-label="Actions">${maCanManage(u) ? `<div class="u-actions">
              <button class="btn btn-indigo-soft btn-sm" data-reset="${u.id}">Reset password</button>
              <button class="btn btn-sm ${u.active ? 'btn-danger-ghost' : 'btn-primary'}" data-active="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>
            </div>` : '<span class="muted">—</span>'}</td>
          </tr>`).join('') : '<tr><td colspan="5" class="muted" style="padding:16px">No accounts yet.</td></tr>'}</tbody>
      </table>
    </div>`;
  wireTableSearch($('#maSearch'), '#maBody .settings-list');
  $$('#maBody [data-reset]').forEach(b => b.addEventListener('click', () =>
    renderResetPasswordForm(users.find(x => x.id == b.dataset.reset))));
  $$('#maBody [data-active]').forEach(b => b.addEventListener('click', async () => {
    const u = users.find(x => x.id == b.dataset.active);
    if (u.active && !confirm(`Disable ${u.full_name}'s account? They won't be able to sign in until re-enabled.`)) return;
    try {
      await api('/users/' + u.id + '/set-active', { method: 'POST', body: JSON.stringify({ active: !u.active }) });
      toast(u.active ? 'Account disabled' : 'Account enabled');
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

function renderResetPasswordForm(u) {
  if (!u) return;
  openModal2(`
    <div class="modal-head">
      <h2>Reset password</h2>
      <button type="button" class="x-btn" id="rpClose">×</button>
    </div>
    <div class="modal-body">
    <form id="rpForm" class="form">
      <p class="muted" style="margin:0 0 12px;font-size:.9rem">Set a new password for <strong>${esc(u.full_name)}</strong> (${esc(u.username)}).</p>
      <label>New password
        <div class="pw-wrap">
          <input name="password" type="password" required minlength="8" />
          <button type="button" class="pw-toggle" aria-label="Show password">👁</button>
        </div></label>
      <p class="form-error" id="rpErr" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="rpCancel">Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm">Reset password</button>
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
      closeModal2(); toast('Password reset');
    } catch (ex) { const el = $('#rpErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

boot();
