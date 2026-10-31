'use strict';

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { put, del, head, get, issueSignedToken, presignUrl } = require('@vercel/blob');

// Receipts live in a PRIVATE Blob store: a stored URL opens nothing on its own,
// every read needs the store's credentials, so the only way to see a receipt is
// through the app's signed-in attachment routes (sendReceipt below).
//
// The private store is reached with PRIVATE_READ_WRITE_TOKEN where it is set,
// else with PRIVATE_STORE_ID plus the deployment's Vercel OIDC token (the SDK
// reads VERCEL_OIDC_TOKEN itself) — the store is connected to the project with
// the PRIVATE prefix. (Until 2026-10-23 receipts were in a public store; it was
// migrated by scripts/migrate-receipts-private.js and deleted.)
function privateAuth() {
  const token = process.env.PRIVATE_READ_WRITE_TOKEN;
  if (token) return { token };
  const storeId = process.env.PRIVATE_STORE_ID;
  if (storeId) return { storeId };
  throw new Error('Private receipt storage is not configured (PRIVATE_READ_WRITE_TOKEN / PRIVATE_STORE_ID is missing)');
}

// Server ceiling for a single receipt. The browser compresses images to 10 MB
// before uploading; this leaves headroom for PDFs and encoding overhead. Kept
// well under Blob's own 5 TB cap but generous vs. the old 4 MB function limit.
const RECEIPT_MAX_BYTES = 15 * 1024 * 1024;

// A blob URL in a private Vercel Blob store — the only kind a receipt reference
// may be. Which store is settled by head() with our own credentials.
const BLOB_URL_RE = /^https:\/\/[a-z0-9]+\.private\.blob\.vercel-storage\.com\//i;

const safeName = (name) => String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-60);

// Uploads a file buffer to the private store and returns { url, pathname }.
async function uploadReceipt(buffer, originalName, mimeType) {
  const blob = await put(`receipts/${safeName(originalName)}`, buffer, {
    access: 'private',
    addRandomSuffix: true,
    contentType: mimeType || 'application/octet-stream',
    ...privateAuth()
  });
  return { url: blob.url, pathname: blob.pathname };
}

// Issues a short-lived presigned PUT URL so the browser can upload a receipt
// straight to Blob storage — bypassing the serverless function's ~4.5 MB
// request-body limit entirely. The token is scoped to one pathname, the given
// content types and a size ceiling, and expires in 10 minutes.
async function presignReceiptUpload(originalName, contentType, allowedContentTypes) {
  const pathname = `receipts/${safeName(originalName)}`;
  const constraints = {
    pathname,
    operations: ['put'],
    allowedContentTypes,
    maximumSizeInBytes: RECEIPT_MAX_BYTES,
    validUntil: Date.now() + 10 * 60 * 1000
  };
  const signed = await issueSignedToken({ ...privateAuth(), ...constraints });
  const { presignedUrl } = await presignUrl(signed, {
    operation: 'put',
    pathname,
    access: 'private',
    addRandomSuffix: true,
    contentType,
    allowedContentTypes,
    maximumSizeInBytes: RECEIPT_MAX_BYTES
  });
  return { presignedUrl };
}

// Confirms a client-reported blob URL actually exists in our store and returns
// its authoritative size / content type / pathname, so we never trust the
// metadata the browser sends alongside a claim.
async function statReceipt(url) {
  const info = await head(url, privateAuth());
  return { size: info.size, contentType: info.contentType, pathname: info.pathname };
}

// encodeURIComponent, plus the few characters it leaves alone that RFC 5987
// doesn't allow unescaped in a header parameter.
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// The stored file's bytes as a web stream (plus its length when known), or null
// when storage has no such file — read with the private store's credentials.
async function openReceipt(url) {
  if (!BLOB_URL_RE.test(String(url || ''))) return null;
  const r = await get(url, { access: 'private', ...privateAuth() });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return { body: r.stream, length: r.headers.get('content-length') };
}

// Send one stored receipt (an attachments row) to the browser. Streamed rather
// than buffered: a receipt can be up to RECEIPT_MAX_BYTES, which is more than a
// function should hold in memory or return as a single buffered body. Only
// images and PDFs render inline; anything else is forced to download.
async function sendReceipt(res, att) {
  // Looked up on the exports so a test can stand in for storage.
  const file = await module.exports.openReceipt(att.blob_url);
  if (!file) return res.status(502).json({ error: 'Could not fetch file from storage' });
  const mime = String(att.mime_type || 'application/octet-stream');
  const inlineOk = mime === 'application/pdf' || mime.startsWith('image/');
  // RFC 6266: an ASCII fallback name plus the exact UTF-8 one, so the saved
  // file is "Receipt March.pdf", not "Receipt%20March.pdf".
  // A truncated UTF-16 filename can end in half an emoji. Replace unpaired
  // surrogates before URI encoding so a valid receipt still downloads.
  const name = String(att.original_name || 'file').toWellFormed();
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition',
    `${inlineOk ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`);
  // Receipts are personal documents: never let a shared cache keep a copy.
  res.setHeader('Cache-Control', 'private, no-store');
  if (file.length) res.setHeader('Content-Length', file.length);
  try {
    await pipeline(Readable.fromWeb(file.body), res);
  } catch (e) {
    // The viewer closed the tab or cancelled mid-download: nothing went wrong.
    if (e && e.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw e;
  }
}

async function deleteReceipt(url) {
  try { await del(url, privateAuth()); } catch { /* best effort */ }
}

module.exports = {
  uploadReceipt, deleteReceipt, presignReceiptUpload, statReceipt, sendReceipt, openReceipt,
  RECEIPT_MAX_BYTES, BLOB_URL_RE
};
