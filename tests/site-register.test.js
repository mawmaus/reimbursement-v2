'use strict';

// Customer sites a technician registers from the GPS meal form (routes/customer-sites.js):
// they are pending until a site editor or the claim's approver checks the pin,
// a GPS claim that names one can't be approved before that, and moving the pin
// re-measures the open claims on it. Through the real app over the in-memory stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');

const TECH = 10, OTHER_TECH = 11, MANAGER = 12, STAFF = 13, EDITOR = 20;
for (const u of [
  account({ id: TECH, department: 'Service', position: 'Technician' }),
  account({ id: OTHER_TECH, department: 'Service', position: 'Technician' }),
  account({ id: MANAGER, department: 'Service', position: 'Supervisor' }),
  account({ id: STAFF }), // Sales / Staff: no meal allowance
  account({ id: EDITOR })
]) state.users.set(u.id, u);
state.tables.departments.push({ name: 'Service', region: 'Indonesia', allow_claim: true, allow_meal: true });
state.tables.job_positions.push({ name: 'Technician', region: 'Indonesia', allow_claim: true, allow_meal: true });
state.settings.meal_gps_by_region = JSON.stringify({ Indonesia: { enabled: true } });
state.settings.customer_site_editors = JSON.stringify([EDITOR]);
state.tables.customer_sites.push({ id: 5, region: 'Indonesia', db_no: '500222', name: 'PT Sumber Selaras', alias: '', address: '',
  lat: -6.1923, lng: 106.8352, status: 'verified' });

const BOGOR = '-6.5971, 106.8060';
const register = (who, body) => call(who, 'POST', '/api/customer-sites/register', { name: 'Toko Baru', coords: BOGOR, ...body });

test('a technician registers an unlisted site: pending, in their own region, in their name', async (t) => {
  await serve(t);
  const r = await register(TECH, { db_no: 'DB 600111', address: 'Jl. Pajajaran' });
  assert.equal(r.status, 201);
  assert.equal(r.json.site.status, 'pending');
  assert.equal(r.json.site.region, 'Indonesia');
  assert.equal(r.json.site.db_no, '600111');
  assert.equal(r.json.site.proposed_by, TECH);
  assert.deepEqual([r.json.site.lat, r.json.site.lng], [-6.5971, 106.806]);
});

test('a DB number that is already pinned answers with that site instead of a copy', async (t) => {
  await serve(t);
  state.writes.length = 0;
  const r = await register(TECH, { db_no: 'DB500222' });
  assert.equal(r.status, 200);
  assert.equal(r.json.existing, true);
  assert.equal(r.json.site.id, 5);
  assert.deepEqual(state.writes, []);
});

test('registering needs the GPS meal allowance, a name and a readable pin', async (t) => {
  await serve(t);
  state.writes.length = 0;
  assert.equal((await register(STAFF, {})).status, 403);
  const noName = await register(TECH, { name: '', db_no: '' });
  assert.equal(noName.status, 400);
  const noPin = await register(TECH, { coords: 'near the mall' });
  assert.equal(noPin.status, 400);
  assert.match(noPin.json.error, /paste coordinates/);
  assert.deepEqual(state.writes, []);
});

test('a site editor’s registration is verified at once', async (t) => {
  await serve(t);
  const r = await register(EDITOR, { db_no: 'DB600222' });
  assert.equal(r.status, 201);
  assert.equal(r.json.site.status, 'verified');
});

// A submitted GPS claim of TECH's, one day measured to a pending site.
state.tables.customer_sites.push({ id: 50, region: 'Indonesia', db_no: '700100', name: 'Toko Hotel', alias: '', address: '',
  lat: -6.6, lng: 106.8, status: 'pending', proposed_by: TECH, proposed_by_name: 'User 10' });
state.tables.meal_claims.push(doc({ id: 900, employee_id: TECH, approver_ids: [MANAGER], scheme: 'gps', status: 'submitted', current_step: 1 }));
state.tables.meal_claim_lines.push(
  { id: 9001, meal_claim_id: 900, line_date: '2026-11-04', amount_cents: 3500000, sort_order: 0, site_id: 50,
    base_lat: -6.1754, base_lng: 106.8272, distance_m: 47000 },
  { id: 9002, meal_claim_id: 900, line_date: '2026-11-05', amount_cents: 3500000, sort_order: 1, site_id: 5,
    base_lat: -6.1754, base_lng: 106.8272, distance_m: 2000 });

test('a claim naming an unchecked pin can’t be approved — unless that day is rejected', async (t) => {
  await serve(t);
  const r = await call(MANAGER, 'POST', '/api/meal-claims/900/approve', {});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'site_pending');
  assert.match(r.json.error, /DB700100/);
  const detail = await call(MANAGER, 'GET', '/api/meal-claims/900');
  assert.equal(detail.json.claim.can_verify_sites, true, 'the approver may check the pin');
  const mine = await call(TECH, 'GET', '/api/meal-claims/900');
  assert.equal(mine.json.claim.can_verify_sites, false);
});

test('only a reviewer verifies; the registrant may still move their own pending pin', async (t) => {
  await serve(t);
  state.writes.length = 0;
  assert.equal((await call(TECH, 'POST', '/api/customer-sites/50/verify')).status, 403);
  assert.equal((await call(OTHER_TECH, 'PUT', '/api/customer-sites/50', { db_no: 'DB700100', name: 'Toko Hotel', coords: '-6.61, 106.81' })).status, 403);
  const moved = await call(TECH, 'PUT', '/api/customer-sites/50', { db_no: 'DB700100', name: 'Toko Hotel', coords: '-6.61, 106.81' });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.site.status, 'pending', 'moving their own pin doesn’t verify it');
  const line = state.tables.meal_claim_lines.find(l => l.id === 9001);
  assert.equal(line.site_lat, -6.61);
  assert.ok(Math.abs(line.distance_m - 48900) < 1500, `re-measured to ${line.distance_m} m`);
  assert.ok(state.writes.some(w => w.startsWith('INSERT INTO meal_claim_history')), 'the claim’s history notes the move');
});

test('the approver verifies the pin, and the claim can then be approved', async (t) => {
  await serve(t);
  const v = await call(MANAGER, 'POST', '/api/customer-sites/50/verify');
  assert.equal(v.status, 200);
  assert.equal(v.json.site.status, 'verified');
  assert.equal(state.tables.customer_sites.find(s => s.id === 50).verified_by_name, 'User 12');
  assert.equal((await call(MANAGER, 'POST', '/api/meal-claims/900/approve', {})).status, 200);
});

test('an editor’s save of a pending site verifies it; the registrant can’t touch it once verified', async (t) => {
  await serve(t);
  state.tables.customer_sites.push({ id: 51, region: 'Indonesia', db_no: '', name: 'Warung Pak Budi', alias: '', address: '',
    lat: -6.7, lng: 106.9, status: 'pending', proposed_by: TECH, proposed_by_name: 'User 10' });
  const r = await call(EDITOR, 'PUT', '/api/customer-sites/51', { name: 'Warung Pak Budi', coords: '-6.71, 106.91' });
  assert.equal(r.status, 200);
  assert.equal(r.json.site.status, 'verified');
  assert.equal((await call(TECH, 'PUT', '/api/customer-sites/51', { name: 'Warung', coords: '-6.7, 106.9' })).status, 403);
});
