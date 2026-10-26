'use strict';

// Export (finance): Excel workbook by date range, status and type.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Export (finance) — choose a date range and one or more statuses; covers both
// reimbursement and meal allowance claims.
// ---------------------------------------------------------------------------
// "Pending review" is split by which approver is next: pending_manager = still
// with the department Manager (step 1); pending_finance = Manager approved, now
// with FinanceAP (step >= 2). Picking only pending_finance exports what the
// Managers have already approved.
const EXPORT_STATUS_OPTS = [
  { v: 'pending_manager', l: 'Pending Review - Manager' },
  { v: 'pending_finance', l: 'Pending Review - FinanceAP' },
  { v: 'approved', l: 'Approved' },
  { v: 'rejected', l: 'Rejected' },
  { v: 'paid', l: 'Paid' }
];
const EXPORT_TYPE_OPTS = [
  { v: 'reimbursement', l: 'Reimbursement claims' },
  { v: 'meal', l: 'Meal allowances' },
  { v: 'advance', l: 'Cash advances (realized)' }
];
$('#exportBtn').addEventListener('click', () => openExportModal());

async function openExportModal() {
  let users = [];
  try { ({ users } = await api('/claim-submitters')); } catch (ex) { toast(ex.message, true); return; }
  users.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));

  openModal(`
    ${formHeadHtml(t('Export claims to Excel'))}
    <div class="modal-body">
      <form id="exportForm" class="form lf-form ex-form">
        <div class="meal-scroll">
          <section class="lf-sec">
            <div class="lf-sec-head"><h3>${esc(t('Date range'))}</h3></div>
            <p class="lf-hint">${esc(t('Leave dates blank to export all dates. Dates apply to the expense / meal date.'))}</p>
            <div class="grid2">
              <label>${esc(t('From date'))}<input name="from" type="date" value="${esc(state.filters.exportFrom || '')}" /></label>
              <label>${esc(t('To date'))}<input name="to" type="date" value="${esc(state.filters.exportTo || '')}" /></label>
            </div>
            <div class="date-presets" role="group" aria-label="${esc(t('Date range'))}">
              <button type="button" class="ex-chip" data-unit="month" data-off="0" aria-pressed="false">${esc(t('This month'))}</button>
              <button type="button" class="ex-chip" data-unit="month" data-off="1" aria-pressed="false">${esc(t('Last month'))}</button>
              <button type="button" class="ex-chip" data-unit="year" data-off="0" aria-pressed="false">${esc(t('This year'))}</button>
              <button type="button" class="ex-chip" data-unit="year" data-off="1" aria-pressed="false">${esc(t('Last year'))}</button>
            </div>
          </section>
          <section class="lf-sec">
            <div class="lf-sec-head"><h3>${esc(t('What to include'))}</h3></div>
            <div class="grid2 export-groups">
              ${[
                { title: 'Statuses to include', name: 'status', opts: EXPORT_STATUS_OPTS },
                { title: 'Claim types', name: 'types', opts: EXPORT_TYPE_OPTS }
              ].map(g => `
              <div class="export-group">
                <div class="eg-head">
                  <div class="section-label">${esc(t(g.title))}</div>
                  <button type="button" class="eg-toggle" data-group="${g.name}">${esc(t('Clear'))}</button>
                </div>
                <div class="check-list">
                  ${g.opts.map(o => `
                    <label class="check-row"><input type="checkbox" name="${g.name}" value="${o.v}" checked /><span>${esc(t(o.l))}</span></label>`).join('')}
                </div>
              </div>`).join('')}
            </div>
          </section>
          <section class="lf-sec">
            <div class="lf-sec-head"><h3>${esc(t('Users (submitters)'))}</h3><span class="lf-count" id="ufCount"></span></div>
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
          </section>
        </div>
        <p class="form-error" id="exportErr" hidden></p>
        <div class="modal-actions meal-foot">
          <div class="lf-total ex-summary" id="exSummary"></div>
          <button type="button" class="btn btn-ghost" id="exportCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(t('Download Excel'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide', 'modal-flex', 'modal-export');
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
    $$('.date-presets .ex-chip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    syncExportSummary();
  }));
  ['from', 'to'].forEach(n => $(`#exportForm [name="${n}"]`).addEventListener('input', () => {
    $$('.date-presets .ex-chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
    syncExportSummary();
  }));
  // Footer summary (what the download will cover) + the users counter.
  function syncExportSummary() {
    const f = $('#exportForm'); if (!f) return;
    const from = f.querySelector('[name="from"]').value, to = f.querySelector('[name="to"]').value;
    const range = from && to ? `${from} – ${to}` : from ? t('From {date}', { date: from }) : to ? t('Until {date}', { date: to }) : t('All dates');
    const picked = $$('#ufList input[name="employee"]').filter(cb => cb.checked).length;
    const users = t('{n} of {m} users', { n: picked, m: users_total });
    $('#exSummary').innerHTML = `<span class="lf-total-l">${esc(range)}</span><span class="lf-total-n">${esc(users)}</span>`;
    $('#ufCount').textContent = t('{n} of {m} selected', { n: picked, m: users_total });
  }
  const users_total = users.length;

  // Status / type groups: one header button per group that reads "Clear" while
  // every box is ticked and "Select all" otherwise, and flips the whole group.
  $$('.eg-toggle').forEach(btn => {
    const boxes = $$(`#exportForm input[name="${btn.dataset.group}"]`);
    const sync = () => { btn.textContent = boxes.every(cb => cb.checked) ? t('Clear') : t('Select all'); };
    btn.addEventListener('click', () => {
      const tick = !boxes.every(cb => cb.checked);
      boxes.forEach(cb => { cb.checked = tick; });
      sync();
    });
    boxes.forEach(cb => cb.addEventListener('change', sync));
  });

  // Excel-style user filter: search narrows the list; Select all / Clear act on
  // whatever rows are currently visible.
  const list = $('#ufList');
  const visibleBoxes = () => $$('.uf-item', list).filter(el => el.style.display !== 'none')
    .map(el => el.querySelector('input'));
  $('#ufSearch').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    $$('.uf-item', list).forEach(el => { el.style.display = el.dataset.name.includes(term) ? '' : 'none'; });
  });
  $('#ufAll').addEventListener('click', () => { visibleBoxes().forEach(cb => { cb.checked = true; }); syncExportSummary(); });
  $('#ufNone').addEventListener('click', () => { visibleBoxes().forEach(cb => { cb.checked = false; }); syncExportSummary(); });
  list.addEventListener('change', syncExportSummary);
  syncExportSummary();

  $('#exportForm').addEventListener('submit', async (e) => {
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
    if (types.length < EXPORT_TYPE_OPTS.length) p.set('types', types.join(','));
    if (emps.length < users.length) p.set('employees', emps.join(','));
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    // Remember the chosen range for next time.
    state.filters.exportFrom = from; state.filters.exportTo = to;
    // Fetch the workbook and save it from a blob rather than navigating to the
    // URL: closing the modal pops its Back-button history entry (history.back()),
    // which cancels a navigation still in flight — so the download never started.
    // This way the modal stays open (with any server error shown) until the file
    // is actually in hand.
    const btn = e.target.querySelector('button[type="submit"]');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = t('Preparing…');
    try {
      let res;
      try {
        res = await fetch('/api/export.xlsx?' + p.toString(), { credentials: 'same-origin' });
      } catch {
        throw new Error(navigator.onLine === false
          ? t('You appear to be offline. Check your connection and try again.')
          : t('Network error — could not reach the server. Please try again.'));
      }
      if (!res.ok) {
        let data = null;
        try { data = await res.json(); } catch { /* non-json */ }
        throw new Error((data && data.error) ? t(data.error) : `Request failed (${res.status})`);
      }
      const blob = await res.blob();
      const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m ? m[1] : 'claims.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      closeModal();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = orig;
    }
  });
}
