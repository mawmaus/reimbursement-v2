'use strict';

// Helpdesk tickets and feedback through the real app (see _app.js): an account
// sees only its own tickets and named feedback, the Super Admins answer
// everyone's, and anonymous feedback keeps no trace of who sent it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, serve, call } = require('./_app');

const ANA = 1, BEN = 2, ROOT = 3;
state.users.set(ANA, account({ id: ANA }));
state.users.set(BEN, account({ id: BEN, department: 'Finance' }));
state.users.set(ROOT, account({ id: ROOT, role: 'superadmin', region: '*' }));
const ticket = { category: 'claim', subject: 'Claim stuck', message: 'RC-2026-1 will not resubmit' };

test('a ticket needs a known category, a subject and a message', async (t) => {
  await serve(t);
  state.writes.length = 0;
  for (const body of [{}, { ...ticket, category: 'pizza' }, { ...ticket, subject: '  ' }, { ...ticket, message: '' },
    { ...ticket, subject: 'x'.repeat(121) }, { ...ticket, message: 'x'.repeat(4001) }]) {
    assert.equal((await call(ANA, 'POST', '/api/help/tickets', body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.deepEqual(state.writes, []);
  assert.equal((await call(null, 'POST', '/api/help/tickets', ticket)).status, 401);
});

test('only the owner and the helpdesk see a ticket', async (t) => {
  await serve(t);
  const r = await call(ANA, 'POST', '/api/help/tickets', ticket);
  assert.equal(r.status, 200);
  const id = r.json.id;
  assert.equal(state.tables.helpdesk_tickets[0].department, 'Sales');
  assert.equal((await call(ANA, 'GET', `/api/help/tickets/${id}`)).status, 200);
  assert.equal((await call(ROOT, 'GET', `/api/help/tickets/${id}`)).status, 200);
  state.writes.length = 0;
  assert.equal((await call(BEN, 'GET', `/api/help/tickets/${id}`)).status, 404);
  assert.equal((await call(BEN, 'POST', `/api/help/tickets/${id}/messages`, { message: 'me too' })).status, 404);
  assert.equal((await call(BEN, 'POST', `/api/help/tickets/${id}/status`, { status: 'closed' })).status, 404);
  assert.deepEqual(state.writes, []);
  assert.equal((await call(BEN, 'GET', '/api/help/tickets')).json.tickets.length, 0);
  assert.equal((await call(ANA, 'GET', '/api/help/tickets')).json.tickets.length, 1);
  assert.equal((await call(ROOT, 'GET', '/api/help/tickets')).json.staff, true);
});

test('a helpdesk answer lights the owner’s badge until they open it; their reply re-queues it', async (t) => {
  await serve(t);
  const id = state.tables.helpdesk_tickets[0].id;
  assert.equal((await call(ROOT, 'GET', '/api/help/summary')).json.tickets, 1); // waiting for an answer
  assert.equal((await call(ROOT, 'POST', `/api/help/tickets/${id}/messages`, { message: 'Re-date it and resubmit' })).status, 200);
  assert.equal(state.tables.helpdesk_tickets[0].status, 'answered');
  assert.equal(state.tables.helpdesk_messages.at(-1).from_staff, true);
  assert.equal((await call(ANA, 'GET', '/api/help/summary')).json.tickets, 1);
  assert.equal((await call(ROOT, 'GET', '/api/help/summary')).json.tickets, 0);
  await call(ANA, 'GET', `/api/help/tickets/${id}`);
  assert.equal((await call(ANA, 'GET', '/api/help/summary')).json.tickets, 0);
  assert.equal((await call(ANA, 'POST', `/api/help/tickets/${id}/messages`, { message: 'Thanks, done' })).status, 200);
  assert.equal(state.tables.helpdesk_tickets[0].status, 'open');
  assert.equal(state.tables.helpdesk_messages.at(-1).from_staff, false);
});

test('close and reopen', async (t) => {
  await serve(t);
  const id = state.tables.helpdesk_tickets[0].id;
  assert.equal((await call(ANA, 'POST', `/api/help/tickets/${id}/status`, { status: 'answered' })).status, 400);
  assert.equal((await call(ANA, 'POST', `/api/help/tickets/${id}/status`, { status: 'open' })).status, 409);
  assert.equal((await call(ANA, 'POST', `/api/help/tickets/${id}/status`, { status: 'closed' })).status, 200);
  assert.equal((await call(ROOT, 'POST', `/api/help/tickets/${id}/status`, { status: 'closed' })).status, 409);
  assert.equal((await call(ROOT, 'POST', `/api/help/tickets/${id}/status`, { status: 'open' })).status, 200);
  assert.equal(state.tables.helpdesk_tickets[0].status, 'open');
});

test('feedback: validated, anonymous keeps no account, only the helpdesk reviews', async (t) => {
  await serve(t);
  state.writes.length = 0;
  for (const body of [{}, { kind: 'praise', body: 'x' }, { kind: 'suggestion', body: ' ' }]) {
    assert.equal((await call(ANA, 'POST', '/api/help/feedback', body)).status, 400);
  }
  assert.deepEqual(state.writes, []);
  assert.equal((await call(ANA, 'POST', '/api/help/feedback', { kind: 'suggestion', topic: 'portal', body: 'Dark mode please' })).status, 200);
  assert.equal((await call(ANA, 'POST', '/api/help/feedback', { kind: 'criticism', topic: 'nope', body: 'Too slow', anonymous: true })).status, 200);
  const [named, anon] = state.tables.feedback;
  assert.equal(named.user_id, ANA);
  assert.equal(named.department, 'Sales');
  assert.deepEqual([anon.user_id, anon.anonymous, anon.department, anon.region, anon.topic], [null, true, '', 'Indonesia', 'other']);
  // The sender sees only their named feedback; the helpdesk sees both, without a name on the anonymous one.
  assert.deepEqual((await call(ANA, 'GET', '/api/help/feedback')).json.feedback.map(f => f.id), [named.id]);
  const all = (await call(ROOT, 'GET', '/api/help/feedback')).json.feedback;
  assert.equal(all.length, 2);
  assert.equal(all.find(f => f.anonymous).sender_name, '');
  assert.equal((await call(ROOT, 'GET', '/api/help/summary')).json.feedback, 2);
  state.writes.length = 0;
  assert.equal((await call(ANA, 'POST', `/api/help/feedback/${named.id}/review`, {})).status, 403);
  assert.deepEqual(state.writes, []);
  assert.equal((await call(ROOT, 'POST', `/api/help/feedback/${anon.id}/review`, {})).status, 200);
  assert.equal((await call(ROOT, 'POST', `/api/help/feedback/${named.id}/review`, { response: 'Coming soon' })).status, 200);
  assert.deepEqual([named.status, named.response, anon.status, anon.response], ['read', 'Coming soon', 'read', '']);
  assert.equal((await call(ROOT, 'POST', '/api/help/feedback/999/review', {})).status, 404);
});
