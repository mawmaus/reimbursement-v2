'use strict';
// Apply schema changes (DDL + role remap) without seeding or backfilling data.
// Loads DATABASE_URL from the environment, falling back to .env.local.
//   node scripts/migrate.js
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const { SCHEMA } = require('../schema');

// Best-effort load of .env.local for local runs (Vercel injects env in prod).
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

async function main() {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const sql = neon(process.env.DATABASE_URL);
  console.log('Applying schema…');
  for (const stmt of SCHEMA) await sql.query(stmt);
  console.log('Done.');
}
main().catch((e) => { console.error(e); process.exit(1); });
