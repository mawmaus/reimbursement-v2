'use strict';
// Run once after creating your Neon database:
//   DATABASE_URL=... SEED_ADMIN_PASSWORD=... node scripts/setup-db.js
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const { SCHEMA } = require('../schema');

async function main() {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const sql = neon(process.env.DATABASE_URL);

  console.log('Creating tables…');
  for (const stmt of SCHEMA) await sql.query(stmt);

  const existing = await sql.query('SELECT COUNT(*)::int AS n FROM users');
  if (Number(existing[0].n) === 0) {
    const pass = process.env.SEED_ADMIN_PASSWORD || 'admin123';
    await sql.query(
      `INSERT INTO users (username, password_hash, full_name, role, department)
       VALUES ($1,$2,$3,$4,$5)`,
      ['admin', bcrypt.hashSync(pass, 10), 'System Admin', 'admin', 'IT']);
    console.log(`Created administrator  →  username: admin   password: ${pass}`);
    console.log('Change this password after first sign-in.');
  } else {
    console.log('Users already exist — left untouched.');
  }
  console.log('Done.');
}
main().catch((e) => { console.error(e); process.exit(1); });
