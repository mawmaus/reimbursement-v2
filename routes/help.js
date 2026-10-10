'use strict';

// Helpdesk tickets and feedback (kritik & saran) — see lib/help.js. An account
// sees only its own tickets and named feedback; the Super Admins see and answer
// everyone's.

const express = require('express');
const { q, qq, transaction } = require('../db');
const { requireAuth } = require('../lib/auth');
const { ah } = require('../lib/util');
const {
  TICKET_CATEGORIES, TICKET_STATUSES, FEEDBACK_KINDS, FEEDBACK_TOPICS, SUBJECT_MAX, BODY_MAX,
  isHelpStaff, text, helpSummary, verifyScreenshots
} = require('../lib/help');
const { deleteReceipt, sendReceipt } = require('../lib/blob');
const { notifyHelpdeskStaff, notifyHelpdeskAnswered, notifyFeedbackAnswered } = require('../lib/notify');

const router = express.Router();

// The email text for a message that carries screenshots (they stay in the
// portal; the email just says they're there).
const withShots = (body, n) => [body, n ? `[${n} screenshot${n === 1 ? '' : 's'} attached — open the ticket to see ${n === 1 ? 'it' : 'them'}]` : '']
  .filter(Boolean).join('\n\n');

const requireHelpStaff = (req, res, next) => (isHelpStaff(req.user) ? next()
  : res.status(403).json({ error: 'You do not have permission for this action' }));
