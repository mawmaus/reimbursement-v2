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

  // Seed the settings lookups from any values already present in the data so
  // administrators start with a usable list. Safe to run repeatedly.
  console.log('Backfilling settings lookups…');
  await sql.query(
    `INSERT INTO departments (name)
     SELECT DISTINCT TRIM(department) FROM users
     WHERE TRIM(department) <> ''
     UNION
     SELECT DISTINCT TRIM(department) FROM claims WHERE TRIM(department) <> ''
     ON CONFLICT (name) DO NOTHING`);
  await sql.query(
    `INSERT INTO expense_types (name)
     SELECT DISTINCT TRIM(expense_type) FROM claims
     WHERE TRIM(expense_type) <> ''
     ON CONFLICT (name) DO NOTHING`);

  console.log('Done.');
}
main().catch((e) => { console.error(e); process.exit(1); });
