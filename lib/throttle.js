'use strict';

// A per-account send limit ("at most N in a rolling window"), counted in the
// database so every serverless instance shares it. It reuses the
// `login_attempts` table (key, count, window start) under a "kind:" key prefix
// that the login throttle never uses, so no schema change is needed.
//
// The key carries a keyed hash of the account id, not the id itself: a row for
// anonymous feedback must not say who sent it.

const crypto = require('crypto');
const { q } = require('../db');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const keyFor = (kind, userId) =>
  `${kind}:${crypto.createHmac('sha256', SECRET).update(String(userId)).digest('hex').slice(0, 32)}`;

// Count one send. Returns 0 when it's allowed, or the minutes until the window
// resets when this one is over the limit. A single atomic upsert, so concurrent
// sends can't slip past the count.
async function overLimit(kind, userId, max, windowMs) {
  const rows = await q(
    `INSERT INTO login_attempts (attempt_key, fails, first_at)
     VALUES ($1, 1, now())
     ON CONFLICT (attempt_key) DO UPDATE SET
       fails    = CASE WHEN now() - login_attempts.first_at >= $2::interval THEN 1     ELSE login_attempts.fails + 1 END,
       first_at = CASE WHEN now() - login_attempts.first_at >= $2::interval THEN now() ELSE login_attempts.first_at    END
     RETURNING fails, first_at`,
    [keyFor(kind, userId), `${windowMs} milliseconds`]);
  const r = rows[0];
  if (!r || r.fails <= max) return 0;
  return Math.max(1, Math.ceil((windowMs - (Date.now() - new Date(r.first_at).getTime())) / 60000));
}

module.exports = { overLimit };
