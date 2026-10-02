'use strict';

// The claim-date window: rolling N days and/or an absolute cutoff (the later
// wins), per region, judged in the region's own time zone; a resubmitted claim
// keeps the window it was first submitted into.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./_rules');

const cw = (days, earliest, timezone = 'Asia/Jakarta') =>
  ({ claim_max_age_days: days, claim_earliest_date: earliest, timezone });

test('subDaysISO is plain calendar arithmetic, across months and leap days', () => {
  assert.equal(R.subDaysISO('2026-10-02', 30), '2026-09-02');
  assert.equal(R.subDaysISO('2028-03-01', 1), '2028-02-29');
  assert.equal(R.subDaysISO('2026-01-05', 10), '2025-12-26');
});

test('dateInZone gives the local calendar date, not the UTC one', () => {
  const lateEveningUtc = '2026-08-31T18:00:00Z'; // already 1 September in Jakarta and Manila
  assert.equal(R.dateInZone('Asia/Jakarta', lateEveningUtc), '2026-09-01');
  assert.equal(R.dateInZone('Asia/Manila', lateEveningUtc), '2026-09-01');
  assert.equal(R.dateInZone('UTC', lateEveningUtc), '2026-08-31');
});

test('claimEarliestFrom: rolling window, absolute cutoff, and the later of the two', () => {
  const asOf = '2026-10-02';
  assert.equal(R.claimEarliestFrom(cw(30, null), asOf), '2026-09-02');
  assert.equal(R.claimEarliestFrom(cw(null, '2026-09-15'), asOf), '2026-09-15');
  assert.equal(R.claimEarliestFrom(cw(30, '2026-09-15'), asOf), '2026-09-15', 'cutoff is later than the rolling floor');
  assert.equal(R.claimEarliestFrom(cw(30, '2026-08-01'), asOf), '2026-09-02', 'rolling floor is later than the cutoff');
  assert.equal(R.claimEarliestFrom(cw('30', null), asOf), '2026-09-02', 'settings are stored as text');
});

test('claimEarliestFrom: no usable setting means no floor', () => {
  for (const days of [null, '', '0', 0, -5, 'abc']) {
    assert.equal(R.claimEarliestFrom(cw(days, null), '2026-10-02'), null, `days=${JSON.stringify(days)}`);
  }
  assert.equal(R.claimEarliestFrom(cw(null, '15/09/2026'), '2026-10-02'), null, 'a malformed cutoff is ignored');
});

test('claimEarliestFrom defaults to today in the policy time zone', () => {
  const today = R.todayInZone('Asia/Jakarta');
  assert.equal(R.claimEarliestFrom(cw(7, null)), R.subDaysISO(today, 7));
});

test('resubmitEarliest: a returned claim keeps the window it first went into', () => {
  const policy = cw(30, null);
  const today = R.todayInZone('Asia/Jakarta');
  const nowFloor = R.subDaysISO(today, 30);
  // First submitted 60 days ago: its floor then was 90 days back, earlier than today's.
  const firstAt = new Date(Date.now() - 60 * 864e5).toISOString();
  const thenFloor = R.subDaysISO(R.dateInZone('Asia/Jakarta', firstAt), 30);
  assert.ok(thenFloor < nowFloor);
  assert.equal(R.resubmitEarliest(policy, firstAt), thenFloor);
  // A fresh submit faces today's window.
  assert.equal(R.resubmitEarliest(policy, null), nowFloor);
  // An absolute cutoff alone is the same then and now.
  assert.equal(R.resubmitEarliest(cw(null, '2026-09-15'), firstAt), '2026-09-15');
  // No policy, no floor.
  assert.equal(R.resubmitEarliest(cw(null, null), firstAt), null);
});

test('resubmitEarliest reads the first-submission date in the region time zone', () => {
  // 18:00 UTC on 31 Aug is already 1 Sep in Jakarta, so the window it went into
  // started 2 Aug, not 1 Aug. (That original floor is earlier than any floor
  // computed from today onwards, so it is always the one returned.)
  const firstAt = '2026-08-31T18:00:00Z';
  assert.equal(R.resubmitEarliest(cw(30, null, 'Asia/Jakarta'), firstAt), '2026-08-02');
  assert.equal(R.resubmitEarliest(cw(30, null, 'UTC'), firstAt), '2026-08-01');
});

test('claimWindowSettings: a region override wins key by key over the global default', () => {
  const settings = {
    claim_max_age_days: '60', claim_earliest_date: '2026-01-01',
    claim_window_by_region: JSON.stringify({ Thailand: { max_age_days: 14 }, Vietnam: { max_age_days: 30, earliest_date: '2026-09-01' } }),
    region_prefs_by_region: JSON.stringify({ Thailand: { timezone: 'Asia/Bangkok' } })
  };
  assert.deepEqual(R.claimWindowSettings(settings, 'Thailand'),
    { claim_max_age_days: 14, claim_earliest_date: '2026-01-01', timezone: 'Asia/Bangkok' });
  assert.deepEqual(R.claimWindowSettings(settings, 'Vietnam'),
    { claim_max_age_days: 30, claim_earliest_date: '2026-09-01', timezone: 'Asia/Jakarta' });
  assert.deepEqual(R.claimWindowSettings(settings, 'Indonesia'),
    { claim_max_age_days: '60', claim_earliest_date: '2026-01-01', timezone: 'Asia/Jakarta' });
  assert.equal(R.claimWindowSettings(settings, '*').claim_max_age_days, '60', 'All-regions uses the global policy');
});

test('claimWindowSettings survives a corrupt saved setting', () => {
  const settings = { claim_max_age_days: '45', claim_window_by_region: '{not json' };
  assert.equal(R.claimWindowSettings(settings, 'Thailand').claim_max_age_days, '45');
});

test('dateFloorFor combines the region policy with the resubmit rule', () => {
  const settings = { claim_window_by_region: JSON.stringify({ Indonesia: { earliest_date: '2026-09-10' } }) };
  assert.equal(R.dateFloorFor(settings, 'Indonesia', null), '2026-09-10');
  assert.equal(R.dateFloorFor(settings, 'Thailand', null), null);
});
