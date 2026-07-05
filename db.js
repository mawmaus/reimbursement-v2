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

module.exports = { sql, q };
