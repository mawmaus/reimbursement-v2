'use strict';
// Reset an account's password by rewriting its bcrypt hash directly in the DB.
//   node scripts/reset-admin.js <newPassword> [username]
// username defaults to "admin". Loads DATABASE_URL from the environment,
// falling back to .env.local.
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

// Best-effort load of .env.local for local runs.
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
} catch { /* rely on real env */ }

async function main() {
  const newPassword = process.argv[2];
  const username = process.argv[3] || 'admin';
  if (!newPassword || newPassword.length < 6) {
    console.error('Usage: node scripts/reset-admin.js <newPassword(min 6 chars)> [username]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const sql = neon(process.env.DATABASE_URL);
  const hash = bcrypt.hashSync(String(newPassword), 10);
  const rows = await sql.query(
    'UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING id, username, role',
    [hash, username]);
  if (!rows[0]) { console.error(`No user found with username "${username}".`); process.exit(1); }
  console.log(`Password reset for "${rows[0].username}" (role: ${rows[0].role}, id: ${rows[0].id}).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
