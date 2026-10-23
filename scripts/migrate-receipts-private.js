'use strict';
// Copy every receipt the database still points at in the old PUBLIC Blob store
// into the PRIVATE store, then repoint the rows (2026-10-23). A public blob opens
// for anyone holding its URL; a private one only through the app's signed-in
// attachment routes. See lib/blob.js.
//
//   node scripts/migrate-receipts-private.js
//       Read-only report: how many receipts (and how many bytes) are still public.
//
//   node scripts/migrate-receipts-private.js --confirm
//       Copies each one to the same pathname in the private store, checks the
//       copy's size against the original, and only then repoints attachments /
//       helpdesk_attachments from the old URL to the new one. Safe to re-run:
//       rows already on the private store are skipped, and a receipt that fails
//       is left on its old URL (still working) and listed at the end.
//
// The old store is left untouched — its files stay public until it is deleted.
//
// Loads DATABASE_URL, BLOB_READ_WRITE_TOKEN (old public store) and
// PRIVATE_READ_WRITE_TOKEN — or PRIVATE_STORE_ID with VERCEL_OIDC_TOKEN — from
// the environment, falling back to .env.local.
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

try {
  const file = path.join(__dirname, '..', '.env.local');
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
} catch { /* no .env.local — rely on real env */ }

// Required after .env.local is read: the SDK looks for VERCEL_OIDC_TOKEN itself.
const { put, head } = require('@vercel/blob');
const { BLOB_URL_RE } = require('../lib/blob');

const PARALLEL = 6;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function privateAuth() {
  if (process.env.PRIVATE_READ_WRITE_TOKEN) return { token: process.env.PRIVATE_READ_WRITE_TOKEN };
  if (process.env.PRIVATE_STORE_ID) return { storeId: process.env.PRIVATE_STORE_ID };
  console.error('Set PRIVATE_READ_WRITE_TOKEN (or PRIVATE_STORE_ID with VERCEL_OIDC_TOKEN) first.');
  process.exit(1);
}

// Every distinct stored URL that is not yet on a private store, with what the
// rows say about it.
async function publicReceipts(sql) {
  const rows = await sql.query(`
    SELECT blob_url, max(size_bytes)::bigint AS size, count(*)::int AS n
      FROM (SELECT blob_url, size_bytes FROM attachments
            UNION ALL SELECT blob_url, size_bytes FROM helpdesk_attachments) a
     GROUP BY blob_url ORDER BY blob_url`);
  return rows.filter(r => !BLOB_URL_RE.test(r.blob_url));
}

async function copyOne(sql, auth, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`old store answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const pathname = decodeURIComponent(new URL(url).pathname.slice(1));
  const blob = await put(pathname, bytes, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true, // a re-run after a half-finished copy
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    ...auth
  });
  const check = await head(blob.url, auth);
  if (check.size !== bytes.length) throw new Error(`copy is ${check.size} bytes, original ${bytes.length}`);
  await sql.transaction([
    sql.query('UPDATE attachments SET blob_url = $1, blob_pathname = $2 WHERE blob_url = $3', [blob.url, blob.pathname, url]),
    sql.query('UPDATE helpdesk_attachments SET blob_url = $1 WHERE blob_url = $2', [blob.url, url])
  ]);
  return bytes.length;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const sql = neon(process.env.DATABASE_URL);
  const todo = await publicReceipts(sql);
  const bytes = todo.reduce((s, r) => s + Number(r.size || 0), 0);
  const rows = todo.reduce((s, r) => s + r.n, 0);
  console.log(`${todo.length} receipt file(s) still public (${rows} row(s), about ${mb(bytes)}).`);
  if (!todo.length) return console.log('Nothing to do: every stored receipt is on the private store.');
  if (!process.argv.includes('--confirm')) return console.log('\nDry run. Re-run with --confirm to copy them.');

  const auth = privateAuth();
  const failed = [];
  let done = 0, copied = 0, next = 0;
  async function worker() {
    while (next < todo.length) {
      const r = todo[next++];
      // Await first: `copied += await …` would add to a stale total.
      try { const n = await copyOne(sql, auth, r.blob_url); copied += n; }
      catch (e) { failed.push({ url: r.blob_url, error: e.message || String(e) }); }
      if (++done % 25 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}  (${mb(copied)} copied)`);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  console.log(`\nCopied ${todo.length - failed.length} of ${todo.length}.`);
  if (failed.length) {
    console.log(`${failed.length} failed and still point at the old store:`);
    for (const f of failed) console.log(`  ${f.url}\n    ${f.error}`);
    process.exitCode = 1;
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
