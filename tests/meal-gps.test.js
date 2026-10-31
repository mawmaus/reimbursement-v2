'use strict';

// GPS meal allowance (lib/meal-gps.js): the distance (base → customer site) and cap rules, reading
// pasted base coordinates, and who may change a line's approved amount —
// the last through the real app over the in-memory stand-in (_app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, account, doc, serve, call } = require('./_app');
const { normaliseGpsLines, parseCoords, distanceMeters, parseBaseInput, RULES } = require('../lib/meal-gps');

// Jakarta (Monas) as the base; Bogor is ~43 km south, Kemang ~8 km.
const BASE = { name: 'Jakarta office', lat: -6.1754, lng: 106.8272 };
const BOGOR = { lat: -6.5971, lng: 106.8060 };
const KEMANG = { lat: -6.2607, lng: 106.8137 };
// Customer sites: Bogor pinned as DB500222, Kemang as DB500333, and a customer
// in Bogor with no DB number (picked by id).
const SITES = [
  { id: 1, db_no: '500222', name: 'PT Bogor', alias: '', ...BOGOR },
  { id: 2, db_no: '500333', name: 'PT Kemang', alias: '', ...KEMANG },
  { id: 3, db_no: '', name: 'Toko Sumber', alias: 'Pak Dhiraj', ...BOGOR }
];
const receipt = [{ url: 'https://x.private.blob.vercel-storage.com/r.jpg', original_name: 'r.jpg' }];
const line = (props) => ({ date: '2026-11-04', trip_type: 'in_town', amount: 30000, site: 'DB 500222', attachments: receipt, ...props });
const run = (lines) => normaliseGpsLines(lines, BASE, 'IDR', { sites: SITES });

test('distance is the straight line from the base', () => {
  const km = distanceMeters(BASE, BOGOR) / 1000;
  assert.ok(km > 40 && km < 50, `Bogor ${km} km`);
  assert.ok(distanceMeters(BASE, KEMANG) / 1000 < RULES.minKm);
});

