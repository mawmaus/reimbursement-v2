'use strict';

// End to end through the real app (Express, cookie-session, bcrypt, the auth
// routes) with an in-memory stand-in for the database, so it never touches the
// real one: a password change signs out the account's other sessions.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const bcrypt = require('bcryptjs');

process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
process.env.SESSION_SECRET = 'session-flow-test';

// --- the stand-in database: one table of users, everything else empty --------
const users = new Map();
const resets = []; // password_resets rows { user_id, token_hash, used }
function addUser(u) {
  users.set(u.id, { role: 'employee', department: 'Sales', position: 'Staff', region: 'Indonesia', active: true,
    session_version: 0, approver_ids: [], approver1_options: [], language: 'en', email: '', ...u });
}
async function q(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  if (/^SELECT id, full_name, email, active FROM users WHERE lower\(email\)/.test(sql)) {
    const k = String(params[0]).toLowerCase();
    return [...users.values()].filter(u => (u.email || '').toLowerCase() === k || u.username.toLowerCase() === k);
  }
  if (/^INSERT INTO password_resets/.test(sql)) { resets.push({ user_id: params[0], token_hash: params[1], used: false }); return []; }
  if (/^UPDATE password_resets SET used_at = now\(\) WHERE user_id = \$1/.test(sql)) {
    resets.filter(r => r.user_id === params[0]).forEach(r => { r.used = true; }); return [];
  }
  if (/^UPDATE password_resets SET used_at = now\(\) WHERE token_hash = \$1/.test(sql)) {
    const r = resets.find(x => x.token_hash === params[0] && !x.used);
    if (!r) return [];
    r.used = true; return [{ user_id: r.user_id }];
  }
  if (/^SELECT \* FROM users WHERE username = \$1/.test(sql)) return [...users.values()].filter(u => u.username === params[0]);
  if (/^SELECT .* FROM users WHERE id = \$1/.test(sql)) { const u = users.get(Number(params[0])); return u ? [{ ...u }] : []; }
  if (/^UPDATE users SET password_hash = \$1, session_version = session_version \+ 1 WHERE id = \$2 RETURNING session_version/.test(sql)) {
    const u = users.get(Number(params[1])); u.password_hash = params[0]; u.session_version += 1;
    return [{ session_version: u.session_version }];
  }
  if (/COUNT\(/i.test(sql)) return [{ n: 0 }];
  if (/^(INSERT|UPDATE|DELETE)/.test(sql) && !/users/.test(sql)) return [];
  if (/^(INSERT|UPDATE|DELETE)/.test(sql)) throw new Error('unexpected write to users: ' + sql);
  return []; // settings, positions, login throttle … all empty
}
const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { q, qq: q, transaction: async () => [], sql: null } };
const app = require('../app');

