'use strict';
// The page a password-reset email links to (/reset.html?token=…). It speaks the
// language last used on this device (i18n.js reads the cached choice), and
// mirrors the profile form's helpers: strength meter, match check, Caps Lock
// hint and the show/hide toggle. It can't load app.js, so they live here too.
const $ = (s) => document.querySelector(s);
const tt = (s, p) => (window.I18N ? I18N.t(s, p) : s);
const token = new URLSearchParams(location.search).get('token') || '';

// Translate the static text now, and again if the language table lands later.
function translate() {
  if (!window.I18N) return;
  I18N.applyStatic();
  document.documentElement.lang = I18N.getLang();
  document.title = `${tt('Reset password')} · ${tt('Reimbursement Portal')}`;
  sync();
}
window.addEventListener('i18n:changed', translate);

// Show/hide password toggles.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle');
  if (!btn) return;
  const input = btn.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-label', show ? tt('Hide password') : tt('Show password'));
});

// Caps Lock hint under the focused password field.
function capsHint(e) {
  const input = e.target;
  if (!input || input.tagName !== 'INPUT' || !e.getModifierState) return;
  const wrap = input.closest('.pw-wrap'); if (!wrap) return;
  let hint = wrap.nextElementSibling;
  if (!hint || !hint.classList.contains('caps-hint')) {
    hint = document.createElement('span');
    hint.className = 'caps-hint'; hint.hidden = true; hint.setAttribute('role', 'status');
    wrap.insertAdjacentElement('afterend', hint);
  }
  hint.textContent = '⇪ ' + tt('Caps Lock is on');
  hint.hidden = e.type === 'blur' || !e.getModifierState('CapsLock');
}
['keydown', 'keyup'].forEach(type => document.addEventListener(type, capsHint, true));
document.addEventListener('blur', (e) => { if (e.target && e.target.closest && e.target.closest('.pw-wrap')) capsHint(e); }, true);

// Strength meter + match line (same scale as the profile form in app.js).
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
const pw = $('[name="new_password"]'), confirm = $('[name="confirm_password"]');
function sync() {
  const meter = $('#pwMeter'), match = $('#pwMatch');
  const sc = pw.value ? Math.max(1, passwordScore(pw.value)) : 0;
  meter.dataset.score = String(sc);
  meter.querySelector('em').textContent = sc ? tt(PW_LABEL[sc]) : '';
  if (!confirm.value) { match.hidden = true; return; }
  const ok = confirm.value === pw.value;
  match.hidden = false;
  match.classList.toggle('ok', ok);
  match.textContent = ok ? '✓ ' + tt('Passwords match') : tt('The two passwords do not match.');
}
pw.addEventListener('input', sync);
confirm.addEventListener('input', sync);

const err = $('#resetError');
if (!token) {
  err.textContent = tt('This reset link is missing its token. Please request a new one.');
  err.dataset.key = 'This reset link is missing its token. Please request a new one.';
  err.hidden = false;
  $('#resetForm').hidden = true;
  $('#pwMeter').hidden = true;
}

$('#resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const fd = new FormData(e.target);
  const newPw = fd.get('new_password'), again = fd.get('confirm_password');
  if (newPw !== again) { err.textContent = tt('The two passwords do not match.'); err.hidden = false; return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true; btn.classList.add('is-busy');
  try {
    const res = await fetch('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, new_password: newPw })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || tt('Could not reset your password.'));
    $('#resetForm').hidden = true;
    $('#resetIntro').hidden = true;
    $('#resetBack').hidden = true;
    $('#resetDone').hidden = false;
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.classList.remove('is-busy'); }
});

translate();
