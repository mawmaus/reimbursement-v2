'use strict';

// Profile: bank / payout details and change password.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Profile — bank / payout details + change password (self-service, all users)
// ---------------------------------------------------------------------------
$('#profileBtn').addEventListener('click', () => openProfileModal());

// Bank name is picked from a short list (the region's preferred bank / Others).
// "Others" reveals a free text field for the actual bank name and shows a red
// fee note, since payouts to any non-preferred bank are charged the region's
// configured fee. The preferred bank and fee come from the account's region
// (Settings → per-region defaults); both fall back to the legacy BCA / IDR 2,500
// policy. `prefs` is { preferredBank, bankFee, currency }. Returns the markup;
// wiring is done by wireBankNameField after the modal is in the DOM.
function bankNameField(current, prefs) {
  const p = prefs || {};
  const preferred = String(p.preferredBank || 'BCA').trim() || 'BCA';
  const fee = Number.isFinite(p.bankFee) ? p.bankFee : 2500;
  const currency = p.currency || regionCurrency();
  const cur = String(current || '').trim();
  const isPreferred = cur.toLowerCase() === preferred.toLowerCase();
  const isOther = !!cur && !isPreferred;
  const choice = isPreferred ? 'PREF' : (isOther ? 'Others' : 'PREF'); // default to preferred when unset
  const feeNote = fee > 0
    ? `<p class="fee-note" id="bankFeeNote" ${choice === 'PREF' ? 'hidden' : ''}>${esc(t('⚠ A fee of {fee} is charged for every payment to a non-preferred bank account.', { fee: money(fee, currency) }))}</p>`
    : '';
  return `
    <label>${esc(t('Bank name'))}
      <select name="bank_choice" id="bankChoice" data-preferred="${esc(preferred)}">
        <option value="PREF" ${choice === 'PREF' ? 'selected' : ''}>${esc(preferred)}</option>
        <option value="Others" ${choice === 'Others' ? 'selected' : ''}>${esc(t('Others'))}</option>
      </select></label>
    <label id="bankOtherWrap" ${choice === 'Others' ? '' : 'hidden'}>${esc(t('Bank name (please specify)'))}
      <input name="bank_name_custom" id="bankNameCustom" value="${isOther ? esc(cur) : ''}" placeholder="${esc(t('Enter your bank name'))}" /></label>
    ${feeNote}`;
}
// Toggle the custom field + fee note as the bank choice changes. Returns a
// getter for the effective bank name to use on submit (the region's preferred
// bank name when "PREF" is selected, else the typed custom name).
function wireBankNameField() {
  const choice = $('#bankChoice');
  if (!choice) return () => '';
  const preferred = choice.getAttribute('data-preferred') || '';
  const wrap = $('#bankOtherWrap'), custom = $('#bankNameCustom'), note = $('#bankFeeNote');
  const sync = () => {
    const other = choice.value === 'Others';
    wrap.hidden = !other;
    if (note) note.hidden = !other;
  };
  choice.addEventListener('change', () => { sync(); if (choice.value === 'Others' && custom) custom.focus(); });
  sync();
  return () => choice.value === 'Others' ? String((custom && custom.value) || '').trim() : preferred;
}

// Rough strength of a new password, 0–4: length plus character variety. A hint,
// not a rule — the server only enforces the 8-character minimum.
function passwordScore(pw) {
  const v = String(pw || '');
  if (v.length < 8) return v ? 1 : 0; // 1 = too short
  let sc = 2;                          // meets the minimum: at least "Fair"
  if (v.length >= 12) sc++;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) sc++;
  if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) sc++;
  else if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) sc += 0.5;
  return Math.min(4, Math.floor(sc));
}
const PW_LABEL = ['', 'Too short', 'Fair', 'Good', 'Strong'];
// Live meter under the new password, and a "match / don't match" line under
// the confirmation (shown once something is typed there).
function wirePasswordPair(pw, confirm, meter, match) {
  const sync = () => {
    const sc = pw.value ? Math.max(1, passwordScore(pw.value)) : 0;
    meter.dataset.score = String(sc);
    meter.querySelector('em').textContent = sc ? t(PW_LABEL[sc]) : '';
    if (!confirm.value) { match.hidden = true; return; }
    const ok = confirm.value === pw.value;
    match.hidden = false;
    match.classList.toggle('ok', ok);
    match.textContent = ok ? '✓ ' + t('Passwords match') : t('The two passwords do not match.');
  };
  pw.addEventListener('input', sync); confirm.addEventListener('input', sync);
  sync();
}

