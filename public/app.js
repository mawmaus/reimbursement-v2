'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  user: null, claims: [], filters: { status: '', department: '', q: '' },
  lookups: { departments: [], expense_types: [] }
};

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
function fmtDateTime(s) { return s ? s.replace('T', ' ').slice(0, 16) : '—'; }
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
  $('#loginHint').textContent = 'Need an account? Contact your administrator.';
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
  $('#exportBtn').hidden = u.role !== 'superadmin';
  $('#settingsBtn').hidden = u.role !== 'superadmin';
  loadLookups();
  loadAll();
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

// ---------------------------------------------------------------------------
// Load + render
// ---------------------------------------------------------------------------
async function loadAll() {
  await Promise.all([loadSummary(), loadClaims()]);
}

async function loadSummary() {
  try {
    // Combine reimbursement + meal allowance so the cards reflect everything
    // in the shared ledger.
    const [a, b] = await Promise.all([api('/claims/summary'), api('/meal-claims/summary')]);
    const s = a.summary, m = b.summary;
    const cards = [
      { k: 'submitted', l: 'Pending', n: s.submitted + m.submitted },
      { k: 'approved', l: 'Approved', n: s.approved + m.approved },
      { k: 'rejected', l: 'Rejected', n: s.rejected + m.rejected },
      { k: 'paid', l: 'Paid', n: s.paid + m.paid },
      { k: 'total', l: 'Total value', n: money(s.total_amount + m.total_amount, 'IDR') }
    ];
    $('#summaryCards').innerHTML = cards.map(c =>
      `<div class="card ${c.k}"><div class="card-n">${esc(c.n)}</div><div class="card-l">${c.l}</div></div>`
    ).join('');
  } catch (e) { /* ignore */ }
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
  renderDeptOptions();
  renderClaims();
}

// Uniform row display fields for the two claim types.
function rowView(c) {
  if (c.type === 'meal') {
    const first = (c.lines && c.lines[0] && c.lines[0].line_date) || (c.created_at || '').slice(0, 10);
    return { typeLabel: 'Meal allowance', date: first, amount: c.total_amount };
  }
  return { typeLabel: c.expense_type, date: c.expense_date, amount: c.amount };
}

