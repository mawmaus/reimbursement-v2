'use strict';

// Workflow email notifications. Every function is self-contained and never
// throws: recipients are looked up here, and any failure is swallowed so a
// notification problem can't break the claim action that triggered it.

const { q } = require('../db');
const { sendEmail, appUrl, layout, button } = require('./email');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// "IDR 1,200,000" — a readable amount for the email body.
function money(amount, currency) {
  const n = Number(amount);
  const s = Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(amount);
  return `${currency || 'IDR'} ${s}`;
}

async function userById(id) {
  if (!id) return null;
  const rows = await q('SELECT id, full_name, email, active FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

const portalLink = () => { const b = appUrl(); return b ? `${b}/` : ''; };

// A claim is waiting for `approverId` to review it (fresh submission, a
// resubmission, or an advance to their step in the chain).
async function notifyPendingApprover(approverId, claim) {
  try {
    const u = await userById(approverId);
    if (!u || !u.active || !u.email) return;
    const inner = `
      <p style="margin:0 0 8px">Hi ${esc(u.full_name)},</p>
      <p style="margin:0 0 8px">A ${esc(claim.typeLabel)} is awaiting your review.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;margin:12px 0">
        <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Claim</td><td><strong>${esc(claim.claimNo)}</strong></td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Claimant</td><td>${esc(claim.claimantName)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Amount</td><td>${esc(money(claim.amount, claim.currency))}</td></tr>
      </table>
      <p style="margin:0;color:#374151">Please sign in to approve or return it.</p>
      ${button(portalLink(), 'Open the portal')}`;
    await sendEmail({
      to: u.email,
      subject: `Action needed: ${claim.claimNo} awaits your approval`,
      html: layout('A claim needs your review', inner),
      text: `Hi ${u.full_name}, ${claim.typeLabel} ${claim.claimNo} from ${claim.claimantName} `
        + `(${money(claim.amount, claim.currency)}) is awaiting your approval. `
        + `Sign in to review it${portalLink() ? `: ${portalLink()}` : '.'}`
    });
  } catch (e) { console.error('[notify] pending-approver failed:', e && e.message); }
}

// A claim was rejected / returned to the claimant.
async function notifyClaimantRejected(employeeId, claim) {
  try {
    const u = await userById(employeeId);
    if (!u || !u.email) return;
    const reason = claim.reason
      ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#991b1b;margin:12px 0">${esc(claim.reason)}</div>`
      : '';
    const inner = `
      <p style="margin:0 0 8px">Hi ${esc(u.full_name)},</p>
      <p style="margin:0 0 8px">Your ${esc(claim.typeLabel)} <strong>${esc(claim.claimNo)}</strong> was returned and needs changes.</p>
      <p style="margin:0 0 4px;color:#6b7280;font-size:13px">Reason from the approver:</p>
      ${reason}
      <p style="margin:0;color:#374151">Sign in to edit and resubmit it.</p>
      ${button(portalLink(), 'Open the portal')}`;
    await sendEmail({
      to: u.email,
      subject: `Returned: ${claim.claimNo} needs changes`,
      html: layout('Your claim was returned', inner),
      text: `Hi ${u.full_name}, your ${claim.typeLabel} ${claim.claimNo} was returned.`
        + (claim.reason ? ` Reason: ${claim.reason}.` : '')
        + ` Sign in to edit and resubmit${portalLink() ? `: ${portalLink()}` : '.'}`
    });
  } catch (e) { console.error('[notify] claimant-rejected failed:', e && e.message); }
}

// Daily digest: email each approver a summary of items still awaiting them.
// `items` is [{ approverId, claims: [{ claimNo, claimantName, amount, currency, typeLabel }] }].
async function sendReminderDigest(approverId, claims) {
  try {
    const u = await userById(approverId);
    if (!u || !u.active || !u.email || !claims.length) return { skipped: true };
    const rows = claims.map(c => `
      <tr>
        <td style="padding:6px 12px 6px 0;border-bottom:1px solid #eef1f6"><strong>${esc(c.claimNo)}</strong></td>
        <td style="padding:6px 12px 6px 0;border-bottom:1px solid #eef1f6">${esc(c.claimantName)}</td>
        <td style="padding:6px 0;border-bottom:1px solid #eef1f6">${esc(money(c.amount, c.currency))}</td>
      </tr>`).join('');
    const inner = `
      <p style="margin:0 0 8px">Hi ${esc(u.full_name)},</p>
      <p style="margin:0 0 12px">You have <strong>${claims.length}</strong> claim${claims.length === 1 ? '' : 's'} awaiting your review.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;width:100%">
        <tr><td style="padding:0 12px 6px 0;color:#6b7280;font-size:12px">Claim</td><td style="padding:0 12px 6px 0;color:#6b7280;font-size:12px">Claimant</td><td style="padding:0 0 6px;color:#6b7280;font-size:12px">Amount</td></tr>
        ${rows}
      </table>
      ${button(portalLink(), 'Review pending claims')}`;
    await sendEmail({
      to: u.email,
      subject: `${claims.length} claim${claims.length === 1 ? '' : 's'} awaiting your approval`,
      html: layout('Pending approvals reminder', inner),
      text: `Hi ${u.full_name}, you have ${claims.length} claim(s) awaiting your review`
        + `${portalLink() ? `: ${portalLink()}` : '.'}`
    });
    return { ok: true };
  } catch (e) { console.error('[notify] reminder-digest failed:', e && e.message); return { error: true }; }
}

module.exports = { notifyPendingApprover, notifyClaimantRejected, sendReminderDigest, money };
