'use strict';

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

async function deleteReceipt(url) {
  try { await del(url, { token: TOKEN }); } catch { /* best effort */ }
}

module.exports = {
  uploadReceipt, deleteReceipt, presignReceiptUpload, statReceipt,
  RECEIPT_MAX_BYTES, BLOB_URL_RE
};
