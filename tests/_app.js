'use strict';

// Test harness: the real app (Express, sessions, every route and permission
// check) over an in-memory stand-in for the database, so endpoint tests never
// touch the real one. Each test file runs in its own process, so a file sets
// `state` once and drives the app with `call(userId, method, path, body)`.
//
// The stand-in answers the reads the routes make before deciding (accounts,
// settings, positions, the document and its lines) and records every write in
// `state.writes`, so a test can prove a refused request changed nothing.
const http = require('node:http');
const path = require('node:path');
const Keygrip = require('keygrip');

process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
process.env.SESSION_SECRET = 'endpoint-tests';

const state = {
  users: new Map(),        // id -> account row
  settings: {},            // app_settings key -> value (objects are JSON-encoded)
  positions: [],           // job_positions rows { name, rank, can_manage }
  tables: { claims: [], meal_claims: [], cash_advances: [], claim_lines: [], meal_claim_lines: [], cash_advance_lines: [] },
  writes: []
};

const LINE_FK = { claim_lines: 'claim_id', meal_claim_lines: 'meal_claim_id', cash_advance_lines: 'advance_id' };
async function q(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  let m;
  if (/^SELECT key, value FROM app_settings/.test(sql)) {
    return Object.entries(state.settings).map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }));
  }
  if (/^SELECT .* FROM users WHERE id = \$1/.test(sql)) { const u = state.users.get(Number(params[0])); return u ? [{ ...u }] : []; }
  if (/^SELECT name, rank, can_manage FROM job_positions/.test(sql)) return state.positions.map(p => ({ ...p }));
  if ((m = sql.match(/^SELECT \* FROM (claims|meal_claims|cash_advances) WHERE id ?= ?\$1$/))) {
    return state.tables[m[1]].filter(r => r.id === Number(params[0])).map(r => ({ ...r }));
  }
  if ((m = sql.match(/^SELECT \* FROM (claim_lines|meal_claim_lines|cash_advance_lines) WHERE (\w+) = \$1/)) && LINE_FK[m[1]] === m[2]) {
    return state.tables[m[1]].filter(l => l[m[2]] === Number(params[0])).map(l => ({ ...l }));
  }
  if ((m = sql.match(/^SELECT \* FROM (claims|meal_claims|cash_advances) WHERE id = ANY\(\$1::int\[\]\) AND status = \$2/))) {
    const ids = String(params[0]).replace(/[{}]/g, '').split(',').map(Number);
    return state.tables[m[1]].filter(r => ids.includes(r.id) && r.status === params[1]).map(r => ({ ...r }));
  }
  if (/COUNT\(/i.test(sql)) return [{ n: 0 }];
  if (/^(INSERT|UPDATE|DELETE)/.test(sql)) { state.writes.push(sql.slice(0, 70)); return []; }
  return [];
}
const transaction = async (queries) => { for (const x of queries) await x; return queries.map(() => []); };
const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { q, qq: q, transaction, sql: null } };
const app = require('../app');

// Account and document builders with sensible defaults.
const account = (props) => ({ role: 'employee', region: 'Indonesia', department: 'Sales', position: 'Staff', active: true,
  session_version: 0, approver_ids: [], approver1_options: [], language: 'en', email: '', can_mark_paid: false,
  allow_advance: false, approval_limit_cents: null, full_name: 'User ' + props.id, username: 'user' + props.id, ...props });
const doc = (props) => ({ region: 'Indonesia', status: 'submitted', current_step: 1, approver_ids: [], manager_id: null,
  amount_cents: 100000, total_cents: 100000, realized_total_cents: 100000, currency: 'IDR', claimant_name: 'Claimant',
  created_at: new Date(), claim_no: 'RC-2026-' + props.id, advance_no: 'CA-2026-' + props.id, ...props });

// A signed session cookie for a user, in cookie-session's format.
const cookieFor = (userId) => {
  const value = Buffer.from(JSON.stringify({ userId, sv: 0 })).toString('base64');
  return `rsess=${value}; rsess.sig=${new Keygrip([process.env.SESSION_SECRET]).sign(`rsess=${value}`)}`;
};

let port = null;
// Start the app once per test file (closed by `after` in the caller).
async function serve(t) {
  t.mock.method(console, 'error', () => {});
  if (port) return;
  const s = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise(r => s.once('listening', r));
  port = s.address().port;
  s.unref();
}
// One request as `userId` (null = signed out). Resolves { status, body, json }.
function call(userId, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: {
      'x-forwarded-proto': 'https', // as Vercel's proxy sends (Secure cookies under VERCEL=1)
      ...(userId != null ? { cookie: cookieFor(userId) } : {}),
      ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, body: b, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

module.exports = { state, account, doc, serve, call };
