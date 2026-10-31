'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('./_app'); // isolate the app from production storage
const app = require('../app');
const vercel = require('../vercel.json');

test('local and CDN policies allow the large-receipt upload endpoint', async (t) => {
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const headers = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/api/auth-options`, res => {
      res.resume(); res.on('end', () => resolve(res.headers));
    }).on('error', reject);
  });
  const cdn = vercel.headers.find(h => h.source === '/(.*)').headers
    .find(h => h.key === 'Content-Security-Policy').value;
  assert.equal(headers['content-security-policy'], cdn, 'both serving paths enforce the same policy');
  const connect = cdn.split(';').map(s => s.trim()).find(s => s.startsWith('connect-src ')).split(/\s+/).slice(1);
  assert.deepEqual(connect, ["'self'", 'https://vercel.com/api/blob/'], 'permit the SDK upload path without opening other external destinations');
  assert.equal(headers['cache-control'], 'no-store', 'API responses remain uncacheable');
});