test('in town under 30 km is refused; 30 km or more is capped at 35,000 a day', () => {
  assert.match(run([line({ site: 'DB 500333' })]).error, /customer site is .* RADIUS \(straight line, not road distance\).*within 30 km can't be claimed/);
  const ok = run([line({ amount: 35000 })]);
  assert.equal(ok.error, undefined);
  assert.equal(ok.totalCents, 3500000);
  assert.ok(ok.lines[0].distance_m > 40000);
  assert.equal(ok.lines[0].site_id, 1);
  assert.match(run([line({ amount: 35001 })]).error, /capped at IDR 35,000 a day/);
});

test('out of town: up to three meals, 120,000 a day in total, at any distance', () => {
  const ok = run([line({ trip_type: 'out_of_town', site: 'DB 500333', meals: [30000, 40000, 50000] })]);
  assert.equal(ok.error, undefined);
  assert.equal(ok.totalCents, 12000000);
  assert.deepEqual(JSON.parse(ok.lines[0].meals), [3000000, 4000000, 5000000]);
  assert.match(run([line({ trip_type: 'out_of_town', meals: [50000, 50000, 20001] })]).error, /capped at IDR 120,000/);
  assert.match(run([line({ trip_type: 'out_of_town', meals: [1, 1, 1, 1] })]).error, /at most 3 meals/);
});

test('a day is measured to its DB number’s pin, or the customer picked when there is no DB', () => {
  const picked = run([line({ site: '', site_id: 3 })]);
  assert.equal(picked.error, undefined);
  assert.equal(picked.lines[0].site_id, 3);
  assert.equal(picked.lines[0].site_name, 'Pak Dhiraj');
  assert.match(run([line({ site: 'DB 599999' })]).error, /DB599999 isn't registered .* ask your manager/);
  assert.match(run([line({ site: '' })]).error, /choose the customer .* ask your manager/);
  assert.match(run([line({ site: '', site_id: 99 })]).error, /choose the customer/);
  // A DB number wins over a stale pick.
  assert.match(run([line({ site: 'DB 500333', site_id: 1 })]).error, /within 30 km/);
});

test('every day needs its date on or after 1 Nov 2026, a site, a receipt and is claimed once', () => {
  assert.match(run([line({ date: '2026-10-31' })]).error, /starts on 2026-11-01/);
  assert.match(run([line({ attachments: [] })]).error, /attach the meal receipt/);
  assert.match(run([line(), line()]).error, /one line per day/);
  assert.match(normaliseGpsLines([line()], null, 'IDR').error, /no base location/);
  assert.equal(run([line({ attachments: [], keep_attachment_ids: [7] })]).error, undefined);
});

test('base coordinates are read from plain pairs and Google Maps links', () => {
  assert.deepEqual(parseCoords('-6.2088, 106.8456'), { lat: -6.2088, lng: 106.8456 });
  assert.deepEqual(parseCoords('https://www.google.com/maps/place/X/@-6.1754,106.8272,17z/data=!3d-6.17544!4d106.82715'), { lat: -6.17544, lng: 106.82715 });
  assert.deepEqual(parseCoords('https://maps.google.com/?q=-6.59,106.80'), { lat: -6.59, lng: 106.8 });
  assert.equal(parseCoords('Jakarta'), null);
  assert.equal(parseCoords('95, 200'), null);
  assert.deepEqual(parseBaseInput('', ''), { base: null });
  assert.match(parseBaseInput('Office', 'nowhere').error, /paste coordinates/);
  assert.match(parseBaseInput('', '-6.2, 106.8').error, /name/);
});

// --- Approved amount: who may change it -------------------------------------------
const CLAIMANT = 10, MANAGER = 21, FINANCE = 22, PAYER = 40;
for (const u of [
  account({ id: CLAIMANT }),
  account({ id: MANAGER, position: 'Manager' }),
  account({ id: FINANCE, department: 'Finance', position: 'Finance AP' }),
  account({ id: PAYER, role: 'finance', department: 'Finance', can_mark_paid: true })
]) state.users.set(u.id, u);
const chain = { employee_id: CLAIMANT, approver_ids: [MANAGER, FINANCE], scheme: 'gps' };
state.tables.meal_claims.push(
  doc({ id: 500, ...chain, status: 'submitted', current_step: 1 }),
  doc({ id: 501, ...chain, status: 'approved', current_step: 2, manager_id: FINANCE }),
  doc({ id: 502, ...chain, status: 'paid', current_step: 2 }),
  doc({ id: 503, ...chain, scheme: 'standard', status: 'submitted', current_step: 1 })
);
for (const id of [500, 501, 502, 503]) {
  state.tables.meal_claim_lines.push({ id: id * 10, meal_claim_id: id, line_date: '2026-11-04', amount_cents: 3500000, sort_order: 0 });
}
const adjust = (who, id, amount) => call(who, 'PUT', `/api/meal-claims/${id}/lines/${id * 10}/approved`, { amount, note: 'receipt shows 20,000' });

test('the approver holding the claim may lower a line, others may not', async (t) => {
  await serve(t);
  assert.equal((await adjust(MANAGER, 500, 20000)).status, 200);
  assert.equal((await adjust(FINANCE, 500, 20000)).status, 403, 'not Finance AP’s step yet');
  assert.equal((await adjust(CLAIMANT, 500, 20000)).status, 403);
  const over = await adjust(MANAGER, 500, 40000);
  assert.equal(over.status, 400);
  assert.match(over.json.error, /can't be more than the IDR 35,000 claimed/);
});

test('once approved, whoever records payment may lower it; never after payment', async (t) => {
  await serve(t);
  assert.equal((await adjust(PAYER, 501, 20000)).status, 200);
  assert.equal((await adjust(MANAGER, 501, 20000)).status, 403);
  assert.equal((await adjust(PAYER, 502, 20000)).status, 403);
  assert.equal((await adjust(MANAGER, 503, 20000)).status, 400, 'standard meal claims have no approved amount');
});

test('a GPS claim cannot be raised where the form is switched off', async (t) => {
  await serve(t);
  const r = await call(CLAIMANT, 'POST', '/api/meal-claims', { scheme: 'gps', lines: [] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /not switched on/);
});

test('managers and above may register customer sites; staff may not', () => {
  const { mayEditCustomerSites } = require('../lib/permissions');
  const pos = new Map([['general manager', 5], ['manager', 7], ['supervisor', 10], ['staff', 13]]
    .map(([name, rank]) => [name, { name, rank, can_manage: true }]));
  const who = (position, extra = {}) => ({ id: 77, role: 'user', position, caps: {}, ...extra });
  assert.equal(mayEditCustomerSites(who('Manager'), {}, pos), true);
  assert.equal(mayEditCustomerSites(who('General Manager'), {}, pos), true);
  assert.equal(mayEditCustomerSites(who('Supervisor'), {}, pos), false);
  assert.equal(mayEditCustomerSites(who('Staff'), { customer_site_editors: '[77]' }, pos), true, 'a named editor');
  assert.equal(mayEditCustomerSites(who('Staff', { caps: { manage_settings: true } }), {}, pos), true);
});
