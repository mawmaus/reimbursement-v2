'use strict';

const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at your Neon Postgres connection string.');
}

const sql = neon(process.env.DATABASE_URL || 'postgres://invalid');

// Run a parameterized query ($1, $2, …) and return an array of row objects.
async function q(text, params = []) {
  return await sql.query(text, params);
}

// Build a lazy (un-executed) parameterized query for batching inside a
// transaction. On its own it does nothing until handed to transaction().
const qq = (text, params = []) => sql.query(text, params);

// Run an array of lazy queries (from qq) as one atomic transaction over a
// single HTTP round-trip: they all commit together or all roll back. Because
// they share one session, `currval(...)` in a later query sees a sequence
// advanced by an earlier INSERT in the same batch. Resolves to an array with
// one result set per query, in order.
const transaction = (queries) => sql.transaction(queries);

module.exports = { sql, q, qq, transaction };