const idParam = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// Link verified screenshots to a message. If that fails the blobs would be
// orphaned, so they're deleted before the error goes on.
async function saveScreenshots(ticketId, messageId, items) {
  if (!items.length) return;
  const params = [ticketId, messageId];
  const rows = items.map(a => {
    params.push(a.url, a.original_name, a.mime, a.size);
    const n = params.length;
    return `($1, $2, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  try {
    await q(`INSERT INTO helpdesk_attachments (ticket_id, message_id, blob_url, original_name, mime_type, size_bytes)
             VALUES ${rows.join(', ')}`, params);
  } catch (e) {
    await Promise.all(items.map(a => deleteReceipt(a.url)));
    throw e;
  }
}

router.get('/api/help/summary', requireAuth, ah(async (req, res) => {
  res.json(await helpSummary(req.user));
}));

// --- Helpdesk ---------------------------------------------------------------

// Newest activity first, with the requester and the latest message. The
// helpdesk can narrow by status and region; an account always gets its own.
router.get('/api/help/tickets', requireAuth, ah(async (req, res) => {
  const staff = isHelpStaff(req.user);
  const where = [];
  const params = [];
  if (!staff) { params.push(req.user.id); where.push(`t.user_id = $${params.length}`); }
  const status = String(req.query.status || '');
  if (TICKET_STATUSES.includes(status)) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (staff && req.query.region) { params.push(String(req.query.region)); where.push(`t.region = $${params.length}`); }
  const rows = await q(
    `SELECT t.id, t.user_id, t.region, t.department, t.category, t.subject, t.status, t.user_unread,
            t.created_at, t.updated_at, u.full_name AS requester_name,
            (SELECT COUNT(*)::int FROM helpdesk_messages m WHERE m.ticket_id = t.id) AS message_count,
            (SELECT COUNT(*)::int FROM helpdesk_attachments a WHERE a.ticket_id = t.id) AS attachment_count,
            LEFT(lm.body, 180) AS last_body, lm.from_staff AS last_from_staff
       FROM helpdesk_tickets t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN LATERAL (SELECT body, from_staff FROM helpdesk_messages m
                           WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) lm ON TRUE
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.updated_at DESC LIMIT 300`, params);
  res.json({ staff, tickets: rows });
}));

router.post('/api/help/tickets', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const category = TICKET_CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) return res.status(400).json({ error: 'Choose what the question is about' });
  const subject = text(b.subject, SUBJECT_MAX, 'Give the ticket a short subject');
  if (subject.error) return res.status(400).json({ error: subject.error });
  const message = text(b.message, BODY_MAX, 'Describe the question or problem');
  if (message.error) return res.status(400).json({ error: message.error });
  const shots = await verifyScreenshots(b.attachments);
  if (shots.error) return res.status(400).json({ error: shots.error });
  const rows = await q(
    `WITH t AS (
       INSERT INTO helpdesk_tickets (user_id, region, department, category, subject)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, subject
     ), m AS (
       INSERT INTO helpdesk_messages (ticket_id, author_id, from_staff, body)
       SELECT id, $1, FALSE, $6 FROM t RETURNING id, ticket_id
     )
     SELECT t.id, t.subject, m.id AS message_id FROM t, m`,
    [req.user.id, String(req.user.region || ''), String(req.user.department || ''), category, subject.value, message.value]);
  const ticket = rows[0];
  if (ticket) await saveScreenshots(ticket.id, ticket.message_id, shots.items);
  if (ticket) await notifyHelpdeskStaff(ticket, withShots(message.value, shots.items.length), req.user.full_name, true);
  res.json({ ok: true, id: ticket ? ticket.id : null });
}));

// The ticket, or null once the 404 has been sent. Another account's ticket is
// reported as not found rather than forbidden, so ids don't leak.
async function loadTicket(req, res) {
  const id = idParam(req.params.id);
  const rows = id ? await q('SELECT * FROM helpdesk_tickets WHERE id = $1', [id]) : [];
  const ticket = rows[0];
  if (!ticket || (!isHelpStaff(req.user) && Number(ticket.user_id) !== req.user.id)) {
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  return ticket;
}

router.get('/api/help/tickets/:id', requireAuth, ah(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const [messages, owner, shots] = await Promise.all([
    q(`SELECT m.id, m.author_id, m.from_staff, m.body, m.created_at, u.full_name AS author_name
         FROM helpdesk_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.ticket_id = $1 ORDER BY m.id`, [ticket.id]),
    q('SELECT full_name FROM users WHERE id = $1', [ticket.user_id]),
    q(`SELECT id, message_id, original_name, mime_type, size_bytes FROM helpdesk_attachments
        WHERE ticket_id = $1 ORDER BY id`, [ticket.id])
  ]);
  for (const m of messages) m.attachments = shots.filter(a => a.message_id === m.id);
  const mine = Number(ticket.user_id) === req.user.id;
  if (mine && ticket.user_unread) {
    await q('UPDATE helpdesk_tickets SET user_unread = FALSE WHERE id = $1', [ticket.id]);
    ticket.user_unread = false;
  }
  res.json({
    staff: isHelpStaff(req.user), mine,
    ticket: { ...ticket, requester_name: owner[0] ? owner[0].full_name : '' },
    messages
  });
}));

// A reply. From the helpdesk it marks the ticket answered and lights the
// owner's badge; from the owner it puts the ticket back in the queue (also
// reopening a closed one).
router.post('/api/help/tickets/:id/messages', requireAuth, ah(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const b = req.body || {};
  const shots = await verifyScreenshots(b.attachments);
  if (shots.error) return res.status(400).json({ error: shots.error });
  // A message may be just screenshots.
  const message = shots.items.length && !String(b.message || '').trim()
    ? { value: '' } : text(b.message, BODY_MAX, 'Write a message first');
  if (message.error) return res.status(400).json({ error: message.error });
  const mine = Number(ticket.user_id) === req.user.id;
  const fromStaff = !mine && isHelpStaff(req.user);
  const [inserted] = await transaction([
    qq('INSERT INTO helpdesk_messages (ticket_id, author_id, from_staff, body) VALUES ($1, $2, $3, $4) RETURNING id',
      [ticket.id, req.user.id, fromStaff, message.value]),
    qq(`UPDATE helpdesk_tickets SET status = $2, user_unread = $3, updated_at = now() WHERE id = $1`,
      [ticket.id, fromStaff ? 'answered' : 'open', fromStaff])
  ]);
  const messageId = inserted && inserted[0] && inserted[0].id;
  if (messageId) await saveScreenshots(ticket.id, messageId, shots.items);
  const mailText = withShots(message.value, shots.items.length);
  if (fromStaff) await notifyHelpdeskAnswered(Number(ticket.user_id), ticket, mailText, req.user.full_name);
  else await notifyHelpdeskStaff(ticket, mailText, req.user.full_name, false);
  res.json({ ok: true });
}));

// One screenshot, to the ticket's owner and the helpdesk only. The image never
// changes once uploaded, so the browser may keep it for a while.
router.get('/api/help/attachments/:id', requireAuth, ah(async (req, res) => {
  const id = idParam(req.params.id);
  const rows = id ? await q(`SELECT a.blob_url, a.original_name, a.mime_type, t.user_id
                               FROM helpdesk_attachments a JOIN helpdesk_tickets t ON t.id = a.ticket_id
                              WHERE a.id = $1`, [id]) : [];
  const att = rows[0];
  if (!att || (!isHelpStaff(req.user) && Number(att.user_id) !== req.user.id)) {
    return res.status(404).json({ error: 'Screenshot not found' });
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  await sendReceipt(res, att);
}));

// Close a ticket, or reopen a closed one. Its owner and the helpdesk may both.
router.post('/api/help/tickets/:id/status', requireAuth, ah(async (req, res) => {
  const ticket = await loadTicket(req, res);
  if (!ticket) return;
  const status = String((req.body || {}).status || '');
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (status === 'open' && ticket.status !== 'closed') return res.status(409).json({ error: 'This ticket is already open' });
  if (status === 'closed' && ticket.status === 'closed') return res.status(409).json({ error: 'This ticket is already closed' });
  await q('UPDATE helpdesk_tickets SET status = $2, user_unread = FALSE, updated_at = now() WHERE id = $1', [ticket.id, status]);
  res.json({ ok: true });
}));

// --- Feedback (kritik & saran) ---------------------------------------------

router.post('/api/help/feedback', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const kind = FEEDBACK_KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'Choose criticism or suggestion' });
  const topic = FEEDBACK_TOPICS.includes(b.topic) ? b.topic : 'other';
  const body = text(b.body, BODY_MAX, 'Write your feedback first');
  if (body.error) return res.status(400).json({ error: body.error });
  const anonymous = b.anonymous === true;
  await q(
    `INSERT INTO feedback (user_id, anonymous, region, department, kind, topic, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [anonymous ? null : req.user.id, anonymous, String(req.user.region || ''),
      anonymous ? '' : String(req.user.department || ''), kind, topic, body.value]);
  res.json({ ok: true });
}));

