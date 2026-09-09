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

// A claim reached a positive milestone for the claimant: fully approved, or
// paid. `decision` is 'approved' | 'paid'.
const DECISION_COPY = {
  approved: {
    subjectVerb: 'approved',
    headline: 'Your claim was approved',
    lead: 'has been fully approved',
    tail: 'It’s now awaiting payment.'
  },
  paid: {
    subjectVerb: 'paid',
    headline: 'Your claim was paid',
    lead: 'has been marked as paid',
    tail: 'The payout has been processed.'
  }
};
async function notifyClaimantDecision(employeeId, claim, decision) {
  try {
    const copy = DECISION_COPY[decision];
    if (!copy) return;
    const u = await userById(employeeId);
    if (!u || !u.email) return;
    const inner = `
      <p style="margin:0 0 8px">Hi ${esc(u.full_name)},</p>
      <p style="margin:0 0 8px">Your ${esc(claim.typeLabel)} <strong>${esc(claim.claimNo)}</strong> (${esc(money(claim.amount, claim.currency))}) ${copy.lead}.</p>
      <p style="margin:0 0 8px;color:#374151">${copy.tail}</p>
      ${button(portalLink(), 'Open the portal')}`;
    await sendEmail({
      to: u.email,
      subject: `${copy.subjectVerb === 'paid' ? 'Paid' : 'Approved'}: ${claim.claimNo}`,
      html: layout(copy.headline, inner),
      text: `Hi ${u.full_name}, your ${claim.typeLabel} ${claim.claimNo} (${money(claim.amount, claim.currency)}) ${copy.lead}. ${copy.tail}`
        + `${portalLink() ? ` ${portalLink()}` : ''}`
    });
  } catch (e) { console.error('[notify] claimant-decision failed:', e && e.message); }
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

// A claimant is about to resubmit a returned claim but needs to change a line
// date, which the claim window otherwise forbids. Goes to everyone who can
// grant it in that region — the same people who own the claim window itself.
async function notifyDateChangeRequested(grantors, req) {
  for (const u of grantors || []) {
    try {
      if (!u || !u.email) continue;
      const inner = `
        <p style="margin:0 0 8px">Hi ${esc(u.full_name)},</p>
        <p style="margin:0 0 8px"><strong>${esc(req.claimantName)}</strong> needs to change the dates on a returned ${esc(req.typeLabel)} before resubmitting it.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;margin:12px 0">
          <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Claim</td><td><strong>${esc(req.claimNo)}</strong></td></tr>
          <tr><td style="padding:2px 12px 2px 0;color:#6b7280">Claimant</td><td>${esc(req.claimantName)}</td></tr>
        </table>
        <p style="margin:0 0 4px;color:#6b7280;font-size:13px">Their reason:</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;color:#374151;margin:0 0 12px">${esc(req.reason)}</div>
        <p style="margin:0;color:#374151">Grant it in Settings → Date changes and the claim's dates unlock for one resubmit.</p>
        ${button(portalLink(), 'Open the portal')}`;
      await sendEmail({
        to: u.email,
        subject: `Date change requested: ${req.claimNo}`,
        html: layout('A claimant needs to change dates', inner),
        text: `Hi ${u.full_name}, ${req.claimantName} asked to change the dates on ${req.typeLabel} ${req.claimNo}. `
          + `Reason: ${req.reason}. Grant or decline it in Settings > Date changes${portalLink() ? `: ${portalLink()}` : '.'}`
      });
    } catch (e) { console.error('[notify] date-change-requested failed:', e && e.message); }
  }
}

// The request was granted or declined — tell the claimant either way.
async function notifyDateChangeDecided(employeeId, d) {
  try {
    const u = await userById(employeeId);
    if (!u || !u.email) return;
    const note = d.note
      ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;color:#374151;margin:12px 0">${esc(d.note)}</div>`
      : '';
    const headline = d.granted
      ? `The dates on your ${esc(d.typeLabel)} <strong>${esc(d.claimNo)}</strong> are unlocked. Edit them and resubmit — the unlock covers this one resubmit.`
      : `Your request to change the dates on ${esc(d.typeLabel)} <strong>${esc(d.claimNo)}</strong> was declined, so its original dates still stand.`;
    const inner = `
      <p style="margin:0 0 8px">Hi ${esc(u.full_name)},</p>
      <p style="margin:0 0 8px">${headline}</p>
      <p style="margin:0 0 4px;color:#6b7280;font-size:13px">Decided by ${esc(d.deciderName)}${d.note ? ':' : '.'}</p>
      ${note}
      ${button(portalLink(), 'Open the portal')}`;
    await sendEmail({
      to: u.email,
      subject: d.granted ? `Dates unlocked: ${d.claimNo}` : `Date change declined: ${d.claimNo}`,
      html: layout(d.granted ? 'Your dates are unlocked' : 'Date change declined', inner),
      text: `Hi ${u.full_name}, your date-change request on ${d.typeLabel} ${d.claimNo} was `
        + `${d.granted ? 'granted — edit the dates and resubmit' : 'declined'} by ${d.deciderName}.`
        + (d.note ? ` Note: ${d.note}.` : '')
        + `${portalLink() ? ` ${portalLink()}` : ''}`
    });
  } catch (e) { console.error('[notify] date-change-decided failed:', e && e.message); }
}

module.exports = { notifyPendingApprover, notifyClaimantRejected, notifyClaimantDecision, sendReminderDigest, notifyDateChangeRequested, notifyDateChangeDecided, money };
