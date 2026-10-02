'use strict';

// Amounts: parsing typed amounts into cents, formatting them, and approval
// limits.

const { isActive } = require('./util');

// An amount as typed or sent ("150,000", "IDR 75,000.50", 150000) into cents.
// Commas are thousands separators, matching the client's groupAmount(). Text
// with no digits at all is invalid (null), not zero: Number('') is 0, which used
// to let a typo like "abc" save an approval limit of 0.
function parseAmountToCents(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  const cleaned = String(input).replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (!/\d/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}
// Format a cents amount for a human-readable message, optionally prefixed with a
// currency code. Whole numbers show no decimals; others up to two.
function fmtMoney(cents, currency) {
  const s = (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}
// Resolve an account's approval limit from a request body into cents, where null
// means unlimited. `approval_unlimited` truthy — or a blank/absent amount —
// means unlimited (so callers that omit the fields keep the any-amount default);
// otherwise the `approval_limit` amount must be a valid non-negative number.
// Returns { cents } (cents may be null) or { error }.
function parseApprovalLimit(body) {
  if (isActive(body.approval_unlimited)) return { cents: null };
  if (body.approval_limit == null || String(body.approval_limit).trim() === '') return { cents: null };
  const cents = parseAmountToCents(body.approval_limit);
  if (cents === null) return { error: 'Approval limit must be a non-negative amount' };
  return { cents };
}
// Block an approver from acting on a claim above their approval limit. Super
// admins are exempt (they override the chain anyway); a null limit is unlimited.
// Returns an error string, or null when the approval is allowed.
function approvalLimitError(user, amountCents, currency) {
  if (!user || user.role === 'superadmin') return null;
  const limit = user.approval_limit_cents;
  if (limit == null) return null;
  if (Number(amountCents) > Number(limit)) {
    return `This claim (${fmtMoney(amountCents, currency)}) is above your approval limit of ${fmtMoney(limit, currency)}.`;
  }
  return null;
}

module.exports = {
  parseAmountToCents, approvalLimitError, fmtMoney, parseApprovalLimit
};
