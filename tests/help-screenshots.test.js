'use strict';

// Screenshots on helpdesk messages: only our own blobs, only images, at most
// four per message, and only the ticket's owner and the helpdesk can open one.
const test = require('node:test');
const assert = require('node:assert/strict');

// Storage reads are faked: lib/uploads takes statReceipt from lib/blob when it
// loads, so the stand-in goes in first. A URL ending ".pdf" is a PDF.
const blob = require('../lib/blob');
blob.statReceipt = async (url) => ({ size: 1200, pathname: url.split('/').pop(),
  contentType: url.endsWith('.pdf') ? 'application/pdf' : 'image/png' });
const { state, account, serve, call } = require('./_app');

const ANA = 1, BEN = 2, ROOT = 3;
state.users.set(ANA, account({ id: ANA }));
state.users.set(BEN, account({ id: BEN }));
state.users.set(ROOT, account({ id: ROOT, role: 'superadmin', region: '*' }));
const shot = (name) => ({ url: `https://abc123.public.blob.vercel-storage.com/receipts/${name}`, original_name: name });
const ticket = { category: 'bug', subject: 'Upload stuck', message: 'See the screenshot' };

test('screenshots must be our own images, at most four', async (t) => {
  await serve(t);
  state.writes.length = 0;
  for (const attachments of ['x', [{ url: 'https://evil.example/a.png' }], [shot('a.pdf')],
    [shot('1.png'), shot('2.png'), shot('3.png'), shot('4.png'), shot('5.png')]]) {
    assert.equal((await call(ANA, 'POST', '/api/help/tickets', { ...ticket, attachments })).status, 400, JSON.stringify(attachments).slice(0, 60));
  }
  assert.deepEqual(state.writes, []);
});

test('a ticket and a reply carry their screenshots; a reply may be only screenshots', async (t) => {
  await serve(t);
  const r = await call(ANA, 'POST', '/api/help/tickets', { ...ticket, attachments: [shot('one.png'), shot('two.png')] });
  assert.equal(r.status, 200);
  assert.equal(state.tables.helpdesk_attachments.length, 2);
  assert.equal((await call(ANA, 'POST', `/api/help/tickets/${r.json.id}/messages`, { message: '  ' })).status, 400);
  assert.equal((await call(ROOT, 'POST', `/api/help/tickets/${r.json.id}/messages`, { attachments: [shot('fix.png')] })).status, 200);
  const view = (await call(ANA, 'GET', `/api/help/tickets/${r.json.id}`)).json;
  assert.deepEqual(view.messages.map(m => m.attachments.map(a => a.original_name)), [['one.png', 'two.png'], ['fix.png']]);
  assert.equal(view.messages[1].body, '');
  assert.equal(state.tables.helpdesk_attachments[0].mime_type, 'image/png');
});

test('only the owner and the helpdesk open a screenshot', async (t) => {
  await serve(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('PNGDATA', { headers: { 'content-length': '7' } }));
  const id = state.tables.helpdesk_attachments[0].id;
  assert.equal((await call(BEN, 'GET', `/api/help/attachments/${id}`)).status, 404);
  assert.equal((await call(null, 'GET', `/api/help/attachments/${id}`)).status, 401);
  assert.equal((await call(ANA, 'GET', '/api/help/attachments/999')).status, 404);
  for (const who of [ANA, ROOT]) {
    const r = await call(who, 'GET', `/api/help/attachments/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'PNGDATA');
  }
});
