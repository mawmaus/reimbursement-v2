'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { user: null, claims: [], filters: { status: '', department: '', q: '' } };

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
  $('#userBadge').innerHTML = `${esc(u.full_name)}<span class="role">${esc(u.role)}</span>`;
  const canCreate = ['employee', 'manager', 'finance', 'admin'].includes(u.role);
  $('#newClaimBtn').hidden = !canCreate;
  $('#exportBtn').hidden = !['finance', 'admin'].includes(u.role);
  $('#usersBtn').hidden = u.role !== 'admin';
  loadAll();
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
    const { summary } = await api('/claims/summary');
    const cards = [
      { k: 'submitted', l: 'Pending', n: summary.submitted },
      { k: 'approved', l: 'Approved', n: summary.approved },
      { k: 'rejected', l: 'Rejected', n: summary.rejected },
      { k: 'paid', l: 'Paid', n: summary.paid },
      { k: 'total', l: 'Total value', n: money(summary.total_amount, 'IDR') }
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
  const { claims } = await api('/claims?' + p.toString());
  state.claims = claims;
  renderDeptOptions();
  renderClaims();
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
  wrap.innerHTML = state.claims.map(c => `
    <div class="ledger-row" data-id="${c.id}" tabindex="0" role="button">
      <span class="row-spine ${c.status}"></span>
      <span class="col-no">${esc(c.claim_no)}</span>
      <span class="col-name">${esc(c.claimant_name)}</span>
      <span class="col-type">${esc(c.expense_type)}</span>
      <span class="col-date mono">${esc(c.expense_date)}</span>
      <span class="col-amt">${esc(money(c.amount, c.currency))}</span>
      <span class="col-status"><span class="pill ${c.status}">${STATUS_LABEL[c.status]}</span></span>
    </div>`).join('');
  $$('.ledger-row', wrap).forEach(el => {
    const open = () => openDrawer(el.dataset.id);
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

async function openDrawer(id) {
  const { claim: c } = await api('/claims/' + id);
  const u = state.user;
  const isOwner = c.employee_id === u.id;

  const attachments = c.attachments.length ? `
    <div class="section-label">Attachments</div>
    <ul class="attach-list">
      ${c.attachments.map(a => `
        <li><a href="/api/claims/${c.id}/attachments/${a.id}" target="_blank" rel="noopener">
          📎 <span>${esc(a.original_name)}</span><span class="fsize">${fmtBytes(a.size_bytes)}</span></a></li>`).join('')}
    </ul>` : '<div class="section-label">Attachments</div><p class="muted">None uploaded.</p>';

  const rejectedNote = (c.status === 'rejected' && c.manager_comment) ? `
    <div class="note-box"><div class="nb-label">Returned by manager</div>
      <div>${esc(c.manager_comment)}</div></div>` : '';

  const history = `
    <div class="section-label">History</div>
    <ul class="timeline">
      ${c.history.map(h => `
        <li><span class="t-action">${esc(h.action)}</span>
          <div class="t-meta">${esc(h.actor_name)} · ${fmtDateTime(h.created_at)}</div>
          ${h.comment ? `<div class="t-comment">${esc(h.comment)}</div>` : ''}</li>`).join('')}
    </ul>`;

  // role/status based actions
  let actions = '';
  if ((u.role === 'manager' || u.role === 'admin') && c.status === 'submitted') {
    actions = `<button class="btn btn-approve" data-act="approve">Approve</button>
               <button class="btn btn-danger" data-act="reject">Reject &amp; return</button>`;
  } else if ((u.role === 'finance' || u.role === 'admin') && c.status === 'approved') {
    actions = `<button class="btn btn-primary" data-act="paid">Mark as paid</button>`;
  } else if (isOwner && c.status === 'rejected') {
    actions = `<button class="btn btn-primary" data-act="edit">Edit &amp; resubmit</button>`;
  }

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div><h2>${esc(c.claim_no)} <span class="pill ${c.status}">${STATUS_LABEL[c.status]}</span></h2>
        <p class="muted" style="margin:4px 0 0;font-size:.85rem">Submitted ${fmtDateTime(c.created_at)}</p></div>
      <button class="x-btn" aria-label="Close">×</button>
    </div>
    <div class="drawer-body">
      ${rejectedNote}
      <dl class="kv">
        <dt>Claimant</dt><dd>${esc(c.claimant_name)}</dd>
        <dt>Department</dt><dd>${esc(c.department)}</dd>
        <dt>Expense type</dt><dd>${esc(c.expense_type)}</dd>
        <dt>Expense date</dt><dd>${esc(c.expense_date)}</dd>
        <dt>Amount</dt><dd class="amt">${esc(money(c.amount, c.currency))}</dd>
        <dt>Recipient</dt><dd>${esc(c.recipient_name)}</dd>
        <dt>Bank</dt><dd>${esc(c.bank_name)}</dd>
        <dt>Account no.</dt><dd class="mono">${esc(c.bank_account_no)}</dd>
        ${c.description ? `<dt>Description</dt><dd>${esc(c.description)}</dd>` : ''}
      </dl>
      ${attachments}
      ${history}
      <div class="drawer-actions">${actions || '<span class="muted" style="font-size:.85rem">No actions available for your role at this stage.</span>'}</div>
    </div>`;

  $('#drawer .x-btn').addEventListener('click', closeDrawer);
  const actBtns = $$('#drawer [data-act]');
  actBtns.forEach(b => b.addEventListener('click', () => handleAction(b.dataset.act, c)));

  $('#drawerScrim').hidden = false;
  $('#drawer').hidden = false;
}

async function handleAction(act, c) {
  try {
    if (act === 'approve') {
      await api(`/claims/${c.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      toast('Claim approved');
    } else if (act === 'paid') {
      await api(`/claims/${c.id}/mark-paid`, { method: 'POST', body: JSON.stringify({}) });
      toast('Marked as paid');
    } else if (act === 'reject') {
      return openRejectModal(c);
    } else if (act === 'edit') {
      return openClaimModal(c);
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
function closeModal() { $('#modal').hidden = true; $('#modalScrim').hidden = true; }
$('#modalScrim').addEventListener('click', closeModal);

// ---------------------------------------------------------------------------
// New / Edit claim
// ---------------------------------------------------------------------------
let pendingFiles = [];

function openClaimModal(existing = null) {
  const u = state.user;
  const isEdit = !!existing;
  pendingFiles = [];
  const v = existing || {
    claimant_name: u.full_name, department: u.department, currency: 'IDR',
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
          <label>Name<input name="claimant_name" required value="${esc(v.claimant_name || '')}" /></label>
          <label>Date<input name="expense_date" type="date" required value="${esc(v.expense_date || '')}" /></label>
          <label>Department<input name="department" required value="${esc(v.department || '')}" /></label>
          <label>Type of expense<input name="expense_type" required placeholder="Travel, Meals, Supplies…" value="${esc(v.expense_type || '')}" /></label>
          <label>Bank name<input name="bank_name" required value="${esc(v.bank_name || '')}" /></label>
          <label>Recipient name<input name="recipient_name" required value="${esc(v.recipient_name || '')}" /></label>
          <label>Bank account no.<input name="bank_account_no" required inputmode="numeric" value="${esc(v.bank_account_no || '')}" /></label>
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
    try {
      await api(`/claims/${c.id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) });
      toast('Claim returned to claimant');
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#rejErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Export (finance)
// ---------------------------------------------------------------------------
$('#exportBtn').addEventListener('click', () => {
  const p = new URLSearchParams();
  if (state.filters.status) p.set('status', state.filters.status);
  if (state.filters.department) p.set('department', state.filters.department);
  window.location.href = '/api/export.csv?' + p.toString();
});

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------
$('#passwordBtn').addEventListener('click', () => {
  openModal(`
    <div class="modal-head"><h2>Change password</h2><button class="x-btn">×</button></div>
    <div class="modal-body"><form id="pwForm" class="form">
      <label>Current password<input name="current_password" type="password" required /></label>
      <label>New password (min 6 characters)<input name="new_password" type="password" required minlength="6" /></label>
      <p class="form-error" id="pwErr" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="pwCancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Update password</button>
      </div>
    </form></div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#pwCancel').addEventListener('click', closeModal);
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/me/password', { method: 'POST', body: JSON.stringify({
        current_password: fd.get('current_password'), new_password: fd.get('new_password') }) });
      toast('Password updated'); closeModal();
    } catch (ex) { const el = $('#pwErr'); el.textContent = ex.message; el.hidden = false; }
  });
});

