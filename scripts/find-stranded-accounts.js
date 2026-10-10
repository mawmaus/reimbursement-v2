'use strict';
// Find accounts whose department or job position no longer matches an active
// entry in their region — e.g. left behind when a department was renamed before
// renames carried accounts along (2026-10-10). Claim rights are looked up by
// those names (lib/workflow.js computePurposes), so such accounts can't raise
// claims or meal allowances, and a missing position also loses its rank.
//
//   node scripts/find-stranded-accounts.js
//       Read-only report. Groups stranded accounts by the name they carry,
//       suggests the closest active name in their region, and writes the
//       suggestions to stranded-accounts.plan.json for review.
//
//   node scripts/find-stranded-accounts.js --apply stranded-accounts.plan.json
//       Dry run of a reviewed plan: shows what each entry would change.
//
//   node scripts/find-stranded-accounts.js --apply stranded-accounts.plan.json --confirm
//       Applies it in one transaction. Only entries with a non-empty "to" are
//       used, and every "to" must still be an active entry in that region.
//
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

const FIELDS = [
  { field: 'department', table: 'departments', label: 'Department' },
  { field: 'position', table: 'job_positions', label: 'Job position' }
];
const ALL_REGIONS = '*';
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
// A blank or All-regions account matches any region's entry (as the server does).
const concrete = (region) => !!region && region !== ALL_REGIONS;

// Similarity 0..1 from edit distance, with a boost when one name contains the
// other ("Sales" → "Sales & Marketing").
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  const score = 1 - prev[n] / Math.max(m, n);
  return a.includes(b) || b.includes(a) ? Math.max(score, 0.75) : score;
}

async function load(sql) {
  const [users, ...lookups] = await Promise.all([
    sql.query(`SELECT id, username, full_name, role, region, department, position, active FROM users ORDER BY region, full_name`),
    ...FIELDS.map(f => sql.query(`SELECT name, region, active FROM ${f.table}`))
  ]);
  return { users, lookups: Object.fromEntries(FIELDS.map((f, i) => [f.field, lookups[i]])) };
}

// Every account/field whose value has no active match, grouped by
// region + field + carried name.
function findStranded({ users, lookups }) {
  const groups = new Map();
  for (const u of users) {
    if (u.role === 'superadmin') continue; // Super Admins can always claim
    for (const f of FIELDS) {
      const v = norm(u[f.field]);
      if (!v) continue; // blank values are reported separately
      const rows = lookups[f.field].filter(r => !concrete(u.region) || r.region === u.region);
      if (rows.some(r => r.active && norm(r.name) === v)) continue;
      const disabled = rows.some(r => !r.active && norm(r.name) === v);
      const key = `${u.region}\u0000${f.field}\u0000${v}`;
      if (!groups.has(key)) {
        const active = rows.filter(r => r.active);
        const ranked = active.map(r => ({ name: r.name, score: similarity(v, r.name) })).sort((a, b) => b.score - a.score);
        const best = ranked[0] && ranked[0].score >= 0.5 && !disabled ? ranked[0] : null;
        groups.set(key, { region: u.region, field: f.field, label: f.label, from: String(u[f.field]).trim(), reason: disabled ? 'disabled' : 'missing',
          suggestion: best ? best.name : null, confidence: best ? Math.round(best.score * 100) : 0,
          alternatives: ranked.slice(best ? 1 : 0, 4).map(r => r.name), accounts: [] });
      }
      groups.get(key).accounts.push(u);
    }
  }
  return [...groups.values()].sort((a, b) => a.region.localeCompare(b.region) || a.field.localeCompare(b.field) || b.accounts.length - a.accounts.length);
}

