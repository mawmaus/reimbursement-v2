'use strict';
// Load pinned customer sites (Settings → Customer sites) from a JSON file:
//   node scripts/import-customer-sites.js sites.json [--dry]
// The file is a list of { region, db_no, name, alias, address, lat, lng }; db_no may be
// "DB500222" or "500222". A site already pinned for that region + DB number is
// updated in place. Needs the customer_sites table (node scripts/migrate.js).
// Loads DATABASE_URL from the environment, falling back to .env.local.
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

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) { console.error('Usage: node scripts/import-customer-sites.js sites.json [--dry]'); process.exit(1); }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sites = [];
  for (const r of rows) {
    const db_no = String(r.db_no || '').replace(/\D/g, '');
    const lat = Number(r.lat), lng = Number(r.lng);
    if (!db_no || !r.region || !(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) { console.warn('Skipped', JSON.stringify(r)); continue; }
    sites.push({ region: String(r.region), db_no, name: String(r.name || '').trim().slice(0, 200), alias: String(r.alias || '').trim().slice(0, 200), address: String(r.address || '').trim().slice(0, 500), lat, lng });
  }
  console.log(`${sites.length} site(s) to load.`);
  if (flag === '--dry') return;
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const sql = neon(process.env.DATABASE_URL);
  let n = 0;
  for (const s of sites) {
    await sql.query(
      `INSERT INTO customer_sites (region, db_no, name, alias, address, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (region, db_no) WHERE db_no <> '' DO UPDATE SET name = EXCLUDED.name, alias = EXCLUDED.alias, address = EXCLUDED.address, lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
      [s.region, s.db_no, s.name, s.alias, s.address, s.lat, s.lng]);
    if (++n % 50 === 0) console.log(`  ${n}…`);
  }
  const [{ count }] = await sql.query('SELECT COUNT(*)::int AS count FROM customer_sites');
  console.log(`Done: ${n} loaded; ${count} site(s) in the table.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