// ---------------------------------------------------------------------------
// Admin: users
// ---------------------------------------------------------------------------
$('#usersBtn').addEventListener('click', openUsersModal);

async function openUsersModal() {
  const { users } = await api('/users');
  openModal(`
    <div class="modal-head"><h2>Users</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <table class="utable">
        <thead><tr><th>User</th><th>Name</th><th>Role</th><th>Dept</th><th>Active</th><th></th></tr></thead>
        <tbody>${users.map(u => `
          <tr>
            <td class="mono">${esc(u.username)}</td><td>${esc(u.full_name)}</td>
            <td>${esc(u.role)}</td><td>${esc(u.department)}</td>
            <td>${u.active ? 'Yes' : 'No'}</td>
            <td><button class="btn btn-ghost btn-sm" data-edit="${u.id}">Edit</button></td>
          </tr>`).join('')}</tbody>
      </table>
      <div style="margin-top:18px"><button class="btn btn-primary btn-sm" id="addUserBtn">+ Add user</button></div>
      <div id="userForm"></div>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#addUserBtn').addEventListener('click', () => renderUserForm(null));
  $$('#modal [data-edit]').forEach(b =>
    b.addEventListener('click', () => renderUserForm(users.find(x => x.id == b.dataset.edit))));
}

function renderUserForm(u) {
  const isEdit = !!u;
  $('#userForm').innerHTML = `
    <form id="uForm" class="form" style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px">
      <h3 style="font-size:.95rem">${isEdit ? 'Edit ' + esc(u.username) : 'New user'}</h3>
      <div class="grid2">
        ${isEdit ? '' : `<label>Username<input name="username" required /></label>`}
        <label>Full name<input name="full_name" required value="${isEdit ? esc(u.full_name) : ''}" /></label>
        <label>Role
          <select name="role">
            ${['employee', 'manager', 'finance', 'admin'].map(r =>
              `<option value="${r}" ${isEdit && u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select></label>
        <label>Department<input name="department" value="${isEdit ? esc(u.department) : ''}" /></label>
        <label>${isEdit ? 'Reset password (optional)' : 'Password'}<input name="password" type="password" ${isEdit ? '' : 'required'} /></label>
        ${isEdit ? `<label>Active<select name="active"><option value="1" ${u.active ? 'selected' : ''}>Yes</option><option value="0" ${!u.active ? 'selected' : ''}>No</option></select></label>` : ''}
      </div>
      <p class="form-error" id="uErr" hidden></p>
      <div class="modal-actions"><button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Save' : 'Create'}</button></div>
    </form>`;
  $('#uForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (isEdit && !payload.password) delete payload.password;
    try {
      if (isEdit) await api('/users/' + u.id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/users', { method: 'POST', body: JSON.stringify(payload) });
      toast('User saved'); openUsersModal();
    } catch (ex) { const el = $('#uErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

boot();
