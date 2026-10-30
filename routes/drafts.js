'use strict';

// Saved drafts of the New claim / meal / GPS meal / cash advance forms (the
// claim_drafts table): one per account and form type, kept on the server so a
// draft outlives the browser's own storage and opens on any device. The client
// still keeps a local copy for speed and offline use (public/js/claim-form.js).
//
// A draft's receipts are uploaded to the private Blob store like any receipt and
// referenced from `data.files` (per-row arrays). A receipt that leaves the draft
// (removed from the form, the draft discarded or replaced) is deleted from
// storage unless a submitted document links the same file.

const express = require('express');
const { q } = require('../db');
const blob = require('../lib/blob');
const { requireAuth } = require('../lib/auth');
const { ah } = require('../lib/util');
const { verifyAttachments, MAX_FILES } = require('../lib/uploads');

const router = express.Router();

const KINDS = new Set(['claim', 'meal', 'mealgps', 'advance']);
const MAX_ROWS = 100;          // form rows a draft may carry receipts for
const MAX_DRAFT_FILES = 100;   // receipts across the whole draft
const MAX_DATA_CHARS = 200000; // the typed fields — far above any real form

const missingTable = (e) => e && e.code === '42P01'; // before the migration ran

// Every receipt reference in a stored draft's data, flattened.
const draftFiles = (data) => (Array.isArray(data && data.files) ? data.files : [])
  .flatMap(row => (Array.isArray(row) ? row : [])).filter(f => f && typeof f.url === 'string');

async function loadDraft(userId, kind) {
  const rows = await q('SELECT data, saved_at FROM claim_drafts WHERE user_id = $1 AND kind = $2', [userId, kind]);
  return rows[0] || null;
}

// Blob URLs a submitted document (or helpdesk message) links. Those files are
// not the draft's to delete, and never the draft's to hand out either.
async function linkedUrls(urls) {
  if (!urls.length) return new Set();
  const rows = await q(
    `SELECT blob_url FROM attachments WHERE blob_url = ANY($1::text[])
     UNION SELECT blob_url FROM helpdesk_attachments WHERE blob_url = ANY($1::text[])`, [urls]);
  return new Set(rows.map(r => r.blob_url));
}
// Delete the given draft receipts from storage, sparing any a document links.
async function dropFiles(urls) {
  const uniq = [...new Set(urls)];
  if (!uniq.length) return;
  const keep = await linkedUrls(uniq);
  await Promise.all(uniq.filter(u => !keep.has(u)).map(u => blob.deleteReceipt(u)));
}

router.get('/api/drafts', requireAuth, ah(async (req, res) => {
  let rows;
  try {
    rows = await q('SELECT kind, data, saved_at FROM claim_drafts WHERE user_id = $1', [req.user.id]);
  } catch (e) {
    if (missingTable(e)) return res.json({ drafts: [], available: false });
    throw e;
  }
  res.json({
    available: true,
    drafts: rows.filter(r => KINDS.has(r.kind))
      .map(r => ({ kind: r.kind, data: r.data, saved_at: new Date(r.saved_at).getTime() }))
  });
}));

