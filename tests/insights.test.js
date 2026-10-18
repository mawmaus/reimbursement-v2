'use strict';

// Insights figures: comparison periods, rankings, approval / payment speed and
// the waiting pipeline (lib/insights.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./_rules');

test('insightPeriods: a finished month compares to the whole month before', () => {
  const p = R.insightPeriods('2026', '09', '2026-10-18');
  assert.equal(p.start, '2026-09-01');
  assert.equal(p.end, '2026-09-30');
  assert.equal(p.prevStart, '2026-08-01');
  assert.equal(p.prevEnd, '2026-08-31');
  assert.equal(p.partial, false);
  assert.equal(p.prevMonth, '08');
});

test('insightPeriods: a running month compares to the same days of the month before', () => {
  const p = R.insightPeriods('2026', '10', '2026-10-18');
  assert.equal(p.end, '2026-10-18');
  assert.equal(p.prevStart, '2026-09-01');
  assert.equal(p.prevEnd, '2026-09-18');
  assert.equal(p.partial, true);
  // 31 March compares to February, which has no 31st.
  assert.equal(R.insightPeriods('2026', '03', '2026-03-31').prevEnd, '2026-02-28');
});

test('insightPeriods: January compares to December of the year before', () => {
  const p = R.insightPeriods('2026', '01', '2026-10-18');
  assert.equal(p.prevStart, '2025-12-01');
  assert.equal(p.prevEnd, '2025-12-31');
  assert.equal(p.prevYear, '2025');
});

test('insightPeriods: a running year compares year-to-date', () => {
  const p = R.insightPeriods('2026', '', '2026-10-18');
  assert.equal(p.start, '2026-01-01');
  assert.equal(p.prevStart, '2025-01-01');
  assert.equal(p.prevEnd, '2025-10-18');
  assert.equal(p.partial, true);
  const done = R.insightPeriods('2025', '', '2026-10-18');
  assert.equal(done.prevEnd, '2024-12-31');
  assert.equal(done.partial, false);
});

test('summarize and rankBy count documents, not lines', () => {
  const rows = [
    { cid: 'c1', cents: 100, dept: 'Sales' }, { cid: 'c1', cents: 50, dept: 'Sales' },
    { cid: 'm2', cents: 300, dept: 'Tech' }, { cid: 'c3', cents: 20, dept: 'Sales' }
  ];
  assert.deepEqual(R.summarize(rows), { total_cents: 470, claims: 3, avg_cents: 157 });
  assert.deepEqual(R.summarize([]), { total_cents: 0, claims: 0, avg_cents: 0 });
  assert.deepEqual(R.rankBy(rows, r => r.dept), [
    { key: 'Tech', cents: 300, n: 1 }, { key: 'Sales', cents: 170, n: 2 }
  ]);
});

test('speedStats times approval from submission and payment by date, inside the period only', () => {
  const H = 3600000;
  const docs = [
    // Approved 2 days after submission, paid 3 days after approval.
    { status: 'paid', sub_ms: 0, dec_ms: 48 * H, dec_d: '2026-09-03', paid_d: '2026-09-06' },
    // Approved after 1 day; not paid yet.
    { status: 'approved', sub_ms: 0, dec_ms: 24 * H, dec_d: '2026-09-10', paid_d: null },
    // Approved and paid before the period: ignored.
    { status: 'paid', sub_ms: 0, dec_ms: 96 * H, dec_d: '2026-08-31', paid_d: '2026-08-31' },
    // Approved before the period, paid 2 days later inside it.
    { status: 'paid', sub_ms: 0, dec_ms: 96 * H, dec_d: '2026-08-30', paid_d: '2026-09-01' }
  ];
  const s = R.speedStats(docs, '2026-09-01', '2026-09-30');
  assert.deepEqual(s.approve, { n: 2, avg_days: 1.5 });
  assert.deepEqual(s.pay, { n: 2, avg_days: 2.5 });
  assert.deepEqual(R.speedStats([], '2026-09-01', '2026-09-30').approve, { n: 0, avg_days: null });
});

test('pipelineStats splits what waits by stage, with the longest wait and the over-a-week count', () => {
  const p = R.pipelineStats([
    { stage: 'approval', cents: 100, wait_days: 1.5 },
    { stage: 'approval', cents: 200, wait_days: 9.2 },
    { stage: 'payment', cents: '50', wait_days: '0.25' }
  ]);
  assert.deepEqual(p.approval, { n: 2, cents: 300, avg_days: 5.4, oldest_days: 9, stale: 1 });
  assert.deepEqual(p.payment, { n: 1, cents: 50, avg_days: 0.3, oldest_days: 0, stale: 0 });
  assert.deepEqual(R.pipelineStats([]).payment, { n: 0, cents: 0, avg_days: null, oldest_days: null, stale: 0 });
});
