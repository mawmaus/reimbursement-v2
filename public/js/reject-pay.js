'use strict';

// Reject a document, and mark it paid.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Reject modal
// ---------------------------------------------------------------------------
// Mark as paid — a payment date must be chosen before the claim can be recorded
// as paid. Defaults to today; the confirm button stays disabled until a date is
// present.
function openPaidModal(c) {
  const today = todayWIB();
  openModal(`
    <div class="modal-head"><h2>${esc(t('Mark {no} as paid', { no: c.claim_no }))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="paidForm" class="form">
        <label>${esc(t('Payment date'))}
          <input type="date" name="payment_date" value="${today}" max="${today}" required /></label>
        <p class="muted" style="margin:2px 0 0;font-size:.85rem">${esc(t('The date the payment was actually made.'))}</p>
        <p class="form-error" id="paidErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="paidCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary" id="paidConfirm">${esc(t('Mark as paid'))}</button>
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
    const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
    try {
      await api(`${base}${c.id}/mark-paid`, { method: 'POST', body: JSON.stringify({ payment_date }) });
      toast(t('Marked as paid'));
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#paidErr'); el.textContent = ex.message; el.hidden = false; }
  });
}

// Revert + re-route. When the revert leaves the document waiting on Approver 1
// again, it doubles as the chance to hand it to a different one — the same
// choice the claimant gets on the submit form. Only opened when there are two
// or more candidates (revertApprover1Choices); otherwise revert is a confirm.
function openRevertModal(c) {
  const info = revertInfo(c);
  const choices = revertApprover1Choices(c);
  const cur = (c.approvers && c.approvers[0]) || null;
  const curId = cur ? String(cur.id) : '';
  // A first approver from outside the candidate pool (a fixed chain, or a pool
  // edited since the claim was submitted) still needs a "leave it as it is"
  // option — an empty value, which the server reads as "no change".
  const inPool = choices.some(o => String(o.id) === curId);
  const opts = (inPool ? '' : `<option value="" selected>${esc(cur ? cur.name : t('Choose an approver…'))}</option>`)
    + choices.map(o => `<option value="${o.id}"${String(o.id) === curId ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
  openModal(`
    <div class="modal-head"><h2>${esc(t('Revert {no}', { no: c.claim_no }))}</h2>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button></div>
    <div class="modal-body">
      <form id="revertForm" class="form">
        <p style="margin:0 0 6px">${esc(info.confirm)}</p>
        <label class="full">${esc(t('Approver 1'))}
          <select name="approver1">${opts}</select></label>
        <p class="muted" style="margin:2px 0 0;font-size:.85rem">${esc(t('It goes back to this approver — keep the current one, or hand it to someone else.'))}</p>
        <p class="form-error" id="revertErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="revertCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(info.label)}</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#revertCancel').addEventListener('click', closeModal);
  $('#revertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const approver1 = String(new FormData(e.target).get('approver1') || '');
    const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
    const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
    try {
      const out = await api(`${base}${c.id}/revert`, {
        method: 'POST',
        body: JSON.stringify(approver1 ? { approver1: Number(approver1) } : {})
      });
      const next = (out && out.claim && (out.claim.approvers || [])[0]) || null;
      toast(next && String(next.id) !== curId
        ? t('Reverted — now with {name}', { name: next.name }) : t('Reverted'));
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#revertErr'); el.textContent = ex.message; el.hidden = false; btn.disabled = false; }
  });
}

// ---------------------------------------------------------------------------
function openRejectModal(c) {
  openModal(`
    <div class="modal-head"><h2>${esc(t('Reject {no}', { no: c.claim_no }))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="rejectForm" class="form">
        <label>${esc(t('Reason for rejection (sent back to the claimant)'))}
          <textarea name="comment" required placeholder="${esc(t('Explain what needs to change…'))}"></textarea></label>
        <p class="form-error" id="rejErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="rejCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-danger">${esc(t('Reject & return'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#rejCancel').addEventListener('click', closeModal);
  $('#rejectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const comment = new FormData(e.target).get('comment').trim();
    const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
    try {
      await api(`${base}${c.id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) });
      toast(t('Claim returned to claimant'));
      closeModal(); closeDrawer(); loadAll();
    } catch (ex) { const el = $('#rejErr'); el.textContent = ex.message; el.hidden = false; }
  });
}