// Save (replace) one draft. `saved_at` is the client's save time in ms; a save
// older than the stored copy (a slow upload overtaken by a later save, or an
// older device) is refused so it can't roll the draft back.
router.put('/api/drafts/:kind', requireAuth, ah(async (req, res) => {
  const kind = req.params.kind;
  if (!KINDS.has(kind)) return res.status(404).json({ error: 'Unknown draft type' });
  const b = req.body || {};
  const data = b.data;
  const savedAt = Number(b.saved_at);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Invalid draft' });
  if (!Number.isFinite(savedAt) || savedAt <= 0) return res.status(400).json({ error: 'Invalid draft' });
  const files = data.files == null ? [] : data.files;
  if (!Array.isArray(files) || files.length > MAX_ROWS || files.some(r => !Array.isArray(r) || r.length > MAX_FILES)) {
    return res.status(400).json({ error: 'Invalid receipts' });
  }
  if (files.reduce((n, r) => n + r.length, 0) > MAX_DRAFT_FILES) {
    return res.status(400).json({ error: 'A draft can hold at most 100 receipts' });
  }
  const old = await loadDraft(req.user.id, kind);
  const known = new Map(draftFiles(old && old.data).map(f => [f.url, f]));
  // A receipt already in the stored draft keeps its checked size and type; a
  // new one is checked against storage, and must not be a submitted file.
  const fresh = files.flat().filter(f => !known.has(String((f && f.url) || '')));
  const linked = await linkedUrls(fresh.map(f => String((f && f.url) || '')));
  if (linked.size) return res.status(400).json({ error: 'A receipt reference is invalid — please re-attach it' });
  const clean = [];
  for (const row of files) {
    const out = [];
    const unknown = row.filter(f => !known.has(String((f && f.url) || '')));
    const v = await verifyAttachments(unknown);
    if (v.error) return res.status(400).json({ error: v.error });
    const checked = new Map(v.items.map(i => [i.url, i]));
    for (const f of row) {
      const url = String(f.url);
      const k = known.get(url);
      const c = checked.get(url);
      out.push({
        url,
        original_name: String(f.original_name || (k && k.original_name) || (c && c.original_name) || 'file').slice(0, 200),
        mime: k ? k.mime : c.mime,
        size: k ? k.size : c.size
      });
    }
    clean.push(out);
  }
  const stored = { ...data, files: clean };
  if (JSON.stringify(stored).length > MAX_DATA_CHARS) return res.status(413).json({ error: 'This draft is too large to save' });
  const saved = await q(
    `INSERT INTO claim_drafts (user_id, kind, data, saved_at) VALUES ($1, $2, $3::jsonb, to_timestamp($4 / 1000.0))
     ON CONFLICT (user_id, kind) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at
       WHERE claim_drafts.saved_at <= EXCLUDED.saved_at
     RETURNING saved_at`, [req.user.id, kind, JSON.stringify(stored), savedAt]);
  if (!saved.length) {
    // Overtaken: keep the stored copy, and drop the receipts uploaded only for this save.
    const now = await loadDraft(req.user.id, kind);
    const keep = new Set(draftFiles(now && now.data).map(f => f.url));
    await dropFiles(clean.flat().map(f => f.url).filter(u => !keep.has(u) && !known.has(u)));
    return res.status(409).json({ error: 'A newer copy of this draft is already saved' });
  }
  // Receipts the new copy no longer has are gone for good.
  const now = new Set(clean.flat().map(f => f.url));
  await dropFiles([...known.keys()].filter(u => !now.has(u)));
  res.json({ ok: true, saved_at: savedAt, files: clean });
}));

// Discard a draft (Cancel, Start fresh, Delete in My claims, or after submitting).
router.delete('/api/drafts/:kind', requireAuth, ah(async (req, res) => {
  const kind = req.params.kind;
  if (!KINDS.has(kind)) return res.status(404).json({ error: 'Unknown draft type' });
  let old;
  try { old = await loadDraft(req.user.id, kind); } catch (e) {
    if (missingTable(e)) return res.json({ ok: true });
    throw e;
  }
  if (!old) return res.json({ ok: true });
  await q('DELETE FROM claim_drafts WHERE user_id = $1 AND kind = $2', [req.user.id, kind]);
  await dropFiles(draftFiles(old.data).map(f => f.url));
  res.json({ ok: true });
}));

// One receipt of the caller's own draft, by its row and position, so a draft
// reopened on another device (or after the browser cleared it) gets its files back.
router.get('/api/drafts/:kind/files/:row/:idx', requireAuth, ah(async (req, res) => {
  const kind = req.params.kind;
  if (!KINDS.has(kind)) return res.status(404).json({ error: 'Unknown draft type' });
  const d = await loadDraft(req.user.id, kind);
  const row = d && Array.isArray(d.data.files) ? d.data.files[Number(req.params.row)] : null;
  const f = Array.isArray(row) ? row[Number(req.params.idx)] : null;
  if (!f || typeof f.url !== 'string') return res.status(404).json({ error: 'File not found' });
  await blob.sendReceipt(res, { blob_url: f.url, mime_type: f.mime, original_name: f.original_name });
}));

module.exports = router;
