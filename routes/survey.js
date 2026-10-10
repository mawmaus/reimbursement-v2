'use strict';

// The experience survey (lib/survey.js): eligible accounts answer it once; a
// Super Admin reads the results.

const express = require('express');
const { q } = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { ah } = require('../lib/util');
const { SURVEY_KEY, ELIGIBLE_BEFORE, QUESTIONS, surveyPending, score } = require('../lib/survey');

const router = express.Router();

router.post('/api/survey', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  const scores = QUESTIONS.map(k => score(b[k]));
  if (scores.some(s => s === null)) return res.status(400).json({ error: 'Choose a score from 1 to 10 for every question' });
  if (!(await surveyPending(req.user.id))) return res.status(409).json({ error: 'This survey is closed for your account' });
  await q(
    `INSERT INTO survey_responses (survey_key, user_id, region, department, paper_score, digital_score, overall_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (survey_key, user_id) DO NOTHING`,
    [SURVEY_KEY, req.user.id, String(req.user.region || ''), String(req.user.department || ''), ...scores]);
  res.json({ ok: true });
}));

// Totals, a 1–10 spread per question, and a per-region breakdown. Eligible =
// active accounts created before the cutoff (the same rule as surveyPending).
router.get('/api/survey/results', requireAuth, requireRole('superadmin'), ah(async (req, res) => {
  const [eligible, rows] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM users WHERE active = TRUE AND created_at < $1::date`, [ELIGIBLE_BEFORE]),
    q(`SELECT region, paper_score, digital_score, overall_score FROM survey_responses WHERE survey_key = $1`, [SURVEY_KEY])
  ]);
  const avg = (list, k) => list.length ? Math.round(list.reduce((s, r) => s + r[k], 0) / list.length * 10) / 10 : null;
  const questions = {};
  for (const k of QUESTIONS) {
    const dist = Array(10).fill(0);
    for (const r of rows) dist[r[k] - 1]++;
    questions[k] = { avg: avg(rows, k), dist };
  }
  const byRegion = new Map();
  for (const r of rows) {
    const key = r.region || '';
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(r);
  }
  const regions = [...byRegion].map(([region, list]) => ({
    region, n: list.length, ...Object.fromEntries(QUESTIONS.map(k => [k, avg(list, k)]))
  })).sort((a, b) => b.n - a.n || a.region.localeCompare(b.region));
  res.json({
    eligible_before: ELIGIBLE_BEFORE, eligible: eligible[0] ? eligible[0].n : 0,
    responses: rows.length, questions, regions
  });
}));

module.exports = router;
