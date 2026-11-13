'use strict';

// Accounts in Excel (Super Admin → Settings → Accounts → Excel): export a
// market's accounts or a blank template, and import a filled-in copy —
// preview first, then all-or-nothing. The server (routes/accounts-xlsx.js)
// checks every row by the account form's rules; this only shows what it found.
// A plain <script> sharing globals with app.js and js/accounts.js.

function openAccountsExcelMenu(btn) {
  openRowMenu(btn, 'acct-excel', [
    { act: 'export', label: settingsState.region ? t('Export {region} accounts', { region: settingsState.region }) : t('Export all accounts') },
    { act: 'template', label: t('Download blank template') },
    { act: 'import', label: t('Import from Excel…') }
  ], (act) => {
    if (act === 'import') openAccountsImport();
    else downloadAccountsXlsx(act === 'template');
  });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function downloadAccountsXlsx(template) {
  const p = new URLSearchParams();
  if (settingsState.region) p.set('region', settingsState.region);
  if (template) p.set('template', '1');
  const btn = $('#acctExcelBtn');
  if (btn) btn.disabled = true;
  try {
    let res;
    try { res = await fetch('/api/users/export.xlsx?' + p.toString(), { credentials: 'same-origin' }); }
    catch { throw new Error(t('Network error — could not reach the server. Please try again.')); }
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* non-json */ }
      throw new Error((data && data.error) ? t(data.error) : `Request failed (${res.status})`);
    }
    const blob = await res.blob();
    const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    saveBlob(blob, m ? m[1] : 'accounts.xlsx');
  } catch (ex) { toast(ex.message, true); }
  finally { if (btn) btn.disabled = false; }
}

// Field names for the change list (keys from lib/accounts-import.js).
const AX_FIELD = () => ({
  full_name: t('Full name'), email: t('Email'), role: t('Role'), region: t('Region'), department: t('Department'),
  position: t('Job position'), approver_ids: t('Approval chain'), approver1_options: t('Approver 1 choices'),
  managed_by: t('Managed by'), approval_limit: t('Approval limit'), can_mark_paid: t('Can mark paid'),
  allow_advance: t('Cash advance'), bank_name: t('Bank name'), recipient_name: t('Recipient name'),
  bank_account_no: t('Bank account no.'), base: t('Base'), active: t('Active'), password: t('Password')
});
function axValue(key, v) {
  if (v === '' || v == null) return key === 'approval_limit' ? esc(t('Unlimited')) : '<span class="muted">—</span>';
  if (key === 'role') return esc(roleLabel(v));
  if (key === 'region') return esc(regionLabel(v));
  if (key === 'approval_limit') return esc(Number(v).toLocaleString());
  if (typeof v === 'boolean') return esc(v ? t('Yes') : t('No'));
  return esc(String(v));
}

