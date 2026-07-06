'use strict';
const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('token') || '';

// Show/hide password toggles.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle');
  if (!btn) return;
  const input = btn.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
});

const err = $('#resetError');
if (!token) {
  err.textContent = 'This reset link is missing its token. Please request a new one.';
  err.hidden = false;
  $('#resetForm').hidden = true;
}

$('#resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const fd = new FormData(e.target);
  const pw = fd.get('new_password'), confirm = fd.get('confirm_password');
  if (pw !== confirm) { err.textContent = 'The two passwords do not match.'; err.hidden = false; return; }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, new_password: pw })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Could not reset your password.');
    $('#resetForm').hidden = true;
    $('#resetDone').hidden = false;
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
});
