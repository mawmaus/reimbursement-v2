'use strict';

// Re-apply only the users_role_check statements from schema.js (e.g. after a
// new role is added), without re-running every other migration's backfills.
// Loads DATABASE_URL from the environment, falling back to .env.local.
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const { SCHEMA } = require('../schema');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local — rely on real env */ }

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const sql = neon(process.env.DATABASE_URL);
  for (const s of SCHEMA.filter(x => /users_role_check|WHERE role NOT IN/.test(x))) {
    console.log('>', s);
    await sql.query(s);
  }
  const r = await sql.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'users_role_check'");
  console.log('Now:', (r.rows || r)[0].def);
})().catch(e => { console.error(e.message); process.exit(1); });
