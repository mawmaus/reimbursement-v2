'use strict';

// Cash advance: the request form and the realization form.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Cash advance — a two-stage document. Stage 1: request the advance (purpose +
// amount), which runs the approver chain and is disbursed by finance. Stage 2
// (once paid): realize it by submitting the actual transactions as an itemised
// line table with receipts — the same editor as a reimbursement claim.
// ---------------------------------------------------------------------------
// Supporting documents on the open request form. `advDocs` holds the files
// picked in this session (already converted to PDF); `advKeptDocs` the ones
// already saved on a rejected request that the claimant is keeping. Both live
// outside the DOM so a re-render of the chips never loses them. A draft can't
// carry either — localStorage holds no files — so a saved draft comes back with
// the text fields only.
let advDocs = [];
let advKeptDocs = [];
let advEditId = null;
function advDocChips() {
  const kept = advKeptDocs.map((a, i) =>
    `<span class="file-chip file-chip-saved">` +
    `<a href="/api/cash-advances/${advEditId}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.original_name)}</a>` +
    `<button type="button" data-doc="kept" data-i="${i}" aria-label="${esc(t('Remove'))} ${esc(a.original_name)}">×</button></span>`);
  const picked = advDocs.map((f, i) =>
    `<span class="file-chip">${esc(f.name)} <span class="file-chip-size">${esc(fmtBytes(f.size))}</span>` +
    `<button type="button" data-doc="new" data-i="${i}" aria-label="${esc(t('Remove'))} ${esc(f.name)}">×</button></span>`);
  return kept.concat(picked).join('');
}
function renderAdvDocs() {
  const wrap = $('#advDocChips'); if (!wrap) return;
  wrap.innerHTML = advDocChips();
  $$('#advDocChips button').forEach(b => b.addEventListener('click', () => {
    (b.dataset.doc === 'kept' ? advKeptDocs : advDocs).splice(+b.dataset.i, 1);
    renderAdvDocs();
  }));
}
// Stage 1 request form: purpose + amount + supporting documents (+ Approver 1
// when chooseable). Reused for editing a rejected request.
function openAdvanceRequestModal(existing = null) {
  const isEdit = !!existing;
  const draft = isEdit ? null : draftForForm('advance');
  advDocs = [];
  advKeptDocs = isEdit ? (existing.attachments || []).map(a => ({ id: a.id, original_name: a.original_name })) : [];
  advEditId = isEdit ? existing.id : null;
  // For a new request, seed the fields from the saved draft if there is one.
  const prePurpose = isEdit ? (existing.purpose || '') : (draft ? draft.data.purpose || '' : '');
  const preAmount = isEdit
    ? (existing.amount != null ? groupAmount(String(Math.round(existing.amount))) : '')
    : (draft ? groupAmount(String(draft.data.amount || '')) : '');
  openModal(`
    ${formHeadHtml(isEdit ? t('Edit & resubmit cash advance') : t('New cash advance'))}
    <div class="modal-body">
      <form id="advForm" class="form lf-form">
        ${draft ? draftBannerHtml() : ''}
        <p class="form-error" id="advError" hidden></p>
        <div class="meal-scroll">
          <section class="lf-sec">
            <div class="lf-sec-head"><h3>${esc(t('Request details'))}</h3></div>
            <p class="lf-hint">${esc(t('Ask for a cash advance up front. Once it is approved and paid, you will settle it by submitting your actual transactions.'))}</p>
            <label class="full">${reqLabel(t('Purpose of the cash advance'))}
              <textarea name="purpose" rows="3" required placeholder="${esc(t('What is this advance for?'))}">${esc(prePurpose)}</textarea></label>
            <label class="full">${reqLabel(t('Amount needed'))}
              <div class="amt-field"><span class="amt-cur" aria-hidden="true">${esc(regionCurrency())}</span>
                <input name="amount" inputmode="decimal" required placeholder="0" value="${esc(preAmount)}" /></div></label>
          </section>
          <section class="lf-sec">
            <div class="full adv-docs">
              <div class="adv-docs-head">
                <span class="adv-docs-label">${esc(t('Supporting documents (optional)'))}</span>
                <span class="adv-docs-btns">
                  <button type="button" class="btn btn-brand-soft btn-sm rc-cam" id="advDocCam">📷 ${esc(t('Take photo'))}</button>
                  <button type="button" class="btn btn-brand-soft btn-sm" id="advDocAdd">📎 ${esc(t('Attach file'))}</button>
                </span>
              </div>
              <p class="adv-docs-hint muted">${esc(t('A quotation, proforma invoice or booking confirmation. Attach a PDF or a photo — photos are converted to PDF automatically. Up to 8 files, 10 MB each.'))}</p>
              <div class="file-chips" id="advDocChips"></div>
              <input type="file" id="advDocInput" multiple hidden accept=".pdf,image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif" />
            </div>
          </section>
          ${approvalSectionHtml(approver1PickerHtml(existing) + (isEdit ? resubmitNoteHtml() : ''))}
        </div>
        <div class="modal-actions meal-foot">
          <button type="button" class="btn btn-ghost" id="advCancel">${esc(t('Cancel'))}</button>
          ${isEdit ? '' : `<button type="button" class="btn btn-ghost" id="advSaveDraft">${esc(t('Save draft'))}</button>`}
          <button type="submit" class="btn btn-primary">${isEdit ? esc(t('Resubmit request')) : esc(t('Submit request'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-flex', 'modal-adv');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#advCancel').addEventListener('click', isEdit ? closeModal : () => discardDraftAndClose('advance'));
  const amt = $('#advForm [name="amount"]');
  amt.addEventListener('input', e => { e.target.value = groupAmount(e.target.value); });
  $('#advDocAdd').addEventListener('click', () => pickFiles($('#advDocInput'), false));
  $('#advDocCam').addEventListener('click', () => pickFiles($('#advDocInput'), true));
  $('#advDocInput').addEventListener('change', async (ev) => {
    const btn = $('#advDocAdd'), label = btn.innerHTML;
    btn.disabled = true; btn.textContent = t('Converting…');
    try {
      advDocs = advDocs.concat(await processAdvanceDocs(ev.target.files, advDocs.length + advKeptDocs.length));
    } finally {
      btn.disabled = false; btn.innerHTML = label;
      ev.target.value = ''; // so re-picking the same file fires change again
      renderAdvDocs();
    }
  });
  renderAdvDocs();
  $('#advForm').addEventListener('submit', e => submitAdvanceRequest(e, existing));
  if (!isEdit) {
    if (draft && draft.data.approver1) {
      const sel = $('#advForm [name="approver1"]'); if (sel) sel.value = draft.data.approver1;
    }
    $('#advSaveDraft').addEventListener('click', () => saveDraftAndClose('advance', collectAdvanceDraft, collectAdvanceDocFiles));
    armDraftAutosave('advance', collectAdvanceDraft, collectAdvanceDocFiles);
    if (draft) wireDraftBanner('advance');
    // Bring the draft's documents back from IndexedDB (they are already PDFs,
    // so nothing is re-converted) and redraw the chips once they land.
    if (draft) loadDraftFiles('advance').then(perRow => {
      if (!perRow || !Array.isArray(perRow[0])) return;
      advDocs = perRow[0];
      renderAdvDocs();
    });
  }
}
// Gather the cash-advance form's fields into a draft payload, or null when the
// form is effectively empty. A document attached on its own is worth keeping,
// so it counts as content even with no purpose or amount typed yet.
function collectAdvanceDraft() {
  const f = $('#advForm'); if (!f) return null;
  const purpose = ((f.querySelector('[name="purpose"]') || {}).value || '').trim();
  const amountRaw = ((f.querySelector('[name="amount"]') || {}).value || '');
  const amount = String(amountRaw).replace(/[^0-9.]/g, '');
  if (!purpose && !amount && !advDocs.length) return null;
  const approver1 = ((f.querySelector('[name="approver1"]') || {}).value) || '';
  return { purpose, amount, approver1 };
}
// The supporting documents to persist alongside the draft. Shaped as the
// per-"row" array saveDraftFiles expects; a cash advance has just the one.
function collectAdvanceDocFiles() { return [advDocs.slice()]; }

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
  const label = btn.textContent;
  btn.disabled = true;
  const payload = { purpose, amount, currency: regionCurrency() };
  if (needsApprover1) payload.approver1 = Number(approver1);
  try {
    // Documents go to Blob first (same routing as receipts); the request itself
    // then carries only their metadata.
    if (advDocs.length) btn.textContent = t('Uploading documents…');
    payload.attachments = advDocs.length ? await uploadReceipts(advDocs) : [];
    btn.textContent = t('Submitting…');
    if (existing) {
      payload.resubmit_note = String(fd.get('resubmit_note') || '').trim();
      payload.keep_attachment_ids = advKeptDocs.map(a => a.id);
      await api('/cash-advances/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(t('Cash advance resubmitted'));
    } else {
      await api('/cash-advances', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('Cash advance requested'));
      clearDraft('advance');
    }
    modalCloseHook = null; // submitted — don't auto-save a draft on close
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = label; }
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
  // Only a rejected realization carries its dates through; a first one is fresh.
  setClaimDateContext(isEdit ? advance : null);
  claimEditId = advance.id;
  rcAttachBase = '/api/cash-advances';
  if (isEdit && activeLines(advance).length) {
    // Rejected lines stay on the advance as history; only the live ones are edited.
    claimRows = activeLines(advance).map(l => ({
      line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: l.amount != null ? String(l.amount) : '', description: l.description || '',
      carried: !claimDateUnlocked(),
      files: [], kept: (l.attachments || []).map(a => ({ id: a.id, original_name: a.original_name }))
    }));
    if (!claimRows.length) claimRows = [blankClaimRow(todayWIB())];
  } else {
    claimRows = [blankClaimRow(todayWIB())];
  }
  openModal(`
    ${formHeadHtml(t('Realize cash advance {no}', { no: advance.advance_no }))}
    <div class="modal-body">
      <form id="realizeForm" class="form lf-form">
        <div id="advDiffWrap">${realizeDiffBanner(advance.amount)}</div>
        <p class="form-error" id="claimError" hidden></p>
        <div class="meal-scroll">
          <section class="lf-sec">
            ${linesSectionHead(t('Realization — actual transactions'), t('Account for the advance: one row per expense, with that expense\'s receipts attached (PDF or images, up to 8 per row).'))}
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
            <button type="button" class="lf-add" id="rcAddRow">${esc(t('+ Add another line'))}</button>
            <div id="claimDateBox"></div>
          </section>
          ${approvalSectionHtml(approver1PickerHtml(isEdit ? advance : null) + (isEdit ? resubmitNoteHtml() : ''))}
        </div>
        <div class="modal-actions meal-foot">
          ${footTotalHtml('rcTotal')}
          <button type="button" class="btn btn-ghost" id="cancelRealize">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(t('Submit realization'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#cancelRealize').addEventListener('click', closeModal);
  $('#rcAddRow').addEventListener('click', () => { readClaimRows(); claimRows.push(blankClaimRow()); renderClaimRows(); });
  renderClaimDateBox();
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
    if (!r.line_date) { flagClaimRow(err, r, t('Enter the date.'), 'line_date'); return; }
    if (r.expense_type === 'Others' && !String(r.expense_type_other || '').trim()) {
      flagClaimRow(err, r, t('Specify the type of expense.'), 'expense_type_other'); return;
    }
    if (!rowType(r)) { flagClaimRow(err, r, t('Choose the type of expense.'), 'expense_type'); return; }
    if (rcAmt(r.amount) <= 0) { flagClaimRow(err, r, t('Enter an amount above 0.'), 'amount'); return; }
  }
  const dateErr = claimDatesError(rows.map(r => r.line_date));
  if (dateErr) { err.textContent = dateErr; err.hidden = false; return; }
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
    : diff < 0 ? t('Confirm that the employee has returned the unused {amt}. The cash advance is cleared once you confirm.', { amt: money(-diff, c.currency) })
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
          <button type="submit" class="btn btn-primary">${esc(diff < 0 ? t('Confirm refund received') : t('Confirm settlement'))}</button>
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
      toast(diff < 0 ? t('Refund confirmed — cash advance cleared') : t('Cash advance settled'));
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#settleErr'); el.textContent = ex.message; el.hidden = false; btn.disabled = false; }
  });
}