async function openProfileModal() {
  // Fetch the current values (login response omits bank details).
  let me = state.user || {};
  try { ({ user: me } = await api('/me')); } catch { /* fall back to state.user */ }
  const pwField = (name, label, extra = '') => `<label>${esc(label)}
          <div class="pw-wrap"><input name="${name}" type="password" required ${extra} />
            <button type="button" class="pw-toggle" aria-label="${esc(t('Show password'))}">👁</button></div></label>`;
  openModal(`
    ${formHeadHtml(t('My profile'))}
    <div class="modal-body">
      <div class="lf-form pf-body">
        <div class="meal-scroll">
          <section class="lf-sec pf-card">
            <div class="lf-sec-head"><h3>${esc(t('Appearance'))}</h3></div>
            <div class="look-pick" role="radiogroup" aria-label="${esc(t('Appearance'))}">
              ${[['classic', t('Classic')], ['ios', t('Modern')]].map(([v, l]) => `
              <button type="button" class="look-opt" role="radio" data-look="${v}" aria-checked="${Theme.getStyle() === v}">
                <span class="look-swatch ${v}" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="look-name">${esc(l)}</span>
              </button>`).join('')}
            </div>
          </section>
          <form id="profileForm" class="form lf-sec pf-card">
            <div class="lf-sec-head"><h3>${esc(t('Contact & bank details'))}</h3></div>
            <label>${esc(t('Email (used for password resets & notifications)'))}
              <input name="email" type="email" value="${esc(me.email || '')}" placeholder="${esc(t('you@company.com'))}" /></label>
            ${me.region ? `<p class="pf-region"><span class="pf-region-l">${esc(t('Region'))}</span> ${esc(regionLabel(me.region))} <span class="muted">— ${esc(t('set by your administrator'))}</span></p>` : ''}
            <div class="ue-sub">${esc(t('Bank / payout details'))}</div>
            ${bankNameField(me.bank_name, { preferredBank: me.preferredBank, bankFee: me.bankFee, currency: me.currency })}
            <label>${esc(t('Recipient bank account name'))}<input name="recipient_name" value="${esc(me.recipient_name || '')}" placeholder="${esc(t('Name on the account'))}" /></label>
            <label>${esc(t('Bank account number'))}<input name="bank_account_no" inputmode="numeric" value="${esc(me.bank_account_no || '')}" placeholder="${esc(t('Account number'))}" /></label>
            <p class="form-note caution">${esc(t('The company is not responsible if you submit the wrong bank details. Please triple check and make sure it is your bank details and it is the right one. Thank you.'))}</p>
            <p class="form-error" id="profileErr" hidden></p>
            <div class="pf-actions"><button type="submit" class="btn btn-primary">${esc(t('Save details'))}</button></div>
          </form>
          <form id="pwForm" class="form lf-sec pf-card">
            <div class="lf-sec-head"><h3>${esc(t('Change password'))}</h3></div>
            ${pwField('current_password', t('Current password'), 'autocomplete="current-password"')}
            ${pwField('new_password', t('New password (min 8 characters)'), 'minlength="8" autocomplete="new-password"')}
            <div class="pw-meter" id="pwMeter" data-score="0" aria-live="polite"><span></span><span></span><span></span><span></span><em id="pwMeterL"></em></div>
            ${pwField('confirm_password', t('Confirm new password'), 'minlength="8" autocomplete="new-password"')}
            <p class="pw-match" id="pwMatch" hidden></p>
            <p class="form-error" id="pwErr" hidden></p>
            <div class="pf-actions"><button type="submit" class="btn btn-primary">${esc(t('Update password'))}</button></div>
          </form>
        </div>
        <div class="modal-actions meal-foot pf-foot">
          <button type="button" class="btn btn-ghost" id="profileCancel">${esc(t('Close'))}</button>
        </div>
      </div>
    </div>`);
  $('#modal').classList.add('modal-flex', 'modal-profile');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#profileCancel').addEventListener('click', closeModal);
  const bankName = wireBankNameField();
  $$('#modal .look-opt').forEach(btn => btn.addEventListener('click', () => {
    const look = btn.dataset.look;
    if (look === Theme.getStyle()) return;
    $$('#modal .look-opt').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
    revealFrom(btn, () => Theme.setStyle(look));
  }));

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#profileErr'); err.hidden = true;
    const fd = new FormData(e.target);
    const effectiveBank = bankName();
    if ($('#bankChoice').value === 'Others' && !effectiveBank) {
      err.textContent = t('Please enter your bank name.'); err.hidden = false; return;
    }
    try {
      const { user } = await api('/me', { method: 'PUT', body: JSON.stringify({
        email: fd.get('email'),
        bank_name: effectiveBank, recipient_name: fd.get('recipient_name'),
        bank_account_no: fd.get('bank_account_no') }) });
      if (user) state.user = { ...state.user, ...user };
      toast(t('Profile saved'));
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  wirePasswordPair($('#pwForm [name="new_password"]'), $('#pwForm [name="confirm_password"]'), $('#pwMeter'), $('#pwMatch'));
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#pwErr'); err.hidden = true;
    const fd = new FormData(e.target);
    if (fd.get('new_password') !== fd.get('confirm_password')) { err.textContent = t('The two passwords do not match.'); err.hidden = false; return; }
    try {
      await api('/me/password', { method: 'POST', body: JSON.stringify({
        current_password: fd.get('current_password'), new_password: fd.get('new_password') }) });
      toast(t('Password updated')); e.target.reset(); $('#pwForm [name="new_password"]').dispatchEvent(new Event('input'));
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}
