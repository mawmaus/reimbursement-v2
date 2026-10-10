'use strict';

// The experience survey through the real app (see _app.js): only accounts
// created before the cutoff are asked, each answers once with three whole
// scores 1–10, and only a Super Admin reads the results.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

const OLD = 1, NEW = 2, ROOT = 3;
state.users.set(OLD, account({ id: OLD, created_at: new Date('2026-07-15T08:00:00Z') }));
state.users.set(NEW, account({ id: NEW, created_at: new Date('2026-08-20T08:00:00Z') }));
state.users.set(ROOT, account({ id: ROOT, role: 'superadmin', region: '*', created_at: new Date('2026-01-05T08:00:00Z') }));
const answers = { paper_score: 3, digital_score: 8, overall_score: 9 };

test('/api/me flags the survey only for accounts from before August', async (t) => {
  await serve(t);
  assert.equal((await call(OLD, 'GET', '/api/me')).json.user.survey_pending, true);
  assert.equal((await call(NEW, 'GET', '/api/me')).json.user.survey_pending, false);
});

test('answers must be three whole scores from 1 to 10', async (t) => {
  await serve(t);
  state.writes.length = 0;
  for (const body of [{}, { ...answers, paper_score: 0 }, { ...answers, digital_score: 11 }, { ...answers, overall_score: 7.5 }, { ...answers, paper_score: 'x' }]) {
    assert.equal((await call(OLD, 'POST', '/api/survey', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(state.writes, []);
});

test('a newer account cannot answer; an older one answers exactly once', async (t) => {
  await serve(t);
  assert.equal((await call(NEW, 'POST', '/api/survey', answers)).status, 409);
  assert.equal((await call(OLD, 'POST', '/api/survey', answers)).status, 200);
  assert.equal((await call(OLD, 'POST', '/api/survey', answers)).status, 409);
  assert.equal(state.tables.survey_responses.length, 1);
  assert.deepEqual({ ...state.tables.survey_responses[0], survey_key: undefined },
    { survey_key: undefined, user_id: OLD, region: 'Indonesia', department: 'Sales', ...answers });
  assert.equal((await call(OLD, 'GET', '/api/me')).json.user.survey_pending, false);
});

test('only a Super Admin reads the results', async (t) => {
  await serve(t);
  assert.equal((await call(OLD, 'GET', '/api/survey/results')).status, 403);
  assert.equal((await call(null, 'GET', '/api/survey/results')).status, 401);
  assert.equal((await call(ROOT, 'GET', '/api/survey/results')).status, 200);
});

test('the "who has answered" list names people but never shows their scores', async (t) => {
  await serve(t);
  const sql = state.reads.filter(s => /LEFT JOIN survey_responses/.test(s));
  const res = await call(ROOT, 'GET', '/api/survey/results');
  assert.ok(Array.isArray(res.json.people));
  const asked = state.reads.filter(s => /LEFT JOIN survey_responses/.test(s)).slice(sql.length);
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0], /_score/, 'the people query never selects a score');
});
