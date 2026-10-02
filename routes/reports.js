'use strict';

// Expense insights and the CSV export.

const express = require('express');
const { q } = require('../db');
const { requireAuth, requireCap } = require('../lib/auth');
const { ah, tzOffsetLabel, tsInZone, iso } = require('../lib/util');
const { loadPositions, insightsCanView, insightsSeeAll } = require('../lib/permissions');
const {
  viewRegionFilter, regionPrefsFor, DEFAULT_CURRENCY, seesAllRegions
} = require('../lib/settings');
const { todayInZone } = require('../lib/claim-window');

const router = express.Router();

// ---------------------------------------------------------------------------
// Export CSV (finance)
// ---------------------------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? '' : (v instanceof Date ? v.toISOString() : String(v));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// "Pending review" (DB status 'submitted') is split for export by which approver
// is next: step 1 is still with the department Manager; once the Manager has
// signed off the claim advances to step >= 2 and is with FinanceAP. So finance can
// export only what Managers have already approved by picking pending_finance.
const EXPORT_STATUSES = ['pending_manager', 'pending_finance', 'approved', 'rejected', 'paid'];
// Turn the selected export-status tokens into a SQL boolean over a base-status
// expression and a current_step expression. Tokens come from EXPORT_STATUSES (a
// fixed whitelist) and the exprs are hard-coded column refs, so inlining them is
// injection-safe and keeps the caller's positional params untouched. Returns ''
// when nothing is selected (meaning: no status filter).
function exportStatusCondition(tokens, statusExpr, stepExpr) {
  const parts = [];
  for (const tk of tokens) {
    if (tk === 'pending_manager') parts.push(`(${statusExpr} = 'submitted' AND COALESCE(${stepExpr}, 0) <= 1)`);
    else if (tk === 'pending_finance') parts.push(`(${statusExpr} = 'submitted' AND ${stepExpr} >= 2)`);
    else if (tk === 'approved' || tk === 'rejected' || tk === 'paid') parts.push(`${statusExpr} = '${tk}'`);
  }
  return parts.length ? `(${parts.join(' OR ')})` : '';
}
// Human label for the CSV Status column. A 'submitted' base status splits into the
// two pending-review buckets by step; every other status passes through unchanged
// (matching what the export showed before).
function exportStatusLabel(baseStatus, step) {
  if (baseStatus === 'submitted') {
    return (Number(step) || 0) >= 2 ? 'Pending Review - FinanceAP' : 'Pending Review - Manager';
  }
  return baseStatus;
}
// ---------------------------------------------------------------------------
// Expense insights (charts)
// ---------------------------------------------------------------------------
// Aggregated spend for the Insights view. Reimbursement claims and meal
// allowances are folded into one dataset: meal allowances appear as the category
// "Meal allowance", grouped by each line item's date (a meal claim has no single
// expense date). Everything is grouped by expense date.
//
// Scope depends on the viewer (see insightsSeeAll / insightsCanView):
//   • super admins, Finance (any position), and General Manager and above see
//     ALL transactions company-wide;
//   • everyone else who may view (below GM, above Assistant Supervisor) sees only
//     the claims they approve — i.e. claims on which they are one of the
//     approvers, across whatever departments those claims belong to.
// Filters: `year`, `department` (narrows within the viewer's scope), `db`
// (DB-number substring — DB lives on claims.db_no and, for meals, on each line's
// `site`), and `status` (comma-separated; defaults to approved + paid).
const INSIGHT_STATUSES = ['submitted', 'approved', 'rejected', 'paid'];
router.get('/api/insights', requireAuth, ah(async (req, res) => {
  const pos = await loadPositions(req.user.region);
  if (!insightsCanView(req.user, pos)) {
    return res.status(403).json({ error: 'You do not have access to insights' });
  }
  const seeAll = insightsSeeAll(req.user, pos);
  const mode = seeAll ? 'all' : 'approver';

  let statuses = String(req.query.status || '').split(',').map(s => s.trim())
    .filter(s => INSIGHT_STATUSES.includes(s));
  if (!statuses.length) statuses = ['approved', 'paid'];

  const deptFilter = String(req.query.department || '').trim();
  const db = String(req.query.db || '').trim();
  const nameFilter = String(req.query.name || '').trim();

  const params = [];
  const where = [];
  const ph = statuses.map(s => { params.push(s); return `$${params.length}`; }).join(',');
  where.push(`status IN (${ph})`);
  where.push(`d ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`);
  // Approver-scoped viewers only see claims they approve; see-all viewers have no
  // such restriction. (`appr` is the claim's approver_ids array; Postgres arrays
  // are surfaced through the UNION below.)
  if (mode === 'approver') { params.push(req.user.id); where.push(`$${params.length} = ANY(appr)`); }
  if (deptFilter) { params.push(deptFilter); where.push(`lower(department) = lower($${params.length})`); }
  if (db) { params.push(`%${db}%`); where.push(`db ILIKE $${params.length}`); }
  // Employee-name substring filter (matches the claimant on each document).
  if (nameFilter) { params.push(`%${nameFilter}%`); where.push(`claimant ILIKE $${params.length}`); }
  // Region scope: region-locked viewers are pinned to their own region; all
  // -region viewers (Super Admins / VPs) may narrow to one via the top-bar picker
  // (?region=Name), else they see every region. Reused for the option lists below.
  const vr = await viewRegionFilter(req);
  if (vr !== null) { params.push(vr); where.push(`region = $${params.length}`); }

  // Reimbursement rows come from each claim's LINES (claim_lines), not the claim
  // header, so every expense keeps its own real type instead of the header's
  // "Multiple" summary. `no`/`claimant` carry the source document number and the
  // claimant name so the client can drill into a type and search by employee.
  const rows = await q(
    `SELECT category, substring(d,1,4) AS yr, substring(d,6,2) AS mo, d,
            cents::bigint AS cents, cid, db, no, claimant
       FROM (
         SELECT l.expense_type AS category, c.department, l.line_date AS d,
                l.amount_cents AS cents, c.status, COALESCE(l.db_no,'') AS db, 'c' || c.id AS cid,
                c.approver_ids AS appr, c.region, c.claim_no AS no, c.claimant_name AS claimant
           FROM claim_lines l JOIN claims c ON c.id = l.claim_id
          WHERE l.rejected_at IS NULL
         UNION ALL
         SELECT 'Meal allowance' AS category, m.department, l.line_date AS d,
                l.amount_cents AS cents, m.status, COALESCE(l.site,'') AS db, 'm' || m.id AS cid,
                m.approver_ids AS appr, m.region AS region, m.claim_no AS no, m.claimant_name AS claimant
           FROM meal_claim_lines l JOIN meal_claims m ON m.id = l.meal_claim_id
          WHERE l.rejected_at IS NULL
         UNION ALL
         -- Cash advances contribute their realization lines (actual transactions),
         -- which only exist once the advance is realized. The realization approval
         -- phase is mapped onto the base statuses so the status filter treats them
         -- like any other claim (realize_approved -> approved, settled -> paid, …).
         SELECT COALESCE(l.expense_type,'') AS category, a.department, l.line_date AS d,
                l.amount_cents AS cents,
                CASE a.status WHEN 'realize_submitted' THEN 'submitted'
                              WHEN 'realize_approved'  THEN 'approved'
                              WHEN 'settled'           THEN 'paid'
                              WHEN 'rejected_realize'  THEN 'rejected'
                              ELSE a.status END AS status,
                COALESCE(l.db_no,'') AS db, 'a' || a.id AS cid,
                a.approver_ids AS appr, a.region AS region, a.advance_no AS no, a.claimant_name AS claimant
           FROM cash_advance_lines l JOIN cash_advances a ON a.id = l.advance_id
          WHERE l.rejected_at IS NULL
       ) ev
      WHERE ${where.join(' AND ')}`, params);

  // Years present (desc). Resolve the selected year: the requested one when it
  // has data, else the most recent year, else the current calendar year.
  const yearsSet = new Set(rows.map(r => r.yr));
  const years = [...yearsSet].sort().reverse();
  const reqYear = String(req.query.year || '').trim();
  const year = (reqYear && yearsSet.has(reqYear)) ? reqYear
    : (years[0] || String(new Date().getFullYear()));

  // By year (all years) — backs the yearly trend toggle.
  const byYearMap = new Map();
  for (const r of rows) byYearMap.set(r.yr, (byYearMap.get(r.yr) || 0) + Number(r.cents));
  const byYear = [...byYearMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([y, cents]) => ({ year: y, cents }));

  // Everything else is for the selected year only.
  const inYear = rows.filter(r => r.yr === year);
  // Optional month narrowing within the selected year (the "Month" filter). The
  // month dropdown lists the months that actually have data; a requested month
  // outside that set is ignored (falls back to the whole year). The type
  // breakdown, KPIs and drill-down details use this narrowed scope; the option
  // lists and the monthly trend chart still describe the whole year.
  const monthsSet = new Set(inYear.map(r => r.mo));
  const months = [...monthsSet].sort();
  const monthReq = String(req.query.month || '').trim();
  const month = (/^(0[1-9]|1[0-2])$/.test(monthReq) && monthsSet.has(monthReq)) ? monthReq : '';
  const inScope = month ? inYear.filter(r => r.mo === month) : inYear;

  const byTypeMap = new Map();
  for (const r of inScope) byTypeMap.set(r.category, (byTypeMap.get(r.category) || 0) + Number(r.cents));
  const byType = [...byTypeMap.entries()].sort((a, b) => b[1] - a[1])
    .map(([type, cents]) => ({ type, cents }));

  // Line-level detail for the selected scope, biggest first, so the client can
  // drill into any expense type (pivot-style) and show each underlying line.
  const details = inScope
    .map(r => ({ cid: r.cid || '', no: r.no || '', name: r.claimant || '', date: r.d, db: r.db || '', type: r.category, cents: Number(r.cents) }))
    .sort((a, b) => b.cents - a.cents);

  // The monthly trend always spans the whole year (it's the "in context" view);
  // the Month filter narrows the KPIs / breakdown, not this chart.
  const monthCents = Array(12).fill(0);
  for (const r of inYear) { const m = Number(r.mo); if (m >= 1 && m <= 12) monthCents[m - 1] += Number(r.cents); }
  const byMonth = monthCents.map((cents, i) => ({ month: String(i + 1).padStart(2, '0'), cents }));

  const total = inScope.reduce((s, r) => s + Number(r.cents), 0);
  const claims = new Set(inScope.map(r => r.cid)).size;
  const top = byType[0] || null;
  const kpis = {
    total_cents: total,
    claims,
    avg_cents: claims ? Math.round(total / claims) : 0,
    top_type: top ? top.type : '',
    top_share: top && total ? Math.round((top.cents / total) * 100) : 0
  };

  // Department options for the filter dropdown. See-all viewers get every
  // department (scoped to the picked region when one is chosen); approver-scoped
  // viewers get only the departments among the claims they approve (e.g. an
  // approver over Technician + After Sales sees both).
  const drows = seeAll
    ? await q(
        `SELECT DISTINCT department FROM (
           SELECT department, region FROM claims
           UNION SELECT department, region FROM meal_claims
           UNION SELECT department, region FROM cash_advances
         ) t WHERE COALESCE(TRIM(department), '') <> ''${vr !== null ? ' AND region = $1' : ''} ORDER BY department`,
        vr !== null ? [vr] : [])
    : await q(
        `SELECT DISTINCT department FROM (
           SELECT department FROM claims        WHERE $1 = ANY(approver_ids)
           UNION
           SELECT department FROM meal_claims   WHERE $1 = ANY(approver_ids)
           UNION
           SELECT department FROM cash_advances WHERE $1 = ANY(approver_ids)
         ) t WHERE COALESCE(TRIM(department), '') <> '' ORDER BY department`, [req.user.id]);
  const departments = drows.map(r => r.department);

  // Employee options for the searchable filter — distinct claimant names in the
  // viewer's scope (region + approver-mode), independent of the year/dept/status
  // filters so the list stays stable as you narrow. Mirrors the department list.
  const empConds = [`COALESCE(TRIM(claimant_name), '') <> ''`];
  const empParams = [];
  if (mode === 'approver') { empParams.push(req.user.id); empConds.push(`$${empParams.length} = ANY(approver_ids)`); }
  if (vr !== null) { empParams.push(vr); empConds.push(`region = $${empParams.length}`); }
  const erows = await q(
    `SELECT DISTINCT claimant_name FROM (
       SELECT claimant_name, approver_ids, region FROM claims
       UNION ALL SELECT claimant_name, approver_ids, region FROM meal_claims
       UNION ALL SELECT claimant_name, approver_ids, region FROM cash_advances
     ) t WHERE ${empConds.join(' AND ')} ORDER BY claimant_name`, empParams);
  const employees = erows.map(r => r.claimant_name);

  // DB-number options for the searchable filter — distinct DB numbers in scope.
  // DB lives per line: claim_lines.db_no, cash_advance_lines.db_no, and (for
  // meals) meal_claim_lines.site, matching the `db` column in the rows query.
  const dbConds = [`COALESCE(TRIM(db), '') <> ''`];
  const dbParams = [];
  if (mode === 'approver') { dbParams.push(req.user.id); dbConds.push(`$${dbParams.length} = ANY(approver_ids)`); }
  if (vr !== null) { dbParams.push(vr); dbConds.push(`region = $${dbParams.length}`); }
  const dbrows = await q(
    `SELECT DISTINCT db FROM (
       SELECT l.db_no AS db, c.approver_ids, c.region
         FROM claim_lines l JOIN claims c ON c.id = l.claim_id
       UNION ALL SELECT l.site AS db, m.approver_ids, m.region
         FROM meal_claim_lines l JOIN meal_claims m ON m.id = l.meal_claim_id
       UNION ALL SELECT l.db_no AS db, a.approver_ids, a.region
         FROM cash_advance_lines l JOIN cash_advances a ON a.id = l.advance_id
     ) t WHERE ${dbConds.join(' AND ')} ORDER BY db`, dbParams);
  const dbNos = dbrows.map(r => r.db);

  res.json({
    scope: { mode, department: deptFilter || null },
    // Region-scoped viewers see their region's currency; all-regions viewers see
    // the global default (their totals may span multiple currencies).
    currency: vr ? (await regionPrefsFor(vr)).currency : DEFAULT_CURRENCY,
    year, years, month, months, status: statuses, db, name: nameFilter, departments, employees, dbNos,
    byType, byMonth, byYear, kpis, details
  });
}));

