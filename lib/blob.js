'use strict';

const { put, del } = require('@vercel/blob');

// Uploads a file buffer to Vercel Blob and returns { url, pathname }.
// Uses a public store with an unguessable random suffix; the URL is never sent
// to the browser — downloads are proxied through an authenticated route — so
// access is gated by the app even though the store is technically public.
async function uploadReceipt(buffer, originalName, mimeType) {
  const safe = String(originalName || 'file').replace(/[^\w.\-]+/g, '_').slice(-60);
  const blob = await put(`receipts/${safe}`, buffer, {
    access: 'public',
    addRandomSuffix: true,
    contentType: mimeType || 'application/octet-stream'
  });
  return { url: blob.url, pathname: blob.pathname };
}

async function deleteReceipt(url) {
  try { await del(url); } catch { /* best effort */ }
}

module.exports = { uploadReceipt, deleteReceipt };
