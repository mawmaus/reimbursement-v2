'use strict';

// "Skip guide" turns the automatic screen guides off for the account: the flag
// rides on the session payload (sign-in and /api/me) so every device sees it,
// and PUT /api/me { guides_off } stores only that flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

const ON = 90, OFF = 91;
state.users.set(ON, account({ id: ON }));
state.users.set(OFF, account({ id: OFF, guides_off: true }));

test('the session tells the client whether guides are off', async (t) => {
  await serve(t);
  const on = await call(ON, 'GET', '/api/me');
  assert.equal(on.status, 200, on.body);
  assert.equal(on.json.user.guides_off, false);
  const off = await call(OFF, 'GET', '/api/me');
  assert.equal(off.json.user.guides_off, true);
});

test('Skip guide stores only the flag, for the signed-in account', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const r = await call(ON, 'PUT', '/api/me', { guides_off: true });
  assert.equal(r.status, 200, r.body);
  const w = state.writes.filter(s => /^UPDATE users SET/.test(s));
  assert.equal(w.length, 1, JSON.stringify(state.writes));
  assert.match(w[0], /^UPDATE users SET guides_off = \$1 WHERE id = \$2$/, 'no bank, email or language fields touched');
});
