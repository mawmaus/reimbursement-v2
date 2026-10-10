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
  tables: { claims: [], meal_claims: [], cash_advances: [], claim_lines: [], meal_claim_lines: [], cash_advance_lines: [],
    departments: [], job_positions: [], expense_types: [], survey_responses: [],
    helpdesk_tickets: [], helpdesk_messages: [], helpdesk_attachments: [], feedback: [] },
  writes: [],
  reads: [],               // every query's text, so a test can see what was asked
  onWrite: null
};

const LINE_FK = { claim_lines: 'claim_id', meal_claim_lines: 'meal_claim_id', cash_advance_lines: 'advance_id' };
async function q(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  state.reads.push(sql);
  let m;
  if (/^SELECT key, value FROM app_settings/.test(sql)) {
    return Object.entries(state.settings).map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }));
  }
  if (/^SELECT .* FROM users WHERE id = \$1/.test(sql)) { const u = state.users.get(Number(params[0])); return u ? [{ ...u }] : []; }
  if (/^SELECT name, rank, can_manage FROM job_positions/.test(sql)) return state.positions.map(p => ({ ...p }));
  if ((m = sql.match(/^SELECT \* FROM (claims|meal_claims|cash_advances|departments|job_positions|expense_types) WHERE id ?= ?\$1$/))) {
    return state.tables[m[1]].filter(r => r.id === Number(params[0])).map(r => ({ ...r }));
  }
  if ((m = sql.match(/^SELECT \* FROM (claim_lines|meal_claim_lines|cash_advance_lines) WHERE (\w+) = \$1/)) && LINE_FK[m[1]] === m[2]) {
    return state.tables[m[1]].filter(l => l[m[2]] === Number(params[0])).map(l => ({ ...l }));
  }
  if ((m = sql.match(/^SELECT \* FROM (claims|meal_claims|cash_advances) WHERE id = ANY\(\$1::int\[\]\) AND status = \$2/))) {
    const ids = String(params[0]).replace(/[{}]/g, '').split(',').map(Number);
    return state.tables[m[1]].filter(r => ids.includes(r.id) && r.status === params[1]).map(r => ({ ...r }));
  }
  // A test may set state.onWrite to change a document just before a write (or
  // a resubmit's opening guard) lands, the way a second person acting at the
  // same moment would.
  if ((m = sql.match(/^WITH still AS \(SELECT id FROM (claims|meal_claims|cash_advances) WHERE id=\$1 AND status=\$2 AND COALESCE\(current_step, 0\)=\$3 FOR UPDATE\)/))) {
    if (state.onWrite) state.onWrite(sql, params);
    const r = state.tables[m[1]].find(x => x.id === Number(params[0]));
    if (r && r.status === params[1] && (r.current_step || 0) === params[2]) return [{ ok: 1 }];
    throw Object.assign(new Error('division by zero'), { code: '22012' }); // lib/workflow stillAsRead
  }
  // The experience survey (lib/survey.js): eligibility, and the answer itself.
  if (/^SELECT 1 AS pending FROM users u WHERE u.id = \$1 AND u.created_at < \$2::date/.test(sql)) {
    const u = state.users.get(Number(params[0]));
    const answered = state.tables.survey_responses.some(r => r.user_id === Number(params[0]) && r.survey_key === params[2]);
    return u && u.created_at && new Date(u.created_at) < new Date(params[1]) && !answered ? [{ pending: 1 }] : [];
  }
  if (/^INSERT INTO survey_responses/.test(sql)) {
    state.writes.push(sql.slice(0, 70));
    const [survey_key, user_id, region, department, paper_score, digital_score, overall_score] = params;
    state.tables.survey_responses.push({ survey_key, user_id, region, department, paper_score, digital_score, overall_score });
    return [];
  }
  // Helpdesk tickets and feedback (routes/help.js).
  const help = helpQuery(sql, params);
  if (help) return help;
  if (/COUNT\(/i.test(sql)) return [{ n: 0 }];
  if (/^(INSERT|UPDATE|DELETE|WITH)/.test(sql)) {
    if (state.onWrite) state.onWrite(sql, params);
    state.writes.push(sql.slice(0, 70));
    // Guarded status changes (lib/workflow moveDocument; the bulk routes' CTE)
    // only land while the document still has the status (and step) they expect.
    if ((m = sql.match(/^UPDATE (claims|meal_claims|cash_advances) SET .* WHERE id=\$(\d+) AND status=\$\d+ AND COALESCE\(current_step, 0\)=\$\d+ RETURNING id$/))) {
      const i = Number(m[2]) - 1;
      const r = state.tables[m[1]].find(x => x.id === Number(params[i]));
      return r && r.status === params[i + 1] && (r.current_step || 0) === params[i + 2] ? [{ id: r.id }] : [];
    }
    if ((m = sql.match(/^WITH moved AS \(UPDATE (claims|meal_claims|cash_advances) SET .* WHERE id=\$1 AND status=\$2::text RETURNING id\)/))) {
      const r = state.tables[m[1]].find(x => x.id === Number(params[0]));
      return r && r.status === params[1] ? [{ id: r.id }] : [];
    }
    return [];
  }
  return [];
}
// The helpdesk / feedback queries, over state.tables.helpdesk_tickets,
// helpdesk_messages and feedback. Returns null for anything else.
function helpQuery(sql, params) {
  const T = state.tables;
  const write = () => state.writes.push(sql.slice(0, 70));
  const ticket = (id) => T.helpdesk_tickets.find(x => x.id === Number(id));
  if (/^SELECT COUNT\(\*\)::int AS n FROM helpdesk_tickets WHERE status = 'open'/.test(sql)) return [{ n: T.helpdesk_tickets.filter(x => x.status === 'open').length }];
  if (/^SELECT COUNT\(\*\)::int AS n FROM feedback WHERE status = 'new'/.test(sql)) return [{ n: T.feedback.filter(x => x.status === 'new').length }];
  if (/^SELECT COUNT\(\*\)::int AS n FROM helpdesk_tickets WHERE user_id = \$1 AND user_unread/.test(sql)) {
    return [{ n: T.helpdesk_tickets.filter(x => x.user_id === params[0] && x.user_unread).length }];
  }
  if (/^WITH t AS \( INSERT INTO helpdesk_tickets/.test(sql)) {
    write();
    const [user_id, region, department, category, subject, body] = params;
    const id = T.helpdesk_tickets.length + 1;
    T.helpdesk_tickets.push({ id, user_id, region, department, category, subject, status: 'open', user_unread: false });
    const message_id = T.helpdesk_messages.length + 1;
    T.helpdesk_messages.push({ id: message_id, ticket_id: id, author_id: user_id, from_staff: false, body });
    return [{ id, subject, message_id }];
  }
  if (/^SELECT \* FROM helpdesk_tickets WHERE id = \$1/.test(sql)) { const r = ticket(params[0]); return r ? [{ ...r }] : []; }
  if (/^SELECT t\.id, .* FROM helpdesk_tickets t/.test(sql)) {
    const mine = /WHERE t\.user_id = \$1/.test(sql);
    return T.helpdesk_tickets.filter(x => !mine || x.user_id === params[0]).map(x => ({ ...x }));
  }
  if (/^SELECT m\.id, .* FROM helpdesk_messages m/.test(sql)) return T.helpdesk_messages.filter(m => m.ticket_id === params[0]).map(m => ({ ...m }));
  if (/^INSERT INTO helpdesk_messages/.test(sql)) {
    write();
    const [ticket_id, author_id, from_staff, body] = params;
    const id = T.helpdesk_messages.length + 1;
    T.helpdesk_messages.push({ id, ticket_id, author_id, from_staff, body });
    return [{ id }];
  }
  if (/^INSERT INTO helpdesk_attachments/.test(sql)) {
    write();
    const [ticket_id, message_id, ...rest] = params;
    for (let i = 0; i < rest.length; i += 4) {
      T.helpdesk_attachments.push({ id: T.helpdesk_attachments.length + 1, ticket_id, message_id,
        blob_url: rest[i], original_name: rest[i + 1], mime_type: rest[i + 2], size_bytes: rest[i + 3] });
    }
    return [];
  }
  if (/^SELECT id, message_id, original_name, mime_type, size_bytes FROM helpdesk_attachments/.test(sql)) {
    return T.helpdesk_attachments.filter(a => a.ticket_id === params[0]).map(a => ({ ...a }));
  }
  if (/^SELECT a.blob_url, .* FROM helpdesk_attachments a JOIN helpdesk_tickets t/.test(sql)) {
    const a = T.helpdesk_attachments.find(x => x.id === params[0]);
    const tk = a && ticket(a.ticket_id);
    return a && tk ? [{ blob_url: a.blob_url, original_name: a.original_name, mime_type: a.mime_type, user_id: tk.user_id }] : [];
  }
  if (/^UPDATE helpdesk_tickets SET/.test(sql)) {
    write();
    const r = ticket(params[0]);
    if (r && /SET status = \$2, user_unread = \$3/.test(sql)) Object.assign(r, { status: params[1], user_unread: params[2] });
    else if (r && /SET status = \$2, user_unread = FALSE/.test(sql)) Object.assign(r, { status: params[1], user_unread: false });
    else if (r && /SET user_unread = FALSE/.test(sql)) r.user_unread = false;
    return [];
  }
  if (/^INSERT INTO feedback/.test(sql)) {
    write();
    const [user_id, anonymous, region, department, kind, topic, body] = params;
    T.feedback.push({ id: T.feedback.length + 1, user_id, anonymous, region, department, kind, topic, body, status: 'new', response: '' });
    return [];
  }
  if (/^SELECT f\.id, .* FROM feedback f/.test(sql)) {
    const mine = /WHERE f\.user_id = \$1/.test(sql);
    return T.feedback.filter(x => !mine || x.user_id === params[0]).map(x => ({ ...x, sender_name: x.user_id ? 'User ' + x.user_id : null }));
  }
  if (/^SELECT \* FROM feedback WHERE id = \$1/.test(sql)) { const r = T.feedback.find(x => x.id === Number(params[0])); return r ? [{ ...r }] : []; }
  if (/^UPDATE feedback SET/.test(sql)) {
    write();
    const r = T.feedback.find(x => x.id === Number(params[0]));
    if (r) Object.assign(r, { status: 'read' }, params.length > 1 ? { response: params[1], responded_by: params[2] } : {});
    return [];
  }
  return null;
}
// Like the real driver, qq builds a query without running it, and a
// transaction runs its queries in order, stopping at the first error.
const qq = (text, params) => () => q(text, params);
const transaction = async (queries) => {
  const out = [];
  for (const run of queries) out.push(await run());
  return out;
};
const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { q, qq, transaction, sql: null } };
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
