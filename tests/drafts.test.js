'use strict';

// Saved drafts through the real app (see _app.js): each account sees and
// changes only its own, a late save never rolls a draft back, receipts that
// leave a draft are deleted from storage unless a submitted document links
// them, and a draft's files open only for their owner.
const test = require('node:test');
const assert = require('node:assert/strict');

// Storage is faked: lib/uploads takes statReceipt from lib/blob when it loads,
// so the stand-ins go in first. A URL ending ".pdf" is a PDF, ".html" is HTML.
const blob = require('../lib/blob');
blob.statReceipt = async (url) => ({ size: 1200, pathname: url.split('/').pop(),
  contentType: url.endsWith('.pdf') ? 'application/pdf' : url.endsWith('.html') ? 'text/html' : 'image/jpeg' });
const deleted = [];
blob.deleteReceipt = async (url) => { deleted.push(url); };
const served = [];
blob.sendReceipt = async (res, att) => { served.push(att); res.json({ served: att.blob_url }); };
const { state, account, serve, call } = require('./_app');

const ANA = 1, BEN = 2;
state.users.set(ANA, account({ id: ANA }));
state.users.set(BEN, account({ id: BEN }));
const file = (name) => ({ url: `https://abc123.private.blob.vercel-storage.com/receipts/${name}`, original_name: name });
const put = (uid, kind, data, saved_at) => call(uid, 'PUT', `/api/drafts/${kind}`, { data, saved_at });

test('a draft is saved per account and form type, with its receipts checked', async (t) => {
  await serve(t);
  const r = await put(ANA, 'claim', { rows: [{ amount: '50000' }], files: [[file('a.jpg'), file('b.pdf')]] }, 1000);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.files[0].map(f => [f.original_name, f.mime]), [['a.jpg', 'image/jpeg'], ['b.pdf', 'application/pdf']]);
  const mine = (await call(ANA, 'GET', '/api/drafts')).json;
  assert.equal(mine.available, true);
  assert.deepEqual(mine.drafts.map(d => [d.kind, d.saved_at, d.data.rows[0].amount]), [['claim', 1000, '50000']]);
  assert.deepEqual((await call(BEN, 'GET', '/api/drafts')).json.drafts, []);
  assert.equal((await call(null, 'GET', '/api/drafts')).status, 401);
});

test('bad input is refused and writes nothing', async (t) => {
  await serve(t);
  state.writes.length = 0;
  assert.equal((await put(ANA, 'nope', { rows: [] }, 1)).status, 404);
  assert.equal((await put(ANA, 'meal', [], 1)).status, 400);
  assert.equal((await put(ANA, 'meal', { rows: [] }, 'x')).status, 400);
  assert.equal((await put(ANA, 'meal', { files: [[{ url: 'https://evil.example/a.jpg' }]] }, 5)).status, 400);
  assert.equal((await put(ANA, 'meal', { files: [[file('page.html')]] }, 5)).status, 400);
  assert.equal((await put(ANA, 'meal', { files: [Array.from({ length: 9 }, (_, i) => file(i + '.jpg'))] }, 5)).status, 400);
  assert.equal((await put(ANA, 'meal', { note: 'x'.repeat(250000) }, 5)).status, 413);
  // A file a submitted document links is not a draft's to take.
  state.tables.attachments.push({ blob_url: file('submitted.jpg').url });
  assert.equal((await put(ANA, 'meal', { files: [[file('submitted.jpg')]] }, 5)).status, 400);
  assert.deepEqual(state.writes, []);
});

test('an older save never replaces a newer one, and its own uploads are dropped', async (t) => {
  await serve(t);
  deleted.length = 0;
  assert.equal((await put(ANA, 'advance', { purpose: 'new', files: [[file('keep.pdf')]] }, 2000)).status, 200);
  const late = await put(ANA, 'advance', { purpose: 'old', files: [[file('keep.pdf'), file('late.pdf')]] }, 1500);
  assert.equal(late.status, 409);
  const d = state.tables.claim_drafts.find(x => x.user_id === ANA && x.kind === 'advance');
  assert.equal(d.data.purpose, 'new');
  assert.deepEqual(deleted, [file('late.pdf').url]);
});

test('receipts that leave a draft are deleted, unless a document links them', async (t) => {
  await serve(t);
  deleted.length = 0;
  await put(ANA, 'mealgps', { rows: [{}, {}], files: [[file('one.jpg')], [file('two.jpg'), file('three.jpg')]] }, 3000);
  assert.equal((await put(ANA, 'mealgps', { rows: [{}], files: [[file('two.jpg')]] }, 3100)).status, 200);
  assert.deepEqual(deleted.sort(), [file('one.jpg').url, file('three.jpg').url].sort());
  // Submitted (the document now links two.jpg), then the draft is cleared.
  deleted.length = 0;
  state.tables.attachments.push({ blob_url: file('two.jpg').url });
  assert.equal((await call(ANA, 'DELETE', '/api/drafts/mealgps')).status, 200);
  assert.deepEqual(deleted, []);
  assert.equal(state.tables.claim_drafts.some(x => x.user_id === ANA && x.kind === 'mealgps'), false);
  assert.equal((await call(ANA, 'DELETE', '/api/drafts/mealgps')).status, 200); // already gone: fine
});

test("a draft's receipt opens for its owner only", async (t) => {
  await serve(t);
  await put(BEN, 'claim', { rows: [{}, {}], files: [[], [file('x.jpg'), file('y.pdf')]] }, 4000);
  const r = await call(BEN, 'GET', '/api/drafts/claim/files/1/1');
  assert.equal(r.status, 200);
  assert.deepEqual(served.at(-1), { blob_url: file('y.pdf').url, mime_type: 'application/pdf', original_name: 'y.pdf' });
  assert.equal((await call(BEN, 'GET', '/api/drafts/claim/files/0/0')).status, 404);
  assert.equal((await call(ANA, 'GET', '/api/drafts/claim/files/1/1')).status, 404); // ANA's own claim draft has no row 1 file
  assert.equal((await call(ANA, 'GET', '/api/drafts/meal/files/1/1')).status, 404);
});
