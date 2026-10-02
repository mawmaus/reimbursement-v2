'use strict';

// Receipt verification: every referenced blob must be ours, of an allowed
// type and size.

const { statReceipt, RECEIPT_MAX_BYTES, BLOB_URL_RE } = require('./blob');

// File uploads held in memory, then pushed to Vercel Blob.
// Attachments are limited to PDFs and images so they can be embedded cleanly in
// the generated claim PDF. Receipts are uploaded straight from the browser to
// Blob storage (see /api/uploads/presign) — the serverless function caps request
// bodies at ~4.5 MB, so routing large files through it was the source of 413s.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'
]);
const MAX_FILES = 8;

// Validate the receipts a claim references. The browser uploads each file
// directly to Blob, then sends back only { url, original_name }. We never trust
// that metadata: every URL must belong to our store, and we HEAD each blob to
// read its authoritative size and content type before linking it to a claim.
// Returns { items } on success or { error } on the first problem.
async function verifyAttachments(list) {
  if (list == null) return { items: [] };
  if (!Array.isArray(list)) return { error: 'Invalid receipts' };
  if (list.length > MAX_FILES) return { error: `Maximum ${MAX_FILES} files` };
  for (const a of list) {
    if (!BLOB_URL_RE.test(String((a && a.url) || ''))) return { error: 'A receipt reference is invalid — please re-attach it' };
  }
  // HEAD every blob at once; the first problem (in list order) is reported.
  const checked = await Promise.all(list.map(async (a) => {
    const url = String(a.url);
    let info;
    try { info = await statReceipt(url); }
    catch { return { error: 'A receipt upload could not be verified — please re-attach it and retry' }; }
    if (info.size > RECEIPT_MAX_BYTES) return { error: 'A receipt exceeds the size limit' };
    const mime = String(info.contentType || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return { error: `File type not allowed: ${info.contentType || 'unknown'}` };
    return { item: {
      url,
      pathname: info.pathname,
      original_name: String(a.original_name || info.pathname.split('/').pop() || 'file').slice(0, 200),
      mime,
      size: info.size
    } };
  }));
  const bad = checked.find(c => c.error);
  return bad ? { error: bad.error } : { items: checked.map(c => c.item) };
}

module.exports = {
  verifyAttachments, MAX_FILES, ALLOWED_MIME
};
