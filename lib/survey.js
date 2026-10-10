'use strict';

// The experience survey: accounts that have been around since the paper days
// (created before 1 August 2026) are asked, once, to score the old paper
// process, the digital one, and the portal overall, each 1 (very bad) to 10
// (very good). Newer accounts never knew paper, so they aren't asked.

const { q } = require('../db');

const SURVEY_KEY = 'digital-2026';
const ELIGIBLE_BEFORE = '2026-08-01';
const QUESTIONS = ['paper_score', 'digital_score', 'overall_score'];

// True while this account is eligible and hasn't answered yet. Runs on every
// sign-in and /api/me, so a database without the survey_responses table yet
// (schema not migrated) just means "not asked" rather than a failed sign-in.
async function surveyPending(userId) {
  try {
    const rows = await q(
      `SELECT 1 AS pending FROM users u
        WHERE u.id = $1 AND u.created_at < $2::date
          AND NOT EXISTS (SELECT 1 FROM survey_responses s WHERE s.user_id = u.id AND s.survey_key = $3)`,
      [userId, ELIGIBLE_BEFORE, SURVEY_KEY]);
    return !!rows[0];
  } catch (e) {
    if (e && e.code === '42P01') return false; // undefined_table
    throw e;
  }
}

// A whole score 1–10, or null.
function score(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

module.exports = { SURVEY_KEY, ELIGIBLE_BEFORE, QUESTIONS, surveyPending, score };