async function report(sql) {
  const data = await load(sql);
  const groups = findStranded(data);
  const blank = data.users.filter(u => u.role !== 'superadmin' && u.active && (!norm(u.department) || !norm(u.position)));
  const activeCount = (g) => g.accounts.filter(u => u.active).length;
  if (!groups.length) console.log('No stranded accounts: every department and job position matches an active entry in its region.');
  for (const g of groups) {
    console.log(`\n[${g.region || '(no region)'}] ${g.label} "${g.from}" — ${g.reason === 'disabled' ? 'entry is DISABLED' : 'no such entry'}`);
    console.log(`  ${g.accounts.length} account(s), ${activeCount(g)} active:`);
    for (const u of g.accounts) console.log(`    #${u.id} ${u.full_name} (${u.username})${u.active ? '' : ' — inactive'}`);
    if (g.reason === 'disabled') console.log('  → Re-enable it in Settings if these accounts should still claim (no rename needed).');
    else if (g.suggestion) console.log(`  → Suggest: "${g.suggestion}" (${g.confidence}% match)${g.alternatives.length ? `; others: ${g.alternatives.map(a => `"${a}"`).join(', ')}` : ''}`);
    else console.log(`  → No close match. Active ${g.field === 'position' ? 'positions' : 'departments'} here: ${g.alternatives.length ? g.alternatives.map(a => `"${a}"`).join(', ') + '…' : '(none)'}`);
  }
  if (blank.length) console.log(`\nAlso: ${blank.length} active account(s) have a blank department or position (they can't claim until one is set): ${blank.map(u => `#${u.id}`).join(', ')}`);

  const plan = groups.filter(g => g.reason === 'missing').map(g => ({
    region: g.region, field: g.field, from: g.from, to: g.suggestion || '',
    accounts: g.accounts.length, confidence: g.confidence, alternatives: g.alternatives
  }));
  if (plan.length) {
    const out = path.resolve('stranded-accounts.plan.json');
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
    console.log(`\nWrote ${plan.length} suggestion(s) to ${out}`);
    console.log('Review it: set "to" to the right active name, or "" to leave an entry alone. Then:');
    console.log(`  node scripts/find-stranded-accounts.js --apply ${path.basename(out)}            (dry run)`);
    console.log(`  node scripts/find-stranded-accounts.js --apply ${path.basename(out)} --confirm  (apply)`);
  }
}

async function apply(sql, file, confirm) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(plan)) throw new Error('The plan must be a JSON array.');
  const { lookups } = await load(sql);
  const todo = [];
  for (const e of plan) {
    const f = FIELDS.find(x => x.field === e.field);
    if (!f) throw new Error(`Unknown field "${e.field}"`);
    const to = String(e.to || '').trim();
    if (!to) { console.log(`skip  [${e.region}] ${f.label} "${e.from}" (no "to")`); continue; }
    const target = lookups[f.field].find(r => r.active && norm(r.name) === norm(to) && (!concrete(e.region) || r.region === e.region));
    if (!target) throw new Error(`[${e.region}] "${to}" is not an active ${f.label.toLowerCase()} there — fix the plan and run again.`);
    todo.push({ ...e, to: target.name, f });
  }
  if (!todo.length) { console.log('Nothing to apply.'); return; }
  if (!confirm) {
    for (const e of todo) console.log(`would set ${e.f.field} "${e.from}" → "${e.to}" in [${e.region}] (${e.accounts} account(s) in the report)`);
    console.log('\nDry run — nothing changed. Add --confirm to apply.');
    return;
  }
  // All-or-nothing: one transaction for the whole plan.
  const results = await sql.transaction(todo.map(e => sql.query(
    `UPDATE users SET ${e.f.field} = $1 WHERE region = $2 AND role <> 'superadmin' AND lower(trim(${e.f.field})) = lower(trim($3)) RETURNING id`,
    [e.to, e.region, e.from])));
  todo.forEach((e, i) => console.log(`set ${e.f.field} "${e.from}" → "${e.to}" in [${e.region}]: ${results[i].length} account(s) updated`));
  console.log('\nDone. Run the report again to confirm nothing is left.');
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const sql = neon(process.env.DATABASE_URL);
  const args = process.argv.slice(2);
  const i = args.indexOf('--apply');
  if (i >= 0) {
    if (!args[i + 1]) { console.error('Usage: --apply <plan.json> [--confirm]'); process.exit(1); }
    await apply(sql, args[i + 1], args.includes('--confirm'));
  } else {
    await report(sql);
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
