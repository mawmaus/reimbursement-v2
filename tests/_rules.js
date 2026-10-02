'use strict';

// Loads app.js's pure business rules for the tests. None of them query the
// database, so a placeholder connection string is enough: the Neon client is
// lazy and nothing here ever opens a connection.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-secret';

const rules = require('../app').rules;

// A job-position ladder in the shape loadPositions() returns: lower-cased name →
// { name, rank, can_manage }. Rank 1 is the most senior.
function ladder(entries) {
  const m = new Map();
  for (const [name, rank, canManage = false] of entries) {
    m.set(name.toLowerCase(), { name, rank, can_manage: canManage });
  }
  return m;
}
const POSITIONS = ladder([
  ['President', 1], ['Director', 3], ['General Manager', 5, true],
  ['Manager', 7, true], ['Supervisor', 10, true], ['Staff', 13]
]);

// A user with the capability map requireAuth would attach.
const user = (props = {}, caps = {}) => ({ id: 1, role: 'employee', region: 'Indonesia', department: 'Sales', position: 'Staff', caps, ...props });

module.exports = { ...rules, ladder, POSITIONS, user };
