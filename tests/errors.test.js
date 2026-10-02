'use strict';

// The error handler, run inside a real Express app so body-parser's own errors
// (malformed JSON, oversized bodies) go through the same path as in production.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { httpError, errorHandler, GENERIC_MESSAGE } = require('../lib/errors');

function server() {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.get('/crash', () => { throw new Error('relation "claims" does not exist'); });
  app.get('/async-crash', (req, res, next) => Promise.reject(Object.assign(new Error('connection refused'), { status: 503 })).catch(next));
  app.get('/conflict', () => { throw httpError(409, 'Could not allocate a claim number — please try again'); });
  app.post('/echo', (req, res) => res.json(req.body));
  app.get('/streamed', (req, res, next) => { res.write('partial'); next(new Error('blob read failed')); });
  app.use(errorHandler);
  return new Promise(resolve => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
}
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: body ? { 'content-type': 'application/json' } : {} }, res => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('aborted', () => resolve({ status: res.statusCode, body: data, aborted: true }));
      res.on('error', () => resolve({ status: res.statusCode, body: data, aborted: true }));
    });
    req.on('error', (e) => resolve({ status: 'aborted', body: e.code }));
    if (body) req.write(body);
    req.end();
  });
}

test('error handler: internals stay in the log, users get a plain 500', async (t) => {
  const s = await server(); t.after(() => s.close());
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const { port } = s.address();

  const crash = await request(port, 'GET', '/crash');
  assert.equal(crash.status, 500);
  assert.deepEqual(JSON.parse(crash.body), { error: GENERIC_MESSAGE });
  assert.doesNotMatch(crash.body, /relation|claims/);
  assert.match(String(logged[0][0]), /GET \/crash/, 'logged with the request it came from');
  assert.match(String(logged[0][1]), /relation "claims" does not exist/, 'full error is logged');

  // A status on an error that isn't marked safe to expose doesn't leak its message.
  const unexposed = await request(port, 'GET', '/async-crash');
  assert.equal(unexposed.status, 500);
  assert.doesNotMatch(unexposed.body, /connection refused/);
});

test('error handler: deliberate 4xx errors keep their status and message', async (t) => {
  const s = await server(); t.after(() => s.close());
  t.mock.method(console, 'error', () => {});
  const { port } = s.address();

  const conflict = await request(port, 'GET', '/conflict');
  assert.equal(conflict.status, 409);
  assert.match(JSON.parse(conflict.body).error, /please try again/);

  const badJson = await request(port, 'POST', '/echo', '{not json');
  assert.equal(badJson.status, 400, 'malformed JSON stays a 400');

  const tooBig = await request(port, 'POST', '/echo', JSON.stringify({ x: 'y'.repeat(2048) }));
  assert.equal(tooBig.status, 413, 'an oversized body says so (was reported as a 400)');
  assert.match(JSON.parse(tooBig.body).error, /too large/i);

  const fine = await request(port, 'POST', '/echo', '{"a":1}');
  assert.deepEqual([fine.status, JSON.parse(fine.body)], [200, { a: 1 }]);
});

test('error handler: an error after the response started is handed to Express', async (t) => {
  const s = await server(); t.after(() => s.close());
  t.mock.method(console, 'error', () => {});
  const r = await request(s.address().port, 'GET', '/streamed');
  assert.equal(r.status, 200, 'the headers already sent stand; no second set is attempted');
  assert.equal(r.aborted, true, 'Express cuts the connection so the client sees an incomplete download');
  assert.doesNotMatch(r.body, /Something went wrong/);
});
