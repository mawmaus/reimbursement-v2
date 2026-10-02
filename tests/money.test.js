'use strict';

// Amounts, claim lines and cash-advance settlement.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./_rules');

test('parseAmountToCents reads typed amounts with comma thousands separators', () => {
  assert.equal(R.parseAmountToCents('150,000'), 15000000);
  assert.equal(R.parseAmountToCents('IDR 75,000.50'), 7500050);
  assert.equal(R.parseAmountToCents('19.99'), 1999); // 1998.9999… rounds back to the cent
  assert.equal(R.parseAmountToCents(150000), 15000000);
  assert.equal(R.parseAmountToCents('0'), 0);
});

test('parseAmountToCents rejects text with no digits, negatives and malformed numbers', () => {
  for (const bad of ['abc', '', '   ', '-', '-5', '1.000.000', -5, NaN, Infinity]) {
    assert.equal(R.parseAmountToCents(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('parseApprovalLimit: blank or the unlimited flag means no limit', () => {
  assert.deepEqual(R.parseApprovalLimit({}), { cents: null });
  assert.deepEqual(R.parseApprovalLimit({ approval_limit: '  ' }), { cents: null });
  assert.deepEqual(R.parseApprovalLimit({ approval_limit: '5,000,000', approval_unlimited: 'true' }), { cents: null });
  assert.deepEqual(R.parseApprovalLimit({ approval_limit: '5,000,000' }), { cents: 500000000 });
  assert.deepEqual(R.parseApprovalLimit({ approval_limit: '0' }), { cents: 0 });
});

test('parseApprovalLimit refuses a typo instead of saving a limit of 0', () => {
  assert.ok(R.parseApprovalLimit({ approval_limit: 'abc' }).error);
  assert.ok(R.parseApprovalLimit({ approval_limit: '-100' }).error);
  assert.ok(R.parseApprovalLimit({ approval_limit: -100 }).error);
});

test('approvalLimitError blocks only amounts above the limit', () => {
  const approver = R.user({ approval_limit_cents: '500000000' }); // bigint columns arrive as strings
  assert.equal(R.approvalLimitError(approver, 500000000, 'IDR'), null, 'exactly at the limit is allowed');
  assert.match(R.approvalLimitError(approver, 500000100, 'IDR'), /above your approval limit of IDR 5,000,000/);
  assert.equal(R.approvalLimitError(R.user({ approval_limit_cents: null }), 9e12, 'IDR'), null, 'null = unlimited');
  assert.equal(R.approvalLimitError(R.user({ role: 'superadmin', approval_limit_cents: 0 }), 9e12, 'IDR'), null);
});

test('normaliseClaimLines totals filled rows and skips blank ones', () => {
  const r = R.normaliseClaimLines([
    { line_date: '2026-09-01', expense_type: 'Transport', amount: '150,000' },
    {},
    { line_date: '', expense_type: '', amount: '', description: '' },
    { line_date: '2026-09-03', expense_type: 'Meals', amount: 75000.5, db_no: 'DB-7' }
  ]);
  assert.equal(r.error, undefined);
  assert.equal(r.lines.length, 2);
  assert.equal(r.totalCents, 15000000 + 7500050);
  assert.equal(r.lines[1].db_no, 'DB-7');
});

test('normaliseClaimLines names what a half-filled row is missing', () => {
  assert.match(R.normaliseClaimLines([{ expense_type: 'Transport', amount: 1 }]).error, /date/);
  assert.match(R.normaliseClaimLines([{ line_date: '2026-09-01', amount: 1 }]).error, /expense type/);
  assert.match(R.normaliseClaimLines([{ line_date: '2026-09-01', expense_type: 'Taxi', amount: 'abc' }]).error, /positive amount/);
  assert.match(R.normaliseClaimLines([{ line_date: '2026-09-01', expense_type: 'Taxi', amount: '0' }]).error, /positive amount/);
  assert.match(R.normaliseClaimLines([]).error, /at least one/);
  assert.match(R.normaliseClaimLines('nope').error, /at least one/);
});

test('claimHeaderFromLines summarises the lines onto the claim header', () => {
  const one = R.claimHeaderFromLines([{ line_date: '2026-09-02', expense_type: 'Taxi', db_no: 'DB-1', description: 'Airport' }]);
  assert.deepEqual(one, { expense_date: '2026-09-02', expense_type: 'Taxi', db_no: 'DB-1', description: 'Airport' });
  const many = R.claimHeaderFromLines([
    { line_date: '2026-09-05', expense_type: 'Taxi', db_no: 'DB-1', description: 'a' },
    { line_date: '2026-09-02', expense_type: 'Hotel', db_no: 'DB-2', description: 'b' }
  ]);
  assert.deepEqual(many, { expense_date: '2026-09-02', expense_type: 'Multiple', db_no: 'DB-1', description: '' });
});

test('normaliseMealLines needs a date and a positive amount per filled row', () => {
  const r = R.normaliseMealLines([{ date: '2026-09-01', amount: 75000, site: 'DB-9' }, { amount: '' }]);
  assert.equal(r.totalCents, 7500000);
  assert.equal(r.lines.length, 1);
  assert.match(R.normaliseMealLines([{ amount: 75000 }]).error, /date/);
  assert.match(R.normaliseMealLines([{ date: '2026-09-01', amount: -1 }]).error, /positive amount/);
  assert.match(R.normaliseMealLines([]).error, /at least one/);
});

test('normaliseAdvanceRequest requires a purpose and a positive amount', () => {
  assert.deepEqual(R.normaliseAdvanceRequest({ purpose: ' Site visit ', amount: '2,000,000', currency: 'IDR' }),
    { purpose: 'Site visit', amountCents: 200000000, currency: 'IDR' });
  assert.match(R.normaliseAdvanceRequest({ amount: 5 }).error, /purpose/);
  assert.match(R.normaliseAdvanceRequest({ purpose: 'x', amount: 'abc' }).error, /amount/);
  assert.match(R.normaliseAdvanceRequest({ purpose: 'x', amount: 0 }).error, /amount/);
});

test('settlementFor: top-up, refund or even, always as a positive amount', () => {
  // DB bigint columns arrive as strings.
  assert.deepEqual(R.settlementFor({ amount_cents: '1000000', realized_total_cents: '1250000' }), { direction: 'topup', cents: 250000 });
  assert.deepEqual(R.settlementFor({ amount_cents: '1000000', realized_total_cents: '600000' }), { direction: 'return', cents: 400000 });
  assert.deepEqual(R.settlementFor({ amount_cents: 1000000, realized_total_cents: 1000000 }), { direction: 'even', cents: 0 });
});
