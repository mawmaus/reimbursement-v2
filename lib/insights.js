'use strict';

// Pure aggregation for the Insights view (routes/reports.js runs the queries,
// this turns rows into figures). No database access, so tests can drive it.

const DAY_MS = 86400000;
const pad2 = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
// Days in month m (1-12) of year y.
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// The selected period and the one it is compared against. A month compares to
// the month before; a whole year to the year before. When the selected period
// is still running (today falls inside it), the previous one is cut at the same
// point — 1–18 Oct vs 1–18 Sep, Jan–18 Oct vs Jan–18 Oct last year — so a
// half-finished month isn't measured against a whole one.
function insightPeriods(year, month, today) {
  const y = Number(year);
  const m = month ? Number(month) : 0;
  let start, end, prevStart, prevEnd, py, pm;
  if (m) {
    start = ymd(y, m, 1); end = ymd(y, m, daysIn(y, m));
    py = m === 1 ? y - 1 : y; pm = m === 1 ? 12 : m - 1;
    prevStart = ymd(py, pm, 1); prevEnd = ymd(py, pm, daysIn(py, pm));
  } else {
    start = ymd(y, 1, 1); end = ymd(y, 12, 31);
    py = y - 1;
    prevStart = ymd(py, 1, 1); prevEnd = ymd(py, 12, 31);
  }
  const partial = !!today && today >= start && today < end;
  if (partial) {
    const tm = Number(today.slice(5, 7)), td = Number(today.slice(8, 10));
    const cm = m ? pm : tm; // the matching month in the previous period
    prevEnd = ymd(py, cm, Math.min(td, daysIn(py, cm)));
  }
  return { start, end: partial ? today : end, prevStart, prevEnd, partial, prevYear: String(py), prevMonth: m ? pad2(pm) : '' };
}

// Total, distinct documents and average per document for a set of line rows
// ({ cents, cid }).
function summarize(rows) {
  const total = rows.reduce((s, r) => s + Number(r.cents), 0);
  const claims = new Set(rows.map(r => r.cid)).size;
  return { total_cents: total, claims, avg_cents: claims ? Math.round(total / claims) : 0 };
}

// Spend grouped by keyFn(row), biggest first: [{ key, cents, n }] where n is
// the number of distinct documents behind the group.
function rankBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let g = map.get(k);
    if (!g) { g = { key: k, cents: 0, docs: new Set() }; map.set(k, g); }
    g.cents += Number(r.cents);
    g.docs.add(r.cid);
  }
  return [...map.values()].sort((a, b) => b.cents - a.cents || String(a.key).localeCompare(String(b.key)))
    .map(g => ({ key: g.key, cents: g.cents, n: g.docs.size }));
}

const round1 = x => Math.round(x * 10) / 10;
const avg = xs => xs.length ? round1(xs.reduce((s, x) => s + x, 0) / xs.length) : null;
// Whole days between two YYYY-MM-DD dates (b - a).
const dateDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);

// How long documents took, for those that reached the step inside [start, end]:
//   approve — last (re)submission to final approval (decided), in days;
//   pay     — approval date to payment date, in whole days (Finance records a
//             payment DATE, so a same-day payment counts as 0).
// Each doc: { sub_ms, dec_ms, dec_d, paid_d, status }.
function speedStats(docs, start, end) {
  const inRange = d => !!d && d >= start && d <= end;
  const approve = [], pay = [];
  for (const d of docs) {
    if (inRange(d.dec_d) && d.sub_ms != null && d.dec_ms != null) {
      approve.push(Math.max(0, (Number(d.dec_ms) - Number(d.sub_ms)) / DAY_MS));
    }
    if (d.status === 'paid' && inRange(d.paid_d) && d.dec_d) pay.push(Math.max(0, dateDiff(d.dec_d, d.paid_d)));
  }
  return {
    approve: { n: approve.length, avg_days: avg(approve) },
    pay: { n: pay.length, avg_days: avg(pay) }
  };
}

// What is waiting right now, per stage ('approval' | 'payment'): count, amount,
// average and longest wait in days, and how many have waited over a week.
// Each doc: { stage, cents, wait_days } (the wait is measured by the database
// clock, the same one that stamped the history).
const STALE_DAYS = 7;
function pipelineStats(docs) {
  const out = {};
  for (const stage of ['approval', 'payment']) {
    const ds = docs.filter(d => d.stage === stage);
    const waits = ds.filter(d => d.wait_days != null).map(d => Math.max(0, Number(d.wait_days)));
    out[stage] = {
      n: ds.length,
      cents: ds.reduce((s, d) => s + Number(d.cents || 0), 0),
      avg_days: avg(waits),
      oldest_days: waits.length ? Math.floor(Math.max(...waits)) : null,
      stale: waits.filter(w => w >= STALE_DAYS).length
    };
  }
  return out;
}

module.exports = { insightPeriods, summarize, rankBy, speedStats, pipelineStats, STALE_DAYS };