// Export both reimbursement claims and meal allowance claims in one CSV.
// Filters: `status` (comma-separated, any of the four), `from`/`to` (inclusive,
// applied to each row's expense/meal date), and `types` (comma-separated:
// reimbursement, meal \u2014 defaults to both). Reimbursement claims export one row
// each; meal allowances export one row per line item (per day), so finance sees
// the full daily breakdown. A shared column set carries both.
router.get('/api/export.csv', requireAuth, requireCap('export_csv'), ah(async (req, res) => {
  const { from, to } = req.query;
  const statuses = String(req.query.status || '').split(',').map(s => s.trim())
    .filter(s => EXPORT_STATUSES.includes(s));
  const types = String(req.query.types || 'reimbursement,meal,advance').split(',').map(s => s.trim());
  const wantReimb = types.includes('reimbursement');
  const wantMeal = types.includes('meal');
  const wantAdvance = types.includes('advance');
  // Optional whitelist of submitter (employee) ids to include. Filter to positive
  // ids: an absent/empty param must yield [] (no filter), not [0] — Number('') is
  // 0 and passes Number.isInteger, which would otherwise filter every row to
  // employee_id IN (0) and export nothing when "all users" is selected.
  const employees = String(req.query.employees || '').split(',')
    .map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);

  // Timestamps export in the exporting user's region time zone — the same zone
  // the portal renders them in (see the client's fmtDateTime) — so a CSV cell and
  // the on-screen claim never disagree about the date. The offset goes in the
  // column headers, which keeps the cells parseable as dates by Excel.
  const { timezone } = await regionPrefsFor(req.user.region);
  const ts = (v) => tsInZone(v, timezone);
  const zone = tzOffsetLabel(timezone);
  // paid_at is the payment DATE Finance picked on "Mark as paid", stored as
  // midnight UTC (the DB session zone). Export that date as-is: shifting it into
  // the region zone would invent a time (07:00 in GMT+7) or, west of UTC, roll it
  // back a day. Matches the portal's "Paid on" column.
  const payDate = (v) => (iso(v) || '').slice(0, 10);

  const out = []; // { key: sortKey, cells: [...] }

  if (wantReimb) {
    const where = [];
    const params = [];
    const scond = exportStatusCondition(statuses, 'c.status', 'c.current_step');
    if (scond) where.push(scond);
    if (employees.length) {
      const ph = employees.map((_, i) => `$${params.length + i + 1}`).join(',');
      employees.forEach(e => params.push(e));
      where.push(`c.employee_id IN (${ph})`);
    }
    // Filter on the line's own date (like meal/advance), so a multi-line claim
    // contributes only the lines that fall in the range.
    // Lines an approver rejected aren't payable here (they're re-claimed elsewhere).
    where.push('l.rejected_at IS NULL');
    if (from) { params.push(from); where.push(`l.line_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`l.line_date <= $${params.length}`); }
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`c.region = $${params.length}`); }
    // One row per line so each expense category exports on its own row (instead of
    // the claim header's "Multiple" summary). first_approved_at is when the FIRST
    // approver (step 1) approved in the CURRENT cycle: the latest step-1 approval
    // dated after the most recent (re)submission. So a reject + resubmit clears the
    // date until the Manager approves again. 'approved' with no step suffix covers
    // claims that have no approver chain.
    const rows = await q(
      `SELECT c.claim_no, c.claimant_name, c.department, c.bank_name, c.recipient_name,
              c.bank_account_no, c.currency, c.status, c.current_step, c.manager_comment, c.decided_at,
              c.paid_at, c.created_at, u.username AS employee_username, fa.first_approved_at,
              l.line_date, l.db_no, l.expense_type, l.amount_cents, l.description, l.sort_order
       FROM claim_lines l
       JOIN claims c ON c.id = l.claim_id
       JOIN users u ON u.id = c.employee_id
       LEFT JOIN (SELECT h.claim_id, MAX(h.created_at) AS first_approved_at
                    FROM claim_history h
                   WHERE (h.action LIKE 'approved — step 1 of %' OR h.action = 'approved')
                     AND h.created_at > COALESCE((SELECT MAX(s.created_at) FROM claim_history s
                           WHERE s.claim_id = h.claim_id AND s.action IN ('submitted','resubmitted')),
                           '-infinity'::timestamptz)
                   GROUP BY h.claim_id) fa
              ON fa.claim_id = c.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.created_at, l.sort_order`, params);
    for (const r of rows) {
      out.push({ key: iso(r.created_at) || '', cells: [
        'Reimbursement', r.claim_no, r.employee_username, r.claimant_name, r.department,
        r.bank_name, r.recipient_name, r.bank_account_no, r.line_date, r.expense_type, r.db_no || '',
        (Number(r.amount_cents) / 100).toFixed(2), r.currency, r.description,
        exportStatusLabel(r.status, r.current_step),
        r.manager_comment, ts(r.first_approved_at), ts(r.decided_at), payDate(r.paid_at), ts(r.created_at)] });
    }
  }

  if (wantMeal) {
    const where = [];
    const params = [];
    const scond = exportStatusCondition(statuses, 'm.status', 'm.current_step');
    if (scond) where.push(scond);
    if (employees.length) {
      const ph = employees.map((_, i) => `$${params.length + i + 1}`).join(',');
      employees.forEach(e => params.push(e));
      where.push(`m.employee_id IN (${ph})`);
    }
    // Lines an approver rejected aren't payable here (they're re-claimed elsewhere).
    where.push('l.rejected_at IS NULL');
    if (from) { params.push(from); where.push(`l.line_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`l.line_date <= $${params.length}`); }
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`m.region = $${params.length}`); }
    const rows = await q(
      `SELECT m.claim_no, m.claimant_name, m.department, m.bank_name, m.recipient_name,
              m.bank_account_no, m.currency, m.status, m.current_step, m.manager_comment, m.decided_at, m.paid_at,
              m.created_at, u.username AS employee_username, fa.first_approved_at,
              l.line_date, l.site, l.job_category, l.amount_cents, l.description, l.sort_order
       FROM meal_claim_lines l
       JOIN meal_claims m ON m.id = l.meal_claim_id
       JOIN users u ON u.id = m.employee_id
       LEFT JOIN (SELECT h.meal_claim_id, MAX(h.created_at) AS first_approved_at
                    FROM meal_claim_history h
                   WHERE (h.action LIKE 'approved — step 1 of %' OR h.action = 'approved')
                     AND h.created_at > COALESCE((SELECT MAX(s.created_at) FROM meal_claim_history s
                           WHERE s.meal_claim_id = h.meal_claim_id AND s.action IN ('submitted','resubmitted')),
                           '-infinity'::timestamptz)
                   GROUP BY h.meal_claim_id) fa
              ON fa.meal_claim_id = m.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.created_at, l.sort_order`, params);
    for (const r of rows) {
      out.push({ key: iso(r.created_at) || '', cells: [
        'Meal allowance', r.claim_no, r.employee_username, r.claimant_name, r.department,
        r.bank_name, r.recipient_name, r.bank_account_no, r.line_date, r.job_category, r.site,
        (Number(r.amount_cents) / 100).toFixed(2), r.currency, r.description,
        exportStatusLabel(r.status, r.current_step),
        r.manager_comment, ts(r.first_approved_at), ts(r.decided_at), payDate(r.paid_at), ts(r.created_at)] });
    }
  }

  // Cash advances export one row per realization line — so only realized advances
  // appear (a request-stage advance has no lines). The status filter is applied to
  // the realization phase mapped onto the base statuses (see the CASE below); the
  // Status column shows the advance's real status.
  if (wantAdvance) {
    const where = [];
    const params = [];
    const mappedStatus = `CASE a.status WHEN 'realize_submitted' THEN 'submitted'
      WHEN 'realize_approved' THEN 'approved' WHEN 'settled' THEN 'paid'
      WHEN 'rejected_realize' THEN 'rejected' ELSE a.status END`;
    const scond = exportStatusCondition(statuses, `(${mappedStatus})`, 'a.current_step');
    if (scond) where.push(scond);
    if (employees.length) {
      const ph = employees.map((_, i) => `$${params.length + i + 1}`).join(',');
      employees.forEach(e => params.push(e));
      where.push(`a.employee_id IN (${ph})`);
    }
    // Lines an approver rejected aren't payable here (they're re-claimed elsewhere).
    where.push('l.rejected_at IS NULL');
    if (from) { params.push(from); where.push(`l.line_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`l.line_date <= $${params.length}`); }
    if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`a.region = $${params.length}`); }
    // first_approved_at = when the first approver (step 1) approved the request
    // phase, in the current cycle: the latest step-1 approval dated after the most
    // recent request (re)submission, so a reject + resubmit clears it until re-approved.
    // Request (re)submissions are 'submitted'/'resubmitted'; the realization phase
    // uses 'realization submitted/resubmitted' and 'realization approved …', all of
    // which this deliberately ignores.
    const rows = await q(
      `SELECT a.advance_no, a.claimant_name, a.department, a.bank_name, a.recipient_name,
              a.bank_account_no, a.currency, a.status, a.current_step, a.purpose, a.manager_comment,
              a.decided_at, a.paid_at, a.created_at, u.username AS employee_username, fa.first_approved_at,
              l.line_date, l.db_no, l.expense_type, l.amount_cents, l.description, l.sort_order
       FROM cash_advance_lines l
       JOIN cash_advances a ON a.id = l.advance_id
       JOIN users u ON u.id = a.employee_id
       LEFT JOIN (SELECT h.advance_id, MAX(h.created_at) AS first_approved_at
                    FROM cash_advance_history h
                   WHERE (h.action LIKE 'approved — step 1 of %' OR h.action = 'approved')
                     AND h.created_at > COALESCE((SELECT MAX(s.created_at) FROM cash_advance_history s
                           WHERE s.advance_id = h.advance_id AND s.action IN ('submitted','resubmitted')),
                           '-infinity'::timestamptz)
                   GROUP BY h.advance_id) fa
              ON fa.advance_id = a.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.created_at, l.sort_order`, params);
    for (const r of rows) {
      // Show the manager/finance split for a pending realization; leave every other
      // advance status (realize_approved, settled, …) as its raw value, as before.
      const advStatus = (r.status === 'submitted' || r.status === 'realize_submitted')
        ? exportStatusLabel('submitted', r.current_step) : r.status;
      out.push({ key: iso(r.created_at) || '', cells: [
        'Cash advance', r.advance_no, r.employee_username, r.claimant_name, r.department,
        r.bank_name, r.recipient_name, r.bank_account_no, r.line_date, r.expense_type, r.db_no || '',
        (Number(r.amount_cents) / 100).toFixed(2), r.currency,
        r.description, advStatus, r.manager_comment, ts(r.first_approved_at), ts(r.decided_at), payDate(r.paid_at), ts(r.created_at)] });
    }
  }

  out.sort((a, b) => String(a.key).localeCompare(String(b.key)));

  const headers = ['Type', 'Claim No', 'Submitted By', 'Claimant Name', 'Department',
    'Bank Name', 'Recipient Name', 'Bank Account No', 'Date', 'Category', 'Site', 'Amount',
    'Currency', 'Description', 'Status', 'Manager Comment',
    ...['First Approved At', 'Decided At'].map(h => (zone ? h + ' (' + zone + ')' : h)),
    'Payment Date', zone ? 'Created At (' + zone + ')' : 'Created At'];
  const lines = [headers.map(csvCell).join(',')];
  for (const r of out) lines.push(r.cells.map(csvCell).join(','));

  const csv = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claims-${todayInZone(timezone)}.csv"`);
  res.send(csv);
}));

// The submitter picker for the export dialog. Deliberately separate from
// GET /api/users (which exposes full account records \u2014 bank details, approver
// chains \u2014 and is gated by account-management delegation): exporting only needs
// id / name / username, so this is gated by export_csv and returns nothing
// sensitive. Region-scoped to match what the export itself can include, so a
// region user never sees or filters on accounts outside their region.
router.get('/api/claim-submitters', requireAuth, requireCap('export_csv'), ah(async (req, res) => {
  const where = [];
  const params = [];
  if (!seesAllRegions(req.user)) { params.push(req.user.region || ''); where.push(`region = $${params.length}`); }
  const users = await q(
    `SELECT id, full_name, username FROM users
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY full_name`, params);
  res.json({ users });
}));

module.exports = router;
