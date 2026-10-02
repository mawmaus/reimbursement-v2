'use strict';

// Receipt upload (presigned direct-to-Blob and same-origin) and reverse
// geocoding for receipt photos.

const express = require('express');
const { uploadReceipt, presignReceiptUpload, RECEIPT_MAX_BYTES } = require('../lib/blob');
const { requireAuth } = require('../lib/auth');
const { ah } = require('../lib/util');
const { MAX_FILES, ALLOWED_MIME } = require('../lib/uploads');

const router = express.Router();

// Issue presigned upload URLs so the browser can upload receipts directly to
// Blob storage, bypassing the serverless function's ~4.5 MB request-body limit.
// Returns one URL per requested file, in the same order.
router.post('/api/uploads/presign', requireAuth, ah(async (req, res) => {
  const files = Array.isArray(req.body && req.body.files) ? req.body.files : null;
  if (!files || !files.length) return res.status(400).json({ error: 'No files to upload' });
  if (files.length > MAX_FILES) return res.status(400).json({ error: `Maximum ${MAX_FILES} files` });
  const allowed = [...ALLOWED_MIME];
  const uploads = [];
  for (const f of files) {
    const type = String((f && f.type) || '').toLowerCase();
    if (!ALLOWED_MIME.has(type)) return res.status(400).json({ error: `File type not allowed: ${type || 'unknown'}` });
    if ((Number(f && f.size) || 0) > RECEIPT_MAX_BYTES) {
      return res.status(413).json({ error: `${(f && f.name) || 'A file'} exceeds the size limit` });
    }
    uploads.push(await presignReceiptUpload(f && f.name, type, allowed));
  }
  res.json({ uploads });
}));

// Same-origin upload path: the browser POSTs the raw file bytes to our own
// domain and we forward them to Blob. This is the reliable default for files
// that fit under the function's ~4.5 MB body limit — some networks (and iOS
// setups) can reach *.vercel.app but not the vercel.com host the presigned
// direct-upload URLs point at, so routing through our origin avoids that.
router.post('/api/uploads/direct', requireAuth,
  express.raw({ type: () => true, limit: '4400kb' }), ah(async (req, res) => {
    const name = String(req.query.name || 'file');
    const type = String(req.query.type || '').toLowerCase();
    if (!ALLOWED_MIME.has(type)) return res.status(400).json({ error: `File type not allowed: ${type || 'unknown'}` });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: 'Empty upload' });
    const r = await uploadReceipt(buf, name, type);
    res.json({ url: r.url, pathname: r.pathname, size: buf.length, contentType: type });
  }));

// Reverse-geocode a GPS coordinate to a human-readable address for the receipt
// camera stamp. Proxied through our own origin so the browser CSP can stay
// `connect-src 'self'`, and so we present one compliant User-Agent to the public
// Nominatim service (its usage policy requires a real UA and rate-limits by
// caller). Best-effort: any failure returns { address: null } and the client
// falls back to stamping the raw coordinates.
router.get('/api/geocode', requireAuth, ah(async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  // Language preference for the returned address (falls back to English).
  const lang = (String(req.query.lang || 'en').match(/[a-zA-Z-]+/) || ['en'])[0].slice(0, 8);
  const url = 'https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&addressdetails=0'
    + `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'CibesReimbursement/1.0 (reimbursement receipt stamping)',
        'Accept': 'application/json',
        'Accept-Language': `${lang}, en;q=0.5`
      }
    });
    if (!r.ok) return res.json({ address: null });
    const j = await r.json();
    res.json({ address: (j && typeof j.display_name === 'string' && j.display_name) || null });
  } catch {
    res.json({ address: null }); // timeout / network / unreachable — client stamps coords only
  } finally {
    clearTimeout(timer);
  }
}));

module.exports = router;