function openAccountsImport() {
  let file = null;      // the chosen workbook (ArrayBuffer), sent again on apply
  let fileName = '';
  let chosenRegion = settingsState.region || '';
  const regions = state.lookups.regions || [];
  openModal2(`
    <div class="modal-head">
      <h2>${esc(t('Import accounts'))}</h2>
      <button type="button" class="x-btn" id="axClose">×</button>
    </div>
    <div class="modal-body ax-body" id="axBody"></div>`);
  $('#modal2').classList.add('modal-wide', 'modal-flex', 'modal-ax');
  $('#axClose').addEventListener('click', closeModal2);
  const body = () => $('#axBody');

  // Step 1: market + file.
  function pickStep(err) {
    body().innerHTML = `
      <div class="ax-scroll">
        <p class="ax-lead">${esc(t('Add accounts in bulk, or change existing ones, from the accounts Excel file. Nothing is saved until you have checked the preview.'))}</p>
        <ol class="ax-steps">
          <li>${esc(t('Export the accounts (or a blank template) from the Excel menu.'))}</li>
          <li>${esc(t('Add a row per new person, or edit existing rows. The "How to use" sheet explains each column.'))}</li>
          <li>${esc(t('Upload the saved file here.'))}</li>
        </ol>
        <label class="ax-field">${esc(t('Region for rows with a blank Region'))}
          <select id="axRegion">
            <option value="">${esc(t('— none (Region is required on every row) —'))}</option>
            ${regions.map(r => `<option value="${esc(r)}" ${r === chosenRegion ? 'selected' : ''}>${esc(r)}</option>`).join('')}
          </select></label>
        <label class="drop ax-drop" id="axDrop" tabindex="0">
          <input type="file" id="axFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden />
          <span class="ax-drop-icon" aria-hidden="true">⇪</span>
          <span><strong>${esc(t('Choose an Excel file'))}</strong> ${esc(t('or drop it here'))}</span>
          <span class="ax-drop-sub">${esc(t('.xlsx, up to 4 MB'))}</span>
        </label>
        <p class="form-error" id="axErr" ${err ? '' : 'hidden'}>${esc(err || '')}</p>
      </div>`;
    const sel = $('#axRegion');
    if (typeof enhanceSelect === 'function') enhanceSelect(sel);
    sel.addEventListener('change', () => { chosenRegion = sel.value; });
    const drop = $('#axDrop'), inp = $('#axFile');
    const take = async (f) => {
      if (!f) return;
      if (!/\.xlsx$/i.test(f.name)) { pickStep(t('Choose an .xlsx file — save the sheet as an Excel workbook first.')); return; }
      if (f.size > 4 * 1024 * 1024) { pickStep(t('The file is larger than 4 MB.')); return; }
      file = await f.arrayBuffer(); fileName = f.name;
      chosenRegion = sel.value;
      preview();
    };
    inp.addEventListener('change', () => take(inp.files[0]));
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); take(e.dataTransfer.files[0]); });
  }

  async function send(mode) {
    let res;
    try {
      res = await fetch(`/api/users/import?mode=${mode}&region=${encodeURIComponent(chosenRegion)}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file
      });
    } catch { throw new Error(t('Network error — could not reach the server. Please try again.')); }
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (!res.ok && !(data && data.issues)) throw new Error((data && data.error) ? t(data.error) : `Request failed (${res.status})`);
    return data;
  }

  // Step 2: what the file would do.
  async function preview() {
    body().innerHTML = `<p class="muted ax-wait">${esc(t('Checking {file}…', { file: fileName }))}</p>`;
    let p;
    try { p = await send('preview'); } catch (ex) { pickStep(ex.message); return; }
    const F = AX_FIELD();
    const nNew = p.creates.length, nUpd = p.updates.length, nBad = p.issues.length;
    const badRows = new Set(p.issues.map(i => i.row)).size;
    const stat = (cls, n, label) => n ? `<span class="ax-stat ax-stat-${cls}"><b>${n}</b> ${esc(label)}</span>` : '';
const canGo = !nBad && (nNew || nUpd);
    body().innerHTML = `
      <div class="ax-scroll">
        <div class="ax-file"><span class="ax-file-name">${esc(fileName)}</span><button type="button" class="btn btn-ghost btn-sm" id="axOther">${esc(t('Choose another file'))}</button></div>
        <div class="ax-stats">
          ${stat('new', nNew, t('new'))}
          ${stat('upd', nUpd, t('changed'))}
          ${stat('same', p.unchanged, t('unchanged'))}
          ${stat('bad', badRows, badRows === 1 ? t('row with problems') : t('rows with problems'))}
        </div>
        ${nBad ? `
        <section class="ax-sec ax-sec-bad">
          <h3>${esc(t('Problems to fix'))}</h3>
          <p class="ax-hint">${esc(t('Fix these rows in the file, save it, and upload it again. Nothing is imported while any row has a problem.'))}</p>
          <table class="utable ax-table ax-issues"><thead><tr><th>${esc(t('Row'))}</th><th>${esc(t('Username'))}</th><th>${esc(t('Problem'))}</th></tr></thead><tbody>
          ${p.issues.map(i => `<tr><td class="mono" data-label="${esc(t('Row'))}">${i.row || '—'}</td><td class="mono" data-label="${esc(t('Username'))}">${esc(i.username || '—')}</td><td data-label="${esc(t('Problem'))}">${esc(t(i.msg, i.params || {}))}</td></tr>`).join('')}
          </tbody></table>
        </section>` : ''}
        ${nNew ? `
        <section class="ax-sec">
          <h3>${esc(t('New accounts'))}</h3>
          <table class="utable ax-table"><thead><tr><th>${esc(t('User'))}</th><th>${esc(t('Role'))}</th><th>${esc(t('Dept / Position'))}</th><th>${esc(t('Password'))}</th></tr></thead><tbody>
          ${p.creates.map(c => `<tr>
            <td data-label="${esc(t('User'))}"><div class="u-name">${esc(c.full_name)}</div><div class="u-sub"><span class="mono">${esc(c.username)}</span> · ${esc(regionLabel(c.region))}</div></td>
            <td data-label="${esc(t('Role'))}">${esc(roleLabel(c.role))}</td>
            <td data-label="${esc(t('Dept / Position'))}"><div>${c.department ? esc(c.department) : '<span class="muted">—</span>'}</div>${c.position ? `<div class="u-sub">${esc(c.position)}</div>` : ''}</td>
            <td data-label="${esc(t('Password'))}">${c.generated ? `<span class="pill pill-on">${esc(t('Generated'))}</span>` : `<span class="muted">${esc(t('From the file'))}</span>`}</td>
          </tr>`).join('')}
          </tbody></table>
        </section>` : ''}
        ${nUpd ? `
        <section class="ax-sec">
          <h3>${esc(t('Changes to existing accounts'))}</h3>
          ${p.updates.map(u => `<div class="ax-upd">
            <div class="ax-upd-who"><span class="u-name">${esc(u.full_name)}</span><span class="u-sub mono">${esc(u.username)}</span></div>
            <ul class="ax-changes">${u.changes.map(c => c.key === 'password'
              ? `<li><span class="ax-k">${esc(F.password)}</span><span class="ax-vals"><span class="ax-to">${esc(t('reset to the one in the file'))}</span></span></li>`
              : `<li><span class="ax-k">${esc(F[c.key] || c.key)}</span><span class="ax-vals"><span class="ax-from">${axValue(c.key, c.from)}</span><span class="ax-arrow" aria-hidden="true">→</span><span class="ax-to">${axValue(c.key, c.to)}</span></span></li>`).join('')}</ul>
          </div>`).join('')}
        </section>` : ''}
        ${!nNew && !nUpd && !nBad ? `<p class="ax-empty">${esc(t('Everything in this file already matches the portal — there is nothing to import.'))}</p>` : ''}
      </div>
      <div class="ax-foot">
        <p class="form-error" id="axErr" hidden></p>
        <button type="button" class="btn btn-ghost btn-sm" id="axCancel">${esc(canGo ? t('Cancel') : t('Close'))}</button>
        ${canGo ? `<button type="button" class="btn btn-primary btn-sm" id="axGo">${esc(
          nNew && nUpd ? t('Create {n} and update {m}', { n: nNew, m: nUpd })
          : nUpd ? t('Update {m} accounts', { m: nUpd }) : t('Create {n} accounts', { n: nNew }))}</button>` : ''}
      </div>`;
    $('#axOther').addEventListener('click', () => pickStep());
    $('#axCancel').addEventListener('click', closeModal2);
    if (canGo) $('#axGo').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = t('Importing…');
      try {
        const r = await send('apply');
        if (r.issues) { preview(); return; } // something changed since the preview
        done(r);
      } catch (ex) {
        const el = $('#axErr'); el.textContent = ex.message; el.hidden = false;
        btn.disabled = false; btn.textContent = t('Try again');
      }
    });
  }

  // Step 3: the result, plus any passwords the portal made (shown this once).
  function done(r) {
    renderAccountsTab();
    const creds = r.credentials || [];
    body().innerHTML = `
      <div class="ax-scroll">
        <div class="ax-done"><span class="ax-done-mark" aria-hidden="true">✓</span>
          <div><h3>${esc(t('Import complete'))}</h3>
          <p>${esc(t('{n} created · {m} updated', { n: r.created, m: r.updated }))}</p></div></div>
        ${creds.length ? `
        <p class="form-note caution ax-creds-note">${esc(t('These passwords are shown only now. Download them and share each one privately — people can change theirs after signing in.'))}</p>
        <table class="utable ax-table"><thead><tr><th>${esc(t('User'))}</th><th>${esc(t('Username'))}</th><th>${esc(t('Password'))}</th></tr></thead><tbody>
        ${creds.map(c => `<tr><td data-label="${esc(t('User'))}">${esc(c.full_name)}</td><td class="mono" data-label="${esc(t('Username'))}">${esc(c.username)}</td><td class="mono" data-label="${esc(t('Password'))}">${esc(c.password)}</td></tr>`).join('')}
        </tbody></table>` : ''}
      </div>
      <div class="ax-foot">
        ${creds.length ? `<button type="button" class="btn btn-ghost btn-sm" id="axCreds">${esc(t('Download sign-ins (.csv)'))}</button>` : ''}
        <button type="button" class="btn btn-primary btn-sm" id="axDone">${esc(t('Done'))}</button>
      </div>`;
    $('#axDone').addEventListener('click', closeModal2);
    const cb = $('#axCreds');
    if (cb) cb.addEventListener('click', () => {
      const cell = (s) => /[",\r\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
      const csv = '﻿' + [['Full name', 'Username', 'Password'], ...creds.map(c => [c.full_name, c.username, c.password])]
        .map(row => row.map(cell).join(',')).join('\r\n');
      saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `new-sign-ins-${new Date().toISOString().slice(0, 10)}.csv`);
    });
  }

  pickStep();
}
