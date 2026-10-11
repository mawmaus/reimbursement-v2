'use strict';

// Date-change requests: the Super Admin's queue of legacy unlock requests.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// --- Date-change requests ----------------------------------------------------
// Returned claims used to resubmit with their dates locked, and claimants asked
// here to unlock them. Re-dating is automatic now (see claimFloor), so nothing
// new is raised; this is the Super Admin's queue for requests still waiting.
// Unlocking overrides the claim window itself, so it does not follow the
// per-region capability matrix.
function dcStatusChip(status) {
  const label = { pending: t('Waiting'), granted: t('Unlocked'), declined: t('Declined'), used: t('Used') }[status] || status;
  return `<span class="dc-chip dc-${esc(status)}">${esc(label)}</span>`;
}
function dcCardHtml(r) {
  const decided = r.status !== 'pending';
  const outcome = r.decided_name ? t('Decided by {name}', { name: r.decided_name }) : '';
  return `<div class="dc-card" data-id="${r.id}">
    <div class="dc-top">
      <div class="dc-who">
        <strong>${esc(r.claim_no)}</strong>
        <span class="muted">${esc(r.employee_name)} · ${esc(t(r.type_label))}</span>
      </div>
      ${dcStatusChip(r.status)}
    </div>
    <p class="dc-reason">${esc(r.reason)}</p>
    <div class="dc-foot">
      <span class="muted">${esc(fmtDateTime(r.created_at))}</span>
      ${decided
        ? `<span class="muted dc-outcome">${esc(outcome)}${r.decided_note ? ` — ${esc(r.decided_note)}` : ''}</span>`
        : `<div class="dc-actions">
             <button type="button" class="btn btn-ghost btn-sm" data-decline="${r.id}">${esc(t('Decline'))}</button>
             <button type="button" class="btn btn-primary btn-sm" data-grant="${r.id}">${esc(t('Unlock dates'))}</button>
           </div>`}
    </div>
  </div>`;
}
// Declining asks for an optional note, which the claimant sees in their email.
function openDeclineModal(onSend) {
  openModal2(`
    <div class="modal-head">
      <h2>${esc(t('Decline the date change'))}</h2>
      <button class="x-btn" id="dcdX" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">
      <form id="dcdForm" class="form">
        <label class="full">${esc(t('Note to the claimant (optional)'))}
          <textarea name="note" rows="3" maxlength="500" placeholder="${esc(t('e.g. the original dates look right — resubmit as they are'))}"></textarea>
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="dcdCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary">${esc(t('Decline'))}</button>
        </div>
      </form>
    </div>`);
  $('#dcdX').addEventListener('click', closeModal2);
  $('#dcdCancel').addEventListener('click', closeModal2);
  $('#dcdForm').addEventListener('submit', (e) => {
    e.preventDefault();
    closeModal2();
    onSend(String(new FormData(e.target).get('note') || '').trim());
  });
}
const isSuperUser = () => !!state.user && state.user.role === 'superadmin';
// The view behind the "Request change of date" tile: the Super Admin's queue.
function openDateChanges() {
  state.view = 'datechange';
  $('#homeView').hidden = true;
  $('#listView').hidden = true;
  const iv = $('#insightsView'); if (iv) iv.hidden = true;
  $('#dcView').hidden = false;
  renderDateChanges();
}
async function renderDateChanges() {
  const body = $('#dcBody');
  body.innerHTML = `<p class="muted" style="padding:28px 4px">${esc(t('Loading…'))}</p>`;
  let list = [], canDecide = false;
  try {
    const r = await api('/date-change-requests');
    list = r.requests || [];
    canDecide = !!r.can_decide;
  } catch (ex) { body.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  const pending = list.filter(r => r.status === 'pending');
  state.dcPending = canDecide ? pending.length : 0;
  const decided = list.filter(r => r.status !== 'pending');
  body.innerHTML = `
    <div class="dc-wrap">
      <p class="muted dc-intro">${esc(t('Claimants now re-date a returned claim themselves, to any date inside the claim window it was first submitted into. These are requests raised before that; unlocking one lets that claimant re-date it once, ignoring the claim window.'))}</p>
      ${canDecide ? `
        <h3 class="dc-head">${esc(t('Waiting for a decision'))}${pending.length ? ` <span class="dc-count">${pending.length}</span>` : ''}</h3>
        ${pending.length ? pending.map(dcCardHtml).join('') : `<p class="muted dc-empty">${esc(t('Nothing waiting.'))}</p>`}` : ''}
      ${canDecide && decided.length ? `
        <h3 class="dc-head" style="margin-top:26px">${esc(t('Recently decided'))}</h3>
        ${decided.map(dcCardHtml).join('')}` : ''}
    </div>`;
  const send = async (id, grant, note) => {
    try {
      await api(`/date-change-requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ grant, note: note || '' }) });
      toast(grant ? t('Dates unlocked — the claimant has been emailed.') : t('Request declined — the claimant has been emailed.'));
      await loadClaims();       // the decision changes what the claim payload carries
      renderDateChanges();
    } catch (ex) { toast(ex.message, true); }
  };
  $$('#dcBody [data-grant]').forEach(b => b.addEventListener('click', () => send(b.dataset.grant, true, '')));
  $$('#dcBody [data-decline]').forEach(b =>
    b.addEventListener('click', () => openDeclineModal(note => send(b.dataset.decline, false, note))));
  renderHome(); // keep the tile's badge in step with what we just fetched
}