function renderDeptOptions() {
  const sel = $('#deptFilter');
  const current = sel.value;
  const depts = [...new Set(state.claims.map(c => c.department).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All departments</option>' +
    depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  sel.value = current;
}

function renderClaims() {
  const wrap = $('#claimRows');
  if (!state.claims.length) { wrap.innerHTML = ''; $('#emptyState').hidden = false; return; }
  $('#emptyState').hidden = true;
  wrap.innerHTML = state.claims.map(c => {
    const v = rowView(c);
    return `
    <div class="ledger-row" data-id="${c.id}" data-type="${c.type}" tabindex="0" role="button">
      <span class="row-spine ${c.status}"></span>
      <span class="col-no">${esc(c.claim_no)}</span>
      <span class="col-name">${esc(c.claimant_name)}</span>
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
}

// filters
let qTimer;
$('#searchInput').addEventListener('input', e => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); loadClaims(); }, 250);
});
$('#statusFilter').addEventListener('change', e => { state.filters.status = e.target.value; loadClaims(); });
$('#deptFilter').addEventListener('change', e => { state.filters.department = e.target.value; loadClaims(); });

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
function buildActions(c, u, isOwner) {
  if (c.status === 'submitted' && canApprove(u, c)) {
    return `<button class="btn btn-approve" data-act="approve">Approve</button>
            <button class="btn btn-danger" data-act="reject">Reject &amp; return</button>`;
  }
  if (u.role === 'superadmin' && c.status === 'approved') {
    return `<button class="btn btn-primary" data-act="paid">Mark as paid</button>`;
  }
  if (isOwner && c.status === 'rejected') {
    return `<button class="btn btn-primary" data-act="edit">Edit &amp; resubmit</button>`;
  }
  return '';
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
      <td class="mono">${esc(l.line_date)}</td>
      <td>${esc(l.site)}</td>
      <td>${esc(l.job_category)}</td>
      <td class="meal-amt">${esc(money(l.amount, c.currency))}</td>
      <td>${esc(l.description)}</td>
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
      await api(`${base}${c.id}/mark-paid`, { method: 'POST', body: JSON.stringify({}) });
      toast('Marked as paid');
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
function closeModal() { $('#modal').hidden = true; $('#modalScrim').hidden = true; $('#modal').classList.remove('modal-wide'); }
$('#modalScrim').addEventListener('click', closeModal);

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
    expense_date: new Date().toISOString().slice(0, 10)
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
          ${lookupField('expense_type', 'Type of expense', v.expense_type, state.lookups.expense_types, 'placeholder="Travel, Meals, Supplies…"')}
          <label>Amount
            <div style="display:flex;gap:6px">
              <input name="currency" style="max-width:80px" value="${esc(v.currency || 'IDR')}" />
              <input name="amount" required inputmode="decimal" placeholder="0" value="${existing ? existing.amount : ''}" />
            </div>
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
              <span style="font-size:.8rem">PDF, images, Word/Excel · up to 8 files · 10 MB each</span>
              <input id="fileInput" type="file" multiple hidden
                accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx,.txt,.csv" />
            </div>
            <div class="file-chips" id="fileChips"></div>
          </div>
        </div>
        <p class="form-error" id="claimError" hidden></p>
        <div class="modal-actions">
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
  $('#claimForm').addEventListener('submit', e => submitClaim(e, existing));
}

function addFiles(list) {
  for (const f of list) {
    if (pendingFiles.length >= 8) { toast('Maximum 8 files', true); break; }
    if (f.size > 10 * 1024 * 1024) { toast(`${f.name} exceeds 10 MB`, true); continue; }
    pendingFiles.push(f);
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

let mealRows = [];
function mealRowHtml(r, i) {
  return `<tr data-i="${i}">
    <td><input name="date" type="date" value="${esc(r.date || '')}" /></td>
    <td><input name="site" value="${esc(r.site || '')}" placeholder="DB 500 309" /></td>
    <td><input name="category" value="${esc(r.category || '')}" placeholder="Install / Repair / Service…" /></td>
    <td><input name="amount" inputmode="numeric" class="meal-amt" value="${esc(groupAmount(r.amount))}" placeholder="120,000" /></td>
    <td><input name="desc" value="${esc(r.desc || '')}" placeholder="Surabaya" /></td>
    <td><button type="button" class="x-btn" data-rm="${i}" aria-label="Remove row">×</button></td>
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
  $$('#mealRows .meal-amt').forEach(inp => inp.addEventListener('input', () => {
    inp.value = groupAmount(inp.value);
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
        <button type="button" class="btn btn-ghost btn-sm" id="mealAddRow" style="margin-top:10px">+ Add row</button>
        ${isEdit ? `<label class="full" style="margin-top:10px">Note to manager (optional)
          <input name="resubmit_note" placeholder="What you changed since the rejection" /></label>` : ''}
        <div class="meal-note">
          <strong>MEAL ALLOWANCE CLAIM</strong>
          BODETABEK AREA — IDR 75.000,-
          EXCLUDE BODETABEK AREA — IDR 120.000,-
        </div>
        <p class="form-error" id="mealError" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="mealCancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Resubmit claim' : 'Submit claim'}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide');
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
              <label class="check-item uf-item" data-name="${esc((u.full_name + ' ' + u.username).toLowerCase())}">
                <input type="checkbox" name="employee" value="${u.id}" checked />
                ${esc(u.full_name)} <span class="muted">(${esc(u.username)})</span>
              </label>`).join('') : '<p class="muted" style="padding:8px">No users.</p>'}
          </div>
        </div>
        <p class="muted" style="font-size:.8rem;margin:10px 0 0">Leave dates blank to export all dates. Dates apply to the expense / meal date.</p>
        <p class="form-error" id="exportErr" hidden></p>
        <div class="modal-actions">
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

async function openProfileModal() {
  // Fetch the current values (login response omits bank details).
  let me = state.user || {};
  try { ({ user: me } = await api('/me')); } catch { /* fall back to state.user */ }
  openModal(`
    <div class="modal-head"><h2>My profile</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="profileForm" class="form">
        <div class="section-label">Bank / payout details</div>
        <label>Bank name<input name="bank_name" value="${esc(me.bank_name || '')}" placeholder="e.g. BCA" /></label>
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
        <label>New password (min 6 characters)
          <div class="pw-wrap"><input name="new_password" type="password" required minlength="6" />
            <button type="button" class="pw-toggle" aria-label="Show password">👁</button></div></label>
        <p class="form-error" id="pwErr" hidden></p>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">Update password</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#profileCancel').addEventListener('click', closeModal);

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#profileErr'); err.hidden = true;
    const fd = new FormData(e.target);
    try {
      const { user } = await api('/me', { method: 'PUT', body: JSON.stringify({
        bank_name: fd.get('bank_name'), recipient_name: fd.get('recipient_name'),
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

function openSettingsModal() {
  openModal(`
    <div class="modal-head"><h2>Settings</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <div class="tabs" id="settingsTabs">
        ${SETTINGS_TABS.map(t =>
          `<button class="tab ${t.key === settingsState.tab ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
      </div>
      <div id="settingsPanel"></div>
    </div>`);
  $('#modal').classList.add('modal-wide');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $$('#settingsTabs .tab').forEach(b =>
    b.addEventListener('click', () => { settingsState.tab = b.dataset.tab; openSettingsModal(); }));
  renderSettingsTab();
}

function renderSettingsTab() {
  const panel = $('#settingsPanel');
  settingsState.departments = state.lookups.departments;
  panel.innerHTML = '<p class="muted" style="padding:20px 0">Loading…</p>';
  if (settingsState.tab === 'accounts') return renderAccountsTab();
  const cfg = {
    departments: { path: '/departments', noun: 'department', purposes: true },
    positions: { path: '/positions', noun: 'job position', purposes: true },
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

  const p = !!cfg.purposes;
  const colspan = p ? 5 : 3;
  // Two extra columns gate the front-page purpose buttons for this row. A user
  // sees a purpose only when it is ticked on BOTH their department and position.
  const purposeCell = (it, flag) =>
    `<td class="tick-cell"><input type="checkbox" data-flag="${flag}" data-id="${it.id}" ${it[flag] ? 'checked' : ''} /></td>`;
  panel.innerHTML = `
    <table class="utable">
      <thead><tr><th>Name</th><th>Active</th>${p ? '<th>New claim</th><th>New meal allowance</th>' : ''}<th style="width:150px"></th></tr></thead>
      <tbody>${items.length ? items.map(it => `
        <tr data-id="${it.id}">
          <td>${esc(it.name)}</td>
          <td>${it.active ? 'Yes' : 'No'}</td>
          ${p ? purposeCell(it, 'allow_claim') + purposeCell(it, 'allow_meal') : ''}
          <td>
            <button class="btn btn-ghost btn-sm" data-toggle="${it.id}">${it.active ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-ghost btn-sm" data-del="${it.id}">Delete</button>
          </td>
        </tr>`).join('') : `<tr><td colspan="${colspan}" class="muted" style="padding:16px">No ${cfg.noun}s yet.</td></tr>`}</tbody>
    </table>
    <form id="lookupForm" class="form" style="margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
      <div style="display:flex;gap:8px;align-items:flex-end">
        <label style="flex:1">Add ${cfg.noun}<input name="name" required placeholder="Name" /></label>
        <button type="submit" class="btn btn-primary btn-sm">Add</button>
      </div>
      <p class="form-error" id="lookupErr" hidden></p>
    </form>`;

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
  // Purpose tickboxes — persist immediately; keep local state in sync so a later
  // active-toggle/delete re-render reflects the choice without a full reload.
  $$('#settingsPanel input[data-flag]').forEach(cb => cb.addEventListener('change', async () => {
    const it = byId(cb.dataset.id);
    const flag = cb.dataset.flag, val = cb.checked;
    try {
      await api(`${cfg.path}/${cb.dataset.id}`, { method: 'PUT', body: JSON.stringify({ [flag]: val }) });
      if (it) it[flag] = val;
      toast('Saved');
    } catch (ex) { cb.checked = !val; toast(ex.message, true); }
  }));
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
    <table class="utable">
      <thead><tr><th>User</th><th>Name</th><th>Role</th><th>Dept</th><th>Position</th><th>Active</th><th></th></tr></thead>
      <tbody>${users.map(u => `
        <tr>
          <td class="mono">${esc(u.username)}</td><td>${esc(u.full_name)}</td>
          <td>${esc(u.role)}</td><td>${esc(u.department)}</td><td>${esc(u.position || '')}</td>
          <td>${u.active ? 'Yes' : 'No'}</td>
          <td><button class="btn btn-ghost btn-sm" data-edit="${u.id}">Edit</button></td>
        </tr>`).join('')}</tbody>
    </table>
    <div style="margin-top:18px"><button class="btn btn-primary btn-sm" id="addUserBtn">+ Add user</button></div>
    <div id="userForm"></div>`;
  $('#addUserBtn').addEventListener('click', () => renderUserForm(null));
  $$('#settingsPanel [data-edit]').forEach(b =>
    b.addEventListener('click', () => renderUserForm(users.find(x => x.id == b.dataset.edit))));
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

// One <select> of the created users (value = user id) for an approver row.
// The account being edited is excluded so it can't approve its own claims.
function approverRowSelect(i, value, excludeId) {
  const cur = value == null ? '' : String(value);
  return `<select name="appr_${i}">
    <option value="">— select user —</option>
    ${settingsState.users
      .filter(x => x.id !== excludeId)
      .map(x => `<option value="${x.id}" ${String(x.id) === cur ? 'selected' : ''}>${
        esc(x.full_name)} (${esc(x.username)})</option>`).join('')}
  </select>`;
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
  $('#userForm').innerHTML = `
    <form id="uForm" class="form" style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px">
      <h3 style="font-size:.95rem">${isEdit ? 'Edit ' + esc(u.username) : 'New user'}</h3>
      <div class="grid2">
        <label>Username<input name="username" required value="${isEdit ? esc(u.username) : ''}" /></label>
        <label>Full name<input name="full_name" required value="${isEdit ? esc(u.full_name) : ''}" /></label>
        <label>Role
          <select name="role">
            <option value="superadmin" ${isEdit && u.role === 'superadmin' ? 'selected' : ''}>Super Admin</option>
            <option value="user" ${!isEdit || u.role === 'user' ? 'selected' : ''}>User</option>
          </select></label>
        <label>Department${optionSelect('department', isEdit ? u.department : '', settingsState.departments)}</label>
        <label>Job position${optionSelect('position', isEdit ? u.position : '', settingsState.positions)}</label>
        <label>${isEdit ? 'Reset password (optional)' : 'Password'}
          <div class="pw-wrap">
            <input name="password" type="password" ${isEdit ? '' : 'required'} />
            <button type="button" class="pw-toggle" aria-label="Show password">👁</button>
          </div></label>
        ${isEdit ? `<label>Active<select name="active"><option value="1" ${u.active ? 'selected' : ''}>Yes</option><option value="0" ${!u.active ? 'selected' : ''}>No</option></select></label>` : ''}
      </div>
      <div class="section-label" style="margin-top:8px">Approval chain (approvers, in order)</div>
      <div id="approverRows"></div>
      <button type="button" class="btn btn-ghost btn-sm" id="addApproverBtn" style="margin-top:8px">+ Add approver</button>
      <div class="section-label" style="margin-top:8px">Bank / payout details</div>
      <div class="grid2">
        <label>Bank name<input name="bank_name" value="${isEdit ? esc(u.bank_name || '') : ''}" /></label>
        <label>Recipient name<input name="recipient_name" value="${isEdit ? esc(u.recipient_name || '') : ''}" /></label>
        <label>Bank account no.<input name="bank_account_no" inputmode="numeric" value="${isEdit ? esc(u.bank_account_no || '') : ''}" /></label>
      </div>
      <p class="form-error" id="uErr" hidden></p>
      <div class="modal-actions"><button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Save' : 'Create'}</button></div>
    </form>`;
  renderApproverRows(excludeId);
  $('#addApproverBtn').addEventListener('click', () => { syncApproverRows(); acctApprovers.push(''); renderApproverRows(excludeId); });
  $('#uForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    syncApproverRows();
    const fd = new FormData(e.target);
    const payload = {
      username: fd.get('username'), full_name: fd.get('full_name'), role: fd.get('role'),
      department: fd.get('department') || '', position: fd.get('position') || '',
      bank_name: fd.get('bank_name') || '', recipient_name: fd.get('recipient_name') || '',
      bank_account_no: fd.get('bank_account_no') || '',
      approver_ids: acctApprovers.filter(Boolean).map(Number)
    };
    if (isEdit) payload.active = fd.get('active');
    const pw = fd.get('password');
    if (pw && (!isEdit || pw.length)) payload.password = pw;
    try {
      if (isEdit) await api('/users/' + u.id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/users', { method: 'POST', body: JSON.stringify(payload) });
      toast('User saved'); renderAccountsTab();
    } catch (ex) { const el = $('#uErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

boot();
