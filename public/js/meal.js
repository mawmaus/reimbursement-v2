'use strict';

// New / edit meal allowance.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

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
  return `<tr data-i="${i}" data-n="${esc(t('Line {n}', { n: i + 1 }))}">
    <td data-label="${esc(t('Date'))}">${claimDateInput('date', r.date, r.carried)}</td>
    <td data-label="${esc(t('DB Number Site'))}">${dbCellHtml(r.site)}</td>
    <td data-label="${esc(t('Job Category'))}"><input name="category" value="${esc(r.category || '')}" placeholder="${i ? '' : esc(t('Install / Repair / Service…'))}" /></td>
    <td data-label="${esc(t('Amount'))}">${mealAmountSelect(r.amount)}</td>
    <td data-label="${esc(t('Additional Description'))}"><input name="desc" value="${esc(r.desc || '')}" placeholder="${i ? '' : esc(t('Surabaya'))}" /></td>
    <td class="meal-x"><button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove'))}">×</button></td>
  </tr>`;
}
function readMealRows() {
  // Rebuilt from the DOM, so `carried` (not a field) is carried over by index.
  mealRows = $$('#mealRows tr[data-i]').map(tr => ({
    date: tr.querySelector('[name="date"]').value,
    site: dbCellRead(tr),
    category: tr.querySelector('[name="category"]').value,
    amount: tr.querySelector('[name="amount"]').value,
    desc: tr.querySelector('[name="desc"]').value,
    carried: !!(mealRows[+tr.dataset.i] || {}).carried
  }));
}
function mealTotal() { return mealRows.reduce((s, r) => s + mealAmount(r.amount), 0); }
function renderMealRows() {
  $('#mealRows').innerHTML = mealRows.length
    ? mealRows.map(mealRowHtml).join('')
    : `<tr><td colspan="6" class="muted" style="padding:14px;text-align:center">${esc(t('No rows yet — add one below.'))}</td></tr>`;
  $('#mealTotal').textContent = liveAmt(mealTotal());
  syncLineCount(mealRows.filter(r => mealAmount(r.amount) > 0).length);
  $$('#mealRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    readMealRows(); mealRows.splice(+b.dataset.rm, 1); renderMealRows();
  }));
  $$('#mealRows .meal-amt').forEach(sel => sel.addEventListener('change', () => {
    readMealRows(); $('#mealTotal').textContent = liveAmt(mealTotal());
    syncLineCount(mealRows.filter(r => mealAmount(r.amount) > 0).length);
  }));
  wireDbCells('#mealRows');
}

// `reclaim` opens a NEW meal claim prefilled with another one's rejected lines.
async function openMealAllowanceModal(existing = null, reclaim = null) {
  // Refresh the Amount-dropdown presets for the submitter's region every time the
  // form opens. state.mealRates is seeded at login but can be stale (e.g. an admin
  // just changed them in Settings), so re-fetch to keep the form connected to the
  // saved amounts. A failure keeps whatever presets we already have.
  try { state.mealRates = (await api('/meal-rates')).rates || state.mealRates; } catch { /* keep current */ }
  const isEdit = !!existing;
  setClaimDateContext(isEdit ? existing : reclaim ? { date_floor: reclaim.floor, lines: reclaim.lines } : null);
  const fresh = !isEdit && !reclaim;
  const draft = fresh ? loadDraft('meal') : null;
  if (isEdit || reclaim) {
    // Prefill from the claim being resubmitted (its live lines only), or from
    // the rejected lines being re-claimed.
    mealRows = (isEdit ? activeLines(existing) : reclaim.lines).map(l => ({
      date: l.line_date, site: l.site, category: l.job_category,
      amount: l.amount != null ? Math.round(l.amount) : '', desc: l.description, carried: !claimDateUnlocked()
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
    ${formHeadHtml(isEdit ? t('Edit & resubmit meal allowance') : reclaim ? t('Re-claim rejected lines') : t('Meal Allowance Claim Form'))}
    <div class="modal-body">
      <form id="mealForm" class="form lf-form">
        ${draft ? draftBannerHtml() : ''}
        ${reclaim ? reclaimNoteHtml(reclaim) : ''}
        <p class="form-error" id="mealError" hidden></p>
        <div class="meal-scroll">
          <section class="lf-sec">
            ${linesSectionHead(t('Meal allowance lines'))}
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
            <button type="button" class="lf-add" id="mealAddRow">${esc(t('+ Add another line'))}</button>
            <div id="claimDateBox"></div>
          </section>
          ${approvalSectionHtml(approver1PickerHtml(existing) + (isEdit ? resubmitNoteHtml() : ''))}
        </div>
        <div class="modal-actions meal-foot">
          ${footTotalHtml('mealTotal')}
          <button type="button" class="btn btn-ghost" id="mealCancel">${esc(t('Cancel'))}</button>
          ${fresh ? `<button type="button" class="btn btn-ghost" id="mealSaveDraft">${esc(t('Save draft'))}</button>` : ''}
          <button type="submit" class="btn btn-primary">${isEdit ? esc(t('Resubmit claim')) : esc(t('Submit claim'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#mealCancel').addEventListener('click', fresh ? () => discardDraftAndClose('meal') : closeModal);
  $('#mealAddRow').addEventListener('click', () => {
    readMealRows(); mealRows.push({ date: '', site: '', category: '', amount: '', desc: '' }); renderMealRows();
  });
  $('#mealForm').addEventListener('submit', e => submitMealClaim(e, existing, reclaim));
  renderClaimDateBox();
  renderMealRows();
  if (fresh) {
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

async function submitMealClaim(e, existing, reclaim = null) {
  e.preventDefault();
  readMealRows();
  const err = $('#mealError'); err.hidden = true;
  const lines = mealRows
    .filter(r => r.date || r.site || r.category || r.desc || mealAmount(r.amount))
    .map(r => ({ date: r.date, site: r.site, category: r.category, amount: mealAmount(r.amount), desc: r.desc }));
  if (!lines.length) { err.textContent = t('Add at least one line with a date and amount'); err.hidden = false; return; }
  // Claim-date policy, with the same carry-over exemption as reimbursement claims.
  const dateErr = claimDatesError(lines.map(l => l.date));
  if (dateErr) { err.textContent = dateErr; err.hidden = false; return; }
  const needsApprover1 = (state.user.approver1_choices || []).length >= 2;
  const approver1 = String((new FormData(e.target).get('approver1') || '')).trim();
  if (needsApprover1 && !approver1) { err.textContent = t('Please choose Approver 1.'); err.hidden = false; return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  const payload = { lines };
  if (needsApprover1) payload.approver1 = Number(approver1);
  if (existing) payload.resubmit_note = (new FormData(e.target).get('resubmit_note') || '').trim();
  if (reclaim) payload.source = { type: reclaim.type, id: reclaim.id, line_ids: reclaim.lines.map(l => l.id) };
  try {
    if (existing) {
      await api('/meal-claims/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(t('Meal claim resubmitted'));
    } else {
      await api('/meal-claims', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('Meal claim submitted'));
      if (!reclaim) clearDraft('meal');
    }
    modalCloseHook = null; // submitted — don't auto-save a draft on close
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
}
$('#newMealBtn').addEventListener('click', () => {
  if (advanceHold()) return toast(advanceHoldReason(), true);
  openMealAllowanceModal();
});
