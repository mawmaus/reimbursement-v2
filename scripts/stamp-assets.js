'use strict';

// Build step (Vercel runs it before serving public/ from its CDN):
//   node scripts/stamp-assets.js
// Rewrites each page's local <script src> / <link href> to carry a content hash,
// e.g. app.js -> app.js?v=3f9c1a2b. vercel.json marks ?v= URLs immutable, so a
// browser keeps them for good and only fetches again when the file changes (its
// hash, and so its URL, changes). The pages themselves stay `no-cache`, so a new
// deploy is always picked up on the next load. Idempotent: an existing ?v= is
// replaced. Locally the pages are served unstamped, which is fine.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pub = path.join(__dirname, '..', 'public');
const hashes = new Map();
const hashOf = (rel) => {
  if (!hashes.has(rel)) {
    const buf = fs.readFileSync(path.join(pub, rel));
    hashes.set(rel, crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10));
  }
  return hashes.get(rel);
};

let stamped = 0;
for (const page of fs.readdirSync(pub).filter(f => f.endsWith('.html'))) {
  const file = path.join(pub, page);
  const html = fs.readFileSync(file, 'utf8');
  const out = html.replace(/\b(src|href)="([\w./-]+\.(?:js|css))(?:\?v=[\w]+)?"/g, (m, attr, rel) => {
    if (!fs.existsSync(path.join(pub, rel))) return m;
    stamped++;
    return `${attr}="${rel}?v=${hashOf(rel)}"`;
  });
  if (out !== html) fs.writeFileSync(file, out);
}
console.log(`stamp-assets: versioned ${stamped} asset reference(s)`);