// The helpdesk gets everything (filterable by status, kind and region), with
// the sender's name unless it was sent anonymously; an account gets the named
// feedback it sent.
router.get('/api/help/feedback', requireAuth, ah(async (req, res) => {
  const staff = isHelpStaff(req.user);
  const where = [];
  const params = [];
  if (!staff) { params.push(req.user.id); where.push(`f.user_id = $${params.length}`); }
  if (staff && ['new', 'read'].includes(req.query.status)) { params.push(req.query.status); where.push(`f.status = $${params.length}`); }
  if (FEEDBACK_KINDS.includes(req.query.kind)) { params.push(req.query.kind); where.push(`f.kind = $${params.length}`); }
  if (staff && req.query.region) { params.push(String(req.query.region)); where.push(`f.region = $${params.length}`); }
  const rows = await q(
    `SELECT f.id, f.anonymous, f.region, f.department, f.kind, f.topic, f.body, f.status, f.response,
            f.responded_at, f.created_at, u.full_name AS sender_name, r.full_name AS responder_name
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN users r ON r.id = f.responded_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY f.created_at DESC LIMIT 300`, params);
  res.json({ staff, feedback: rows.map(r => (r.anonymous ? { ...r, sender_name: '' } : r)) });
}));

// The helpdesk marks feedback read, optionally answering it (the sender sees
// the answer and is emailed; anonymous feedback has nobody to tell).
router.post('/api/help/feedback/:id/review', requireAuth, requireHelpStaff, ah(async (req, res) => {
  const id = idParam(req.params.id);
  const rows = id ? await q('SELECT * FROM feedback WHERE id = $1', [id]) : [];
  const fb = rows[0];
  if (!fb) return res.status(404).json({ error: 'Feedback not found' });
  const raw = String((req.body || {}).response || '').trim();
  if (raw.length > BODY_MAX) return res.status(400).json({ error: `Keep it under ${BODY_MAX} characters` });
  if (raw) {
    await q(`UPDATE feedback SET status = 'read', response = $2, responded_by = $3, responded_at = now() WHERE id = $1`,
      [fb.id, raw, req.user.id]);
    if (fb.user_id) await notifyFeedbackAnswered(Number(fb.user_id), raw, req.user.full_name);
  } else {
    await q(`UPDATE feedback SET status = 'read' WHERE id = $1`, [fb.id]);
  }
  res.json({ ok: true });
}));

module.exports = router;
