'use strict';

// Thin wrapper around the Resend HTTP API (https://resend.com). We call the
// REST endpoint directly with the global fetch so no extra npm dependency is
// needed. Sending is always best-effort: a failure is logged and returned, but
// never thrown, so it can't break the request that triggered the email.
//
// Required environment variables:
//   RESEND_API_KEY   API key from the Resend dashboard.
//   EMAIL_FROM       Verified sender, e.g. "Reimbursement Portal <noreply@yourdomain.com>".
//   APP_URL          Public base URL of the portal, e.g. "https://reimbursement.example.com"
//                    (used to build links inside emails / the daily reminder).

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// Public base URL for links inside emails. Falls back to an empty string, in
// which case callers omit the link rather than emit a broken relative one.
function appUrl() {
  return String(process.env.APP_URL || '').replace(/\/+$/, '');
}

async function sendEmail({ to, subject, html, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: 'no-recipient' };
  if (!emailConfigured()) {
    console.warn('[email] RESEND_API_KEY / EMAIL_FROM not set — skipping email to', recipients.join(', '));
    return { skipped: 'not-configured' };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: recipients,
        subject,
        html,
        ...(text ? { text } : {})
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] Resend returned', res.status, body);
      return { error: `Resend ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('[email] send failed:', e && e.message ? e.message : e);
    return { error: String((e && e.message) || e) };
  }
}

// A simple, email-client-safe HTML wrapper with the portal's blue accent.
function layout(headline, innerHtml) {
  return `<!DOCTYPE html>
<html><body style="margin:0;background:#f4f6fb;padding:24px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2733">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e8f0">
      <tr><td style="background:#1d4ed8;padding:18px 24px;color:#ffffff;font-size:16px;font-weight:600">Reimbursement Portal</td></tr>
      <tr><td style="padding:24px">
        <h1 style="margin:0 0 12px;font-size:18px;color:#111827">${headline}</h1>
        ${innerHtml}
      </td></tr>
      <tr><td style="padding:16px 24px;background:#f9fafb;color:#6b7280;font-size:12px;border-top:1px solid #eef1f6">
        This is an automated message from the Reimbursement Portal. Please do not reply to this email.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function button(href, label) {
  if (!href) return '';
  return `<p style="margin:20px 0"><a href="${href}" style="background:#1d4ed8;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">${label}</a></p>`;
}

module.exports = { sendEmail, emailConfigured, appUrl, layout, button };
