'use strict';

const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { put, del, head, issueSignedToken, presignUrl } = require('@vercel/blob');

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// Server ceiling for a single receipt. The browser compresses images to 10 MB
// before uploading; this leaves headroom for PDFs and encoding overhead. Kept
// well under Blob's own 5 TB cap but generous vs. the old 4 MB function limit.
const RECEIPT_MAX_BYTES = 15 * 1024 * 1024;

// A blob URL that genuinely belongs to a public Vercel Blob store.
const BLOB_URL_RE = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//i;

const safeName = (name) => String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-60);

// Uploads a file buffer to Vercel Blob and returns { url, pathname }.
// Uses a public store with an unguessable random suffix; the URL is never sent
// to the browser — downloads are proxied through an authenticated route — so
// access is gated by the app even though the store is technically public.
async function uploadReceipt(buffer, originalName, mimeType) {
  const blob = await put(`receipts/${safeName(originalName)}`, buffer, {
    access: 'public',
    addRandomSuffix: true,
    contentType: mimeType || 'application/octet-stream'
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
  const signed = await issueSignedToken({ token: TOKEN, ...constraints });
  const { presignedUrl } = await presignUrl(signed, {
    operation: 'put',
    pathname,
    access: 'public',
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
  const info = await head(url, { token: TOKEN });
  return { size: info.size, contentType: info.contentType, pathname: info.pathname };
}

// encodeURIComponent, plus the few characters it leaves alone that RFC 5987
// doesn't allow unescaped in a header parameter.
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Send one stored receipt (an attachments row) to the browser. Streamed rather
// than buffered: a receipt can be up to RECEIPT_MAX_BYTES, which is more than a
// function should hold in memory or return as a single buffered body. Only
// images and PDFs render inline; anything else is forced to download.
async function sendReceipt(res, att) {
  const r = await fetch(att.blob_url);
  if (!r.ok || !r.body) return res.status(502).json({ error: 'Could not fetch file from storage' });
  const mime = String(att.mime_type || 'application/octet-stream');
  const inlineOk = mime === 'application/pdf' || mime.startsWith('image/');
  // RFC 6266: an ASCII fallback name plus the exact UTF-8 one, so the saved
  // file is "Receipt March.pdf", not "Receipt%20March.pdf".
  const name = String(att.original_name || 'file');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition',
    `${inlineOk ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`);
  const len = r.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  try {
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (e) {
    // The viewer closed the tab or cancelled mid-download: nothing went wrong.
    if (e && e.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw e;
  }
}

async function deleteReceipt(url) {
  try { await del(url, { token: TOKEN }); } catch { /* best effort */ }
}

module.exports = {
  uploadReceipt, deleteReceipt, presignReceiptUpload, statReceipt, sendReceipt,
  RECEIPT_MAX_BYTES, BLOB_URL_RE
};
