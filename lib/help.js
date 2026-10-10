'use strict';

// Helpdesk and feedback (kritik & saran). Any signed-in account opens helpdesk
// tickets and sends feedback; the Super Admins are the helpdesk: they answer
// tickets and read (and may answer) feedback.

const { q } = require('../db');
const { verifyAttachments } = require('./uploads');

const TICKET_CATEGORIES = ['claim', 'meal', 'advance', 'account', 'bug', 'other'];
const TICKET_STATUSES = ['open', 'answered', 'closed'];
const FEEDBACK_KINDS = ['criticism', 'suggestion'];
const FEEDBACK_TOPICS = ['portal', 'process', 'other'];
const SUBJECT_MAX = 120;
const BODY_MAX = 4000;

// Screenshots on a message: uploaded by the browser through the receipt upload
// path (/api/uploads/direct), then referenced here by their Blob URL.
const SCREENSHOT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_SCREENSHOTS = 4;

const isHelpStaff = (user) => !!user && user.role === 'superadmin';

// Check the screenshots a message references: each must be one of our blobs
// and an image (read from storage, never from what the browser says). Returns
// { items } or { error }.
async function verifyScreenshots(list) {
  if (list == null || (Array.isArray(list) && !list.length)) return { items: [] };
  if (!Array.isArray(list)) return { error: 'Invalid screenshots' };
  if (list.length > MAX_SCREENSHOTS) return { error: `Attach up to ${MAX_SCREENSHOTS} screenshots` };
  const r = await verifyAttachments(list);
  if (r.error) return r;
  if (r.items.some(a => !SCREENSHOT_MIME.has(a.mime))) return { error: 'Screenshots must be images (JPG, PNG, WebP or GIF)' };
  return r;
}

// Trimmed text, or an error message for the caller to answer with.
function text(v, max, emptyMsg) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { error: emptyMsg };
  if (s.length > max) return { error: `Keep it under ${max} characters` };
  return { value: s };
}

// The badge counts on the home tiles. For an account: tickets with a reply it
// hasn't opened. For the helpdesk: tickets waiting for an answer and unread
// feedback. Runs on every home load, so a database without the tables yet
// (schema not migrated) just means zero rather than a failed menu.
async function helpSummary(user) {
  try {
    if (isHelpStaff(user)) {
      const [t, f] = await Promise.all([
        q(`SELECT COUNT(*)::int AS n FROM helpdesk_tickets WHERE status = 'open'`),
        q(`SELECT COUNT(*)::int AS n FROM feedback WHERE status = 'new'`)
      ]);
      return { staff: true, tickets: t[0] ? t[0].n : 0, feedback: f[0] ? f[0].n : 0 };
    }
    const t = await q(`SELECT COUNT(*)::int AS n FROM helpdesk_tickets WHERE user_id = $1 AND user_unread`, [user.id]);
    return { staff: false, tickets: t[0] ? t[0].n : 0, feedback: 0 };
  } catch (e) {
    if (e && e.code === '42P01') return { staff: isHelpStaff(user), tickets: 0, feedback: 0 }; // undefined_table
    throw e;
  }
}

module.exports = {
  TICKET_CATEGORIES, TICKET_STATUSES, FEEDBACK_KINDS, FEEDBACK_TOPICS, SUBJECT_MAX, BODY_MAX,
  SCREENSHOT_MIME, MAX_SCREENSHOTS, isHelpStaff, text, helpSummary, verifyScreenshots
};