// --- a tiny cookie-aware client: one per "device" ----------------------------
function device(port) {
  let cookie = '';
  return (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    // As Vercel's proxy does: with VERCEL=1 (e.g. in the build) the app trusts
    // the proxy and issues Secure-only cookies, which need an HTTPS request.
    const req = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: { 'x-forwarded-proto': 'https', ...(data ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      const set = res.headers['set-cookie'];
      if (set) cookie = set.map(c => c.split(';')[0]).join('; ');
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

test('changing your password signs out your other sessions, not this one', async (t) => {
  t.mock.method(console, 'error', () => {});
  addUser({ id: 7, username: 'ana', full_name: 'Ana', password_hash: bcrypt.hashSync('first-password', 4) });
  const s = http.createServer(app).listen(0, '127.0.0.1'); t.after(() => s.close());
  await new Promise(r => s.once('listening', r));
  const laptop = device(s.address().port), phone = device(s.address().port);

  assert.equal((await laptop('POST', '/api/login', { username: 'ana', password: 'first-password' })).status, 200);
  assert.equal((await phone('POST', '/api/login', { username: 'ana', password: 'first-password' })).status, 200);
  assert.equal((await phone('GET', '/api/me')).status, 200, 'both devices signed in');

  const change = await laptop('POST', '/api/me/password', { current_password: 'first-password', new_password: 'second-password' });
  assert.equal(change.status, 200);
  assert.equal((await laptop('GET', '/api/me')).status, 200, 'the device that changed it stays signed in');
  assert.equal((await phone('GET', '/api/me')).status, 401, 'the other device is signed out');
  assert.equal((await phone('GET', '/api/claims')).status, 401, '…for every endpoint, not just /api/me');
  assert.equal((await laptop('GET', '/api/me')).body.user.session_version, undefined, 'the version never reaches the browser');

  // Signing in again with the new password works; the old one doesn't.
  assert.equal((await phone('POST', '/api/login', { username: 'ana', password: 'first-password' })).status, 401);
  assert.equal((await phone('POST', '/api/login', { username: 'ana', password: 'second-password' })).status, 200);
  assert.equal((await phone('GET', '/api/me')).status, 200);
});

test('an admin password reset signs the account out everywhere', async (t) => {
  t.mock.method(console, 'error', () => {});
  addUser({ id: 8, username: 'budi', full_name: 'Budi', password_hash: bcrypt.hashSync('budi-password', 4) });
  addUser({ id: 1, username: 'root', full_name: 'Root', role: 'superadmin', region: '*', password_hash: bcrypt.hashSync('root-password', 4) });
  const s = http.createServer(app).listen(0, '127.0.0.1'); t.after(() => s.close());
  await new Promise(r => s.once('listening', r));
  const budi = device(s.address().port), admin = device(s.address().port);

  await budi('POST', '/api/login', { username: 'budi', password: 'budi-password' });
  await admin('POST', '/api/login', { username: 'root', password: 'root-password' });
  assert.equal((await budi('GET', '/api/me')).status, 200);

  const reset = await admin('POST', '/api/users/8/reset-password', { password: 'reset-by-admin' });
  assert.equal(reset.status, 200);
  assert.equal((await budi('GET', '/api/me')).status, 401, 'the account is signed out');
  assert.equal((await admin('GET', '/api/me')).status, 200, 'the admin is unaffected');
});

test('a cookie issued before session versions existed keeps working', async (t) => {
  t.mock.method(console, 'error', () => {});
  addUser({ id: 9, username: 'citra', full_name: 'Citra', password_hash: bcrypt.hashSync('citra-password', 4) });
  const s = http.createServer(app).listen(0, '127.0.0.1'); t.after(() => s.close());
  await new Promise(r => s.once('listening', r));
  // Forge the old cookie shape ({ userId } only) with the same signing key.
  const Keygrip = require('keygrip');
  const value = Buffer.from(JSON.stringify({ userId: 9 })).toString('base64');
  const sig = new Keygrip([process.env.SESSION_SECRET]).sign(`rsess=${value}`);
  const res = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: s.address().port, path: '/api/me',
    headers: { cookie: `rsess=${value}; rsess.sig=${sig}` } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); }));
  assert.equal(res, 200);
});

test('forgot password: offered only once email is set up; the emailed link sets a new password once', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  addUser({ id: 10, username: 'dewi', full_name: 'Dewi', email: 'dewi@example.com', password_hash: bcrypt.hashSync('old-password', 4) });
  const s = http.createServer(app).listen(0, '127.0.0.1'); t.after(() => s.close());
  await new Promise(r => s.once('listening', r));
  const browser = device(s.address().port), laptop = device(s.address().port);

  delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
  assert.deepEqual((await browser('GET', '/api/auth-options')).body, { password_reset: false }, 'no mail provider, no link');
  process.env.RESEND_API_KEY = 're_test'; process.env.EMAIL_FROM = 'Portal <noreply@example.com>';
  t.after(() => { delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; });
  assert.deepEqual((await browser('GET', '/api/auth-options')).body, { password_reset: true });

  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; });
  const li = await laptop('POST', '/api/login', { username: 'dewi', password: 'old-password' });
  assert.equal(li.status, 200);

  // Unknown accounts get the same answer and no email.
  const nobody = await browser('POST', '/api/forgot-password', { identifier: 'nobody@example.com' });
  assert.equal(nobody.status, 200); assert.equal(sent.length, 0);

  const ask = await browser('POST', '/api/forgot-password', { identifier: 'DEWI@example.com' });
  assert.equal(ask.status, 200); assert.equal(ask.body.message, nobody.body.message, 'no account enumeration');
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['dewi@example.com']);
  const token = sent[0].html.match(/reset\.html\?token=([0-9a-f]{64})/)[1];

  assert.equal((await browser('POST', '/api/reset-password', { token, new_password: 'short' })).status, 400);
  assert.equal((await browser('POST', '/api/reset-password', { token, new_password: 'brand-new-password' })).status, 200);
  assert.equal((await browser('POST', '/api/reset-password', { token, new_password: 'another-password' })).status, 400, 'a link works once');
  assert.equal((await laptop('GET', '/api/me')).status, 401, 'existing sessions are signed out');
  assert.equal((await browser('POST', '/api/login', { username: 'dewi', password: 'old-password' })).status, 401);
  assert.equal((await browser('POST', '/api/login', { username: 'dewi', password: 'brand-new-password' })).status, 200);
});
