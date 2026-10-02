'use strict';

// The claim list: status filters, the 90-day window and the slim list shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./_rules');

// Collects WHERE clauses the way the list handlers do.
function builder() {
  const where = [], params = [];
  const add = (clause, val) => { params.push(val); where.push(clause.replace('$$', `$${params.length}`)); };
  return { where, params, add };
}

test('applyListStatusFilter splits "pending" by which approver is next', () => {
  const b = builder();
  R.applyListStatusFilter('pending_manager', b.where, b.add);
  R.applyListStatusFilter('pending_finance', b.where, b.add);
  R.applyListStatusFilter('paid', b.where, b.add);
  R.applyListStatusFilter('', b.where, b.add);
  assert.deepEqual(b.where, [
    `(status = 'submitted' AND COALESCE(current_step, 0) <= 1)`,
    `(status = 'submitted' AND current_step >= 2)`,
    'status = $1'
  ]);
  assert.deepEqual(b.params, ['paid'], 'a plain status goes in as a parameter, never into the SQL');
});

test('applyLedgerWindow keeps open items and anything touched since the date', () => {
  const b = builder();
  b.params.push(7); // an earlier parameter, e.g. the viewer's id
  R.applyLedgerWindow({ query: { since: '2026-07-04' } }, '', R.OPEN_CLAIM_SQL, b.where, b.params);
  assert.deepEqual(b.params, [7, '2026-07-04']);
  assert.equal(b.where[0], `(${R.OPEN_CLAIM_SQL} OR COALESCE(updated_at, created_at) >= $2::date)`);
});

test('applyLedgerWindow never narrows a search, and ignores anything but a date', () => {
  for (const [since, search] of [['2026-07-04', 'RC-2026'], ['', ''], ["2026-07-04'; DROP TABLE claims; --", ''], ['04/07/2026', ''], [undefined, '']]) {
    const b = builder();
    R.applyLedgerWindow({ query: { since } }, search, R.OPEN_CLAIM_SQL, b.where, b.params);
    assert.equal(b.where.length, 0, `since=${JSON.stringify(since)} search=${JSON.stringify(search)}`);
    assert.equal(b.params.length, 0);
  }
});

test('open states: pending/approved claims; advances until closed, refunds included', () => {
  assert.match(R.OPEN_CLAIM_SQL, /'submitted','approved'/);
  assert.doesNotMatch(R.OPEN_CLAIM_SQL, /paid|rejected/);
  for (const s of ['submitted', 'approved', 'paid', 'realize_submitted', 'rejected_realize']) {
    assert.match(R.OPEN_ADVANCE_SQL, new RegExp(`'${s}'`), s);
  }
  assert.match(R.OPEN_ADVANCE_SQL, /realize_approved' AND realized_total_cents < amount_cents/, 'under-spent: awaiting refund');
  assert.doesNotMatch(R.OPEN_ADVANCE_SQL, /'settled'/);
});

test('slimForList drops history and receipts, keeps everything else', () => {
  const claim = {
    id: 5, claim_no: 'RC-2026-0005', amount: 150000, status: 'paid',
    history: [{ action: 'approved' }], attachments: [{ id: 1 }],
    lines: [{ id: 9, amount: 150000, attachments: [{ id: 1 }], rejected: null }]
  };
  const slim = R.slimForList(claim, new Set([5]));
  assert.deepEqual(slim, {
    id: 5, claim_no: 'RC-2026-0005', amount: 150000, status: 'paid',
    lines: [{ id: 9, amount: 150000, rejected: null }], reviewed_by_me: true
  });
  assert.equal(R.slimForList({ ...claim, id: 6 }, new Set([5])).reviewed_by_me, false);
  assert.ok(claim.history && claim.lines[0].attachments, 'the original object is left untouched');
});
