'use strict';

// Ending other sessions on a password change: a session cookie is only honoured
// while the account's session_version matches the one it was issued under.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./_rules');

test('a cookie from before session versions existed stays valid until the first password change', () => {
  assert.equal(R.sessionCurrent({ userId: 7 }, { session_version: 0 }), true, 'nobody is signed out by the deploy');
  assert.equal(R.sessionCurrent({ userId: 7 }, { session_version: 1 }), false);
});

test('a password change (version bump) ends sessions issued under the old version', () => {
  assert.equal(R.sessionCurrent({ userId: 7, sv: 2 }, { session_version: 2 }), true);
  assert.equal(R.sessionCurrent({ userId: 7, sv: 2 }, { session_version: 3 }), false);
  assert.equal(R.sessionCurrent({ userId: 7, sv: 3 }, { session_version: 2 }), false, 'a forged newer version is no better');
  assert.equal(R.sessionCurrent(null, { session_version: 0 }), true, 'no cookie data reads as version 0 (loadUser has already required a user id)');
});

test('startSession stamps the cookie with the account and its current version', () => {
  const req = { session: {} };
  R.startSession(req, { id: 42, session_version: 5 });
  assert.deepEqual(req.session, { userId: 42, sv: 5 });
  R.startSession(req, { id: 42, session_version: null });
  assert.equal(req.session.sv, 0);
});
