'use strict';

// Insights: expense charts by type and over time, with drill-down.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Insights (expense charts)
// ---------------------------------------------------------------------------
$('#backHomeInsights').addEventListener('click', goHome);
$('#backHomeDc').addEventListener('click', goHome);

// Status presets offered in the Insights filter. "Approved + paid" is the
// default — it reflects real outflow (money that's been committed or moved).
const INSIGHT_STATUS_PRESETS = [
  { v: 'approved,paid', l: 'Approved + paid' },
  { v: 'paid', l: 'Paid only' },
  { v: 'approved', l: 'Approved only' },
  { v: 'submitted,approved,paid', l: 'All except rejected' },
  { v: 'submitted,approved,rejected,paid', l: 'All statuses' }
];

// The status preset a fresh Insights page starts on (see showApp's reset).
const INSIGHT_DEFAULT_STATUS = 'approved,paid';

function openInsights() {
  state.view = 'insights';
  $('#homeView').hidden = true;
  $('#listView').hidden = true;
  $('#insightsView').hidden = false;
  loadInsights();
}

async function loadInsights() {
  const body = $('#insightsBody');
  body.innerHTML = `<p class="muted" style="padding:28px 4px">${esc(t('Loading…'))}</p>`;
  const f = state.insights;
  const params = new URLSearchParams();
  if (f.year) params.set('year', f.year);
  if (f.month) params.set('month', f.month);
  if (f.department) params.set('department', f.department);
  if (f.db) params.set('db', f.db);
  if (f.name) params.set('name', f.name);
  if (f.status) params.set('status', f.status);
  if (state.viewRegion) params.set('region', state.viewRegion);
  try {
    const data = await api('/insights?' + params.toString());
    state.insights.data = data;
    state.insights.year = data.year || ''; // server may resolve to the latest year
    // Server echoes the month it applied ('' when the chosen month has no data in
    // the resolved year, e.g. after switching years), so mirror it back.
    state.insights.month = data.month || '';
    // Drop a department filter that isn't in this viewer's scope any more.
    if (f.department && !data.departments.includes(f.department)) state.insights.department = '';
    renderInsights();
  } catch (ex) {
    body.innerHTML = `<p class="form-error" style="margin:16px 0">${esc(ex.message)}</p>`;
  }
}

function renderInsights() {
  const d = state.insights.data;
  if (!d) return;
  const f = state.insights;
  const cur = d.currency || 'IDR';
  // A fresh dataset invalidates any open drill-down.
  f.drill = null;

  // Scope note in the header: a chosen department wins; otherwise it reflects the
  // viewer's remit (whole company vs. the claims they approve).
  const scopeEl = $('#insightsScope');
  const remit = d.scope.department
    ? d.scope.department
    : (d.scope.mode === 'all' ? t('Company-wide') : t('Claims you approve'));

  const yearOpts = (d.years.length ? d.years : [d.year])
    .map(y => `<option value="${esc(y)}"${y === d.year ? ' selected' : ''}>${esc(y)}</option>`).join('');
  // Month filter — lists only the months that have data in the selected year.
  const monthNames = I18N.months();
  const monthOpts = [`<option value="">${esc(t('All months'))}</option>`]
    .concat((d.months || []).map(m => {
      const nm = monthNames[parseInt(m, 10) - 1] || m;
      return `<option value="${esc(m)}"${m === d.month ? ' selected' : ''}>${esc(nm)}</option>`;
    })).join('');
  // Period label for the breakdown card's subtitle: month + year, or just year.
  const periodLabel = d.month ? `${monthNames[parseInt(d.month, 10) - 1] || d.month} ${d.year}` : String(d.year);
  // Header line: (region ·) scope · period · statuses — what every figure below covers.
  scopeEl.innerHTML = [state.viewRegion, remit, periodLabel, currentStatusLabel(f.status)]
    .filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
  // Filters that differ from a fresh Insights page (the year doesn't count: it
  // always holds a value). They drive the phone "Filters (n)" badge and Reset.
  const changed = [f.month, f.department, f.db, f.name, f.status !== INSIGHT_DEFAULT_STATUS ? 1 : ''].filter(Boolean).length;
  $('#insightsActs').innerHTML = changed
    ? `<button type="button" class="btn btn-ghost btn-sm" id="inReset">${esc(t('Reset filters'))}</button>` : '';
  const deptOpts = [`<option value="">${esc(t('All departments'))}</option>`]
    .concat(d.departments.map(x => `<option value="${esc(x)}"${x === f.department ? ' selected' : ''}>${esc(x)}</option>`)).join('');
  const statusOpts = INSIGHT_STATUS_PRESETS
    .map(o => `<option value="${o.v}"${o.v === f.status ? ' selected' : ''}>${esc(t(o.l))}</option>`).join('');
  const empList = d.employees || [];
  // A free-typed employee filter (not one of the listed names) is kept as a
  // synthetic option so the active filter still shows after a refetch.
  const nameExtra = (f.name && !empList.includes(f.name))
    ? `<option value="${esc(f.name)}" data-free="1" selected>${esc(f.name)}</option>` : '';
  const nameOpts = `<option value="">${esc(t('All employees'))}</option>` + nameExtra
    + empList.map(x => `<option value="${esc(x)}"${x === f.name ? ' selected' : ''}>${esc(x)}</option>`).join('');
  const dbOpts = [`<option value="">${esc(t('All DB numbers'))}</option>`]
    .concat((d.dbNos || []).map(x => `<option value="${esc(x)}"${x === f.db ? ' selected' : ''}>${esc(dbFmt(x))}</option>`)).join('');

  const k = d.kpis;
  // Each headline figure carries its change against the previous period (the
  // month before, or the year before; cut at the same day while this one runs).
  const p = d.prev || null;
  const prevLabel = p ? (p.month ? monthNames[parseInt(p.month, 10) - 1] : p.year) : '';
  const prevTitle = p ? t('Compared with {from} – {to}', { from: p.from, to: p.to }) : '';
  const delta = (curV, prevV) => p ? deltaChip(curV, prevV, prevLabel, prevTitle) : '';
  const kpiCards = [
    { l: t('Total spend'), v: moneyShort(k.total_cents / 100, cur), dl: delta(k.total_cents, p && p.total_cents) },
    { l: t('Claims'), v: String(k.claims), dl: delta(k.claims, p && p.claims) },
    { l: t('Avg per claim'), v: k.claims ? moneyShort(k.avg_cents / 100, cur) : '—', dl: delta(k.avg_cents, p && p.avg_cents) },
    { l: t('Top category'), v: k.top_type ? `${esc(k.top_type)} <span class="kpi-sub">${k.top_share}%</span>` : '—', dl: '' }
  ].map(c => `<div class="kpi"><div class="kpi-l">${esc(c.l)}</div><div class="kpi-v">${c.v}</div>${c.dl}</div>`).join('');
  const kpiNote = p && p.partial
    ? `<p class="in-note">${esc(t('{period} is still running, so changes compare with the same days of {prev} ({from} – {to}).', { period: periodLabel, prev: p.month ? `${prevLabel} ${p.year}` : p.year, from: p.from, to: p.to }))}</p>`
    : '';

  // Pipeline (as of now) and speed (for the selected period).
  const pl = d.pipeline || {};
  const sp = d.speed || {};
  const waitCard = (label, s) => {
    if (!s) return '';
    const foot = s.n
      ? [t(s.n === 1 ? '1 document' : '{n} documents', { n: s.n.toLocaleString() }),
         s.oldest_days != null ? t('oldest {n}', { n: s.oldest_days < 1 ? t('under a day') : daysLabel(s.oldest_days) }) : ''].filter(Boolean).join(' · ')
      : t('Nothing waiting');
    const flag = s.stale ? `<div class="kpi-flag">${esc(t(s.stale === 1 ? '1 waiting over a week' : '{n} waiting over a week', { n: s.stale.toLocaleString() }))}</div>` : '';
    return `<div class="kpi"><div class="kpi-l">${esc(label)}</div>
      <div class="kpi-v">${s.n ? esc(moneyShort(s.cents / 100, cur)) : '0'}</div>
      <div class="kpi-foot">${esc(foot)}</div>${flag}</div>`;
  };
  const speedCard = (label, s, doneLabel) => {
    if (!s) return '';
    const v = s.avg_days == null ? '—' : esc(daysLabel(s.avg_days));
    const foot = s.n ? t(doneLabel, { n: s.n.toLocaleString(), period: periodLabel }) : t('Nothing in {period}', { period: periodLabel });
    return `<div class="kpi"><div class="kpi-l">${esc(label)}</div><div class="kpi-v">${v}</div>
      <div class="kpi-foot">${esc(s.n ? t('Average') + ' · ' + foot : foot)}</div></div>`;
  };
  const flowCards = [
    waitCard(t('Awaiting approval'), pl.approval),
    waitCard(t('Awaiting payment'), pl.payment),
    speedCard(t('Time to approve'), sp.approve, '{n} approved in {period}'),
    speedCard(t('Time to pay'), sp.pay, '{n} paid in {period}')
  ].join('');

  // Who and where: ranked like the type chart. A card whose dimension is
  // already pinned by a filter would show one bar, so it steps aside.
  const rankCards = [
    !f.department && { dim: 'dept', title: t('Spend by department') },
    !f.name && { dim: 'name', title: t('Top employees') },
    !f.db && { dim: 'db', title: t('Spend by DB number') }
  ].filter(Boolean).map(c => `
      <div class="chart-card">
        <div class="chart-head"><div>
          <div class="chart-title">${esc(c.title)}</div>
          <div class="chart-sub">${esc(periodLabel)} · ${esc(t('Click a bar to see its expenses'))}</div>
        </div></div>
        <div id="rank-${c.dim}" class="type-bars"></div>
      </div>`).join('');

  $('#insightsBody').innerHTML = `
    <div class="in-toolbar">
      <button type="button" class="btn btn-ghost filter-toggle in-filter-toggle${changed ? ' has-active' : ''}" id="inFilterToggle" aria-expanded="${f.filtersOpen ? 'true' : 'false'}" aria-controls="inFilters">
        <span>${esc(t('Filters'))}</span> <span class="filter-count"${changed ? '' : ' hidden'}>${changed}</span>
      </button>
    </div>
    <div class="insights-filters${f.filtersOpen ? ' open' : ''}" id="inFilters">
      <label>${esc(t('Year'))}<select id="inYear" class="input">${yearOpts}</select></label>
      <label>${esc(t('Month'))}<select id="inMonth" class="input" data-search="never">${monthOpts}</select></label>
      ${d.departments.length ? `<label>${esc(t('Department'))}<select id="inDept" class="input">${deptOpts}</select></label>` : ''}
      <label>${esc(t('DB No'))}<select id="inDb" class="input" data-search="always">${dbOpts}</select></label>
      <label>${esc(t('Status'))}<select id="inStatus" class="input">${statusOpts}</select></label>
      <label>${esc(t('Employee'))}<select id="inName" class="input" data-freetext="always">${nameOpts}</select></label>
    </div>
    <div class="insights-kpis">${kpiCards}</div>
    ${kpiNote}
    <div class="in-section">
      <div class="in-section-h">${esc(t('Pipeline & speed'))}</div>
      <div class="in-section-sub">${esc(t('Waiting is as of now, whatever the status filter. Speed covers reimbursements and meal allowances in {period}.', { period: periodLabel }))}</div>
    </div>
    <div class="insights-kpis insights-flow">${flowCards}</div>
    <div class="insights-charts">
      <div class="chart-card">
        <div class="chart-head"><div>
          <div class="chart-title">${esc(t('Spend by expense type'))}</div>
          <div class="chart-sub">${esc(periodLabel)} · ${esc(currentStatusLabel(f.status))} · ${esc(t('Click a type to see its expenses'))}</div>
        </div></div>
        <div id="typeBars" class="type-bars"></div>
      </div>
      <div class="chart-card">
        <div class="chart-head">
          <div>
            <div class="chart-title">${esc(t('Total over time'))}</div>
            <div class="chart-sub" id="trendSub"></div>
          </div>
          <div class="seg" id="trendSeg">
            <button type="button" data-trend="month"${f.trend === 'month' ? ' class="on"' : ''}>${esc(t('Monthly'))}</button>
            <button type="button" data-trend="year"${f.trend === 'year' ? ' class="on"' : ''}>${esc(t('Yearly'))}</button>
          </div>
        </div>
        <div id="trendChart" class="trend-chart"></div>
      </div>
    </div>
    ${rankCards ? `<div class="insights-charts insights-ranks">${rankCards}</div>` : ''}`;

  state.insights.groups = {};
  renderTypeBars();
  renderRankBars('dept', d.byDept, k => k || t('No department'));
  renderRankBars('name', d.byEmployee, k => k || '—');
  renderRankBars('db', d.byDb, k => k ? dbFmt(k) : t('No DB'));
  renderTrend();

  // Filters — every one is a dropdown now, so all refetch on change.
  $('#inYear').addEventListener('change', e => { f.year = e.target.value; loadInsights(); });
  $('#inMonth').addEventListener('change', e => { f.month = e.target.value; loadInsights(); });
  const dept = $('#inDept'); if (dept) dept.addEventListener('change', e => { f.department = e.target.value; loadInsights(); });
  $('#inStatus').addEventListener('change', e => { f.status = e.target.value; loadInsights(); });
  $('#inDb').addEventListener('change', e => { const v = e.target.value.trim(); if (v !== f.db) { f.db = v; loadInsights(); } });
  $('#inName').addEventListener('change', e => { const v = e.target.value.trim(); if (v !== f.name) { f.name = v; loadInsights(); } });

  // Phones fold the filters behind a button; the open state survives the
  // re-render every filter change triggers.
  $('#inFilterToggle').addEventListener('click', () => {
    f.filtersOpen = !f.filtersOpen;
    $('#inFilters').classList.toggle('open', f.filtersOpen);
    $('#inFilterToggle').setAttribute('aria-expanded', String(f.filtersOpen));
  });
  const reset = $('#inReset');
  if (reset) reset.addEventListener('click', () => {
    Object.assign(f, { year: '', month: '', department: '', db: '', name: '', status: INSIGHT_DEFAULT_STATUS });
    loadInsights();
  });

  $$('#trendSeg button').forEach(b => b.addEventListener('click', () => {
    if (f.trend === b.dataset.trend) return;
    f.trend = b.dataset.trend;
    $$('#trendSeg button').forEach(x => x.classList.toggle('on', x.dataset.trend === f.trend));
    renderTrend();
  }));
}

function currentStatusLabel(v) {
  const p = INSIGHT_STATUS_PRESETS.find(o => o.v === v);
  return p ? t(p.l) : v;
}

// "▲ 12% vs Sep" under a KPI. Spending more isn't good or bad by itself, so the
// arrow carries the direction and the colour stays neutral.
function deltaChip(cur, prev, label, title) {
  if (!prev) {
    return `<div class="kpi-delta flat" title="${esc(title)}">${esc(t('None in {period}', { period: label }))}</div>`;
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '=';
  return `<div class="kpi-delta ${dir}" title="${esc(title)}"><b>${arrow} ${Math.abs(pct)}%</b> ${esc(t('vs {period}', { period: label }))}</div>`;
}

// "3.6 days" / "1 day" — whole numbers drop the decimal.
function daysLabel(n) {
  const v = Math.round(n * 10) / 10;
  return v === 1 ? t('1 day') : t('{n} days', { n: v.toLocaleString(undefined, { maximumFractionDigits: 1 }) });
}

// Ranked horizontal bars: spend by expense type, department, employee and DB
// number. Long tails past 10 rows fold into "Other". Each bar is clickable
// (pivot-style): it drills into the individual expense lines behind it.
// `state.insights.groups[dim]` maps each visible bar to the real key(s) it
// stands for (the "Other" bar covers the folded tail).
// Which detail-row field each chart groups by.
const INSIGHT_DIM_FIELD = { type: r => r.type, dept: r => r.dept || '', name: r => r.name || '', db: r => r.db || '' };

function renderTypeBars() {
  const d = state.insights.data;
  paintBars('type', $('#typeBars'), d.byType.map(x => ({ key: x.type, cents: x.cents })), k => k);
}
function renderRankBars(dim, items, labelOf) {
  const wrap = $('#rank-' + dim);
  if (!wrap) return; // card hidden because its own filter is set
  paintBars(dim, wrap, (items || []).map(x => ({ key: x.key, cents: x.cents })), labelOf);
}

function paintBars(dim, wrap, items, labelOf) {
  const d = state.insights.data;
  const cur = d.currency || 'IDR';
  // A fresh render of the bars starts with no open drill-down (the detail window,
  // if any, was already closed — it blocks the page while open).
  state.insights.drill = null;
  if (!items.length) {
    wrap.innerHTML = `<p class="muted chart-empty">${esc(t('No expenses match these filters.'))}</p>`;
    return;
  }
  // Fold everything past the top 9 into a single "Other" bar.
  let bars;
  if (items.length > 10) {
    const head = items.slice(0, 9).map(x => ({ label: labelOf(x.key), cents: x.cents, keys: [x.key] }));
    const tail = items.slice(9);
    head.push({ label: t('Other ({n})', { n: tail.length }), cents: tail.reduce((s, x) => s + x.cents, 0), keys: tail.map(x => x.key), other: true });
    bars = head;
  } else {
    bars = items.map(x => ({ label: labelOf(x.key), cents: x.cents, keys: [x.key] }));
  }
  state.insights.groups[dim] = bars;

  const max = Math.max(...bars.map(i => i.cents), 1);
  const sum = bars.reduce((x, i) => x + i.cents, 0) || 1;
  wrap.innerHTML = bars.map((i, idx) => {
    const pct = Math.max(2, Math.round((i.cents / max) * 100));
    return `<button type="button" class="bar-row" data-bar="${idx}"
      aria-pressed="false" title="${esc(t('Show expenses'))}: ${esc(i.label)}">
      <span class="bar-label">${esc(i.label)}</span>
      <span class="bar-track"><span class="bar-fill${i.other ? ' other' : ''}" style="width:${pct}%"></span></span>
      <span class="bar-val">${esc(moneyShort(i.cents / 100, cur))}<span class="bar-pct">${Math.round((i.cents / sum) * 100)}%</span></span>
    </button>`;
  }).join('');

  // Clicking a bar opens the drill-down as a modal window over the page. The
  // clicked bar stays highlighted underneath so it's clear which one is open;
  // the highlight is cleared when the window closes (see clearTypeDrill).
  wrap.querySelectorAll('.bar-row').forEach(b => b.addEventListener('click', () => {
    const idx = Number(b.dataset.bar);
    if (!state.insights.groups[dim] || !state.insights.groups[dim][idx]) return;
    state.insights.drill = { dim, idx };
    clearBarHighlight();
    b.classList.add('on');
    b.setAttribute('aria-pressed', 'true');
    renderTypeDetailModal();
  }));
}

function clearBarHighlight() {
  $$('#insightsBody .bar-row.on').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
}

// Active column sort for the drill-down table. Default: amount, largest first,
// which matches the server's default row ordering. dir 1 = ascending, -1 = desc.
let typeDetailSort = { key: 'amount', dir: -1 };
// Sort the drill-down rows in place by the active column, tie-breaking on the
// largest amount so equal keys stay in a stable, sensible order.
function sortTypeDetail(rows) {
  const { key, dir } = typeDetailSort;
  const val = {
    name: r => String(r.name || '').toLowerCase(),
    no:   r => String(r.no || '').toLowerCase(),
    date: r => String(r.date || ''),
    db:   r => String(r.db || '').toLowerCase(),
    dept: r => String(r.dept || '').toLowerCase(),
    type: r => String(r.type || '').toLowerCase(),
    amount: r => r.cents,
  }[key] || (r => r.cents);
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return b.cents - a.cents;
  });
}

// Clear the active drill-down: drop the highlighted bar and the selection.
// Runs whenever the detail window closes (its × / the scrim / Escape), so the
// insights page returns to a clean, un-highlighted state.
function clearTypeDrill() {
  state.insights.drill = null;
  clearBarHighlight();
}

// Drill-down for the selected bar — the individual expense lines behind it
// (employee, date, DB, amount, and the type or department when the chart isn't
// already grouped by it) — shown in a modal window over the insights page.
// Sortable by any column; each row opens its source claim. Rebuilt in place
// when a column is re-sorted.
function renderTypeDetailModal() {
  const d = state.insights.data;
  const sel = state.insights.drill;
  const bar = sel && (state.insights.groups[sel.dim] || [])[sel.idx];
  if (!bar) { closeModal(); return; }
  const label = bar.label;

  const cur = d.currency || 'IDR';
  const set = new Set(bar.keys);
  const field = INSIGHT_DIM_FIELD[sel.dim];
  const rows = (d.details || []).filter(r => set.has(field(r)));
  const total = rows.reduce((s, r) => s + r.cents, 0);
  sortTypeDetail(rows); // apply the active column sort (defaults to amount desc)

  // Columns: the chart's own dimension is the same on every row, so it's left
  // out — unless the bar is "Other", which spans several values.
  const multi = bar.keys.length > 1;
  const showName = sel.dim !== 'name' || multi;
  const showType = sel.dim !== 'type' || multi;
  const showDept = (sel.dim === 'dept' && multi) || sel.dim === 'name';
  const showDb = sel.dim !== 'db' || multi;
  // A clickable header cell that sorts by `key` and shows the active arrow.
  const th = (key, label, numeric) => {
    const on = typeDetailSort.key === key;
    const arrow = on ? (typeDetailSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${numeric ? ' num' : ''}" data-sort="${key}" role="button" tabindex="0" aria-sort="${on ? (typeDetailSort.dir === 1 ? 'ascending' : 'descending') : 'none'}" style="cursor:pointer;user-select:none;white-space:nowrap">${esc(label)}<span class="sort-arrow">${arrow}</span></th>`;
  };
  // The first column is the card's headline on phones (pv-name), so it's the
  // employee where shown, else the document number.
  const body = rows.length ? `
    <div class="type-detail-scroll">
      <table class="pivot-table">
        <thead><tr>
          ${showName ? th('name', t('Employee')) : ''}
          ${th('no', t('Doc No'))}
          ${th('date', t('Date'))}
          ${showDb ? th('db', t('DB No')) : ''}
          ${showDept ? th('dept', t('Department')) : ''}
          ${showType ? th('type', t('Type')) : ''}
          ${th('amount', t('Amount'), true)}
        </tr></thead>
        <tbody>${rows.map(r => `<tr${r.cid ? ` class="row-open" data-cid="${esc(r.cid)}" tabindex="0" role="button" title="${esc(t('Open claim'))}"` : ''}>
          ${showName ? `<td class="pv-name" data-label="${esc(t('Employee'))}">${esc(r.name || '—')}</td>` : ''}
          <td${showName ? '' : ' class="pv-name"'} data-label="${esc(t('Doc No'))}">${esc(r.no || '—')}</td>
          <td data-label="${esc(t('Date'))}">${esc(r.date || '—')}</td>
          ${showDb ? `<td data-label="${esc(t('DB No'))}">${esc(dbFmt(r.db) || '—')}</td>` : ''}
          ${showDept ? `<td data-label="${esc(t('Department'))}">${esc(r.dept || '—')}</td>` : ''}
          ${showType ? `<td data-label="${esc(t('Type'))}">${esc(r.type || '—')}</td>` : ''}
          <td class="num" data-label="${esc(t('Amount'))}">${esc(money(r.cents / 100, cur))}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : `<p class="muted chart-empty">${esc(t('No expenses match these filters.'))}</p>`;

  openModal(`
    <div class="modal-head">
      <div>
        <h2>${esc(label)}</h2>
        <p class="muted" style="margin:4px 0 0;font-size:.85rem">${esc({ type: t('Expense type'), dept: t('Department'), name: t('Employee'), db: t('DB No') }[sel.dim])} · ${esc(t('{n} expenses', { n: rows.length }))} · ${esc(money(total / 100, cur))}</p>
      </div>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body">${body}</div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  // Closing the window (×, scrim, or Escape) all route through closeModal, so
  // hook the highlight cleanup there rather than on the × alone.
  modalCloseHook = clearTypeDrill;
  $('#modal .x-btn').addEventListener('click', closeModal);

  // Clicking (or pressing Enter/Space on) a header sorts by that column; the same
  // header again flips the direction. Amount opens largest-first, text A→Z.
  const applySort = (key) => {
    if (typeDetailSort.key === key) typeDetailSort.dir *= -1;
    else typeDetailSort = { key, dir: key === 'amount' ? -1 : 1 };
    renderTypeDetailModal(); // rebuild the window in place with the new order
  };
  $$('#modal th[data-sort]').forEach(h => {
    h.addEventListener('click', () => applySort(h.dataset.sort));
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applySort(h.dataset.sort); } });
  });

  // Each detail row drills one level further: into the source claim itself. Close
  // this window first so the claim drawer opens cleanly on top of the page.
  // `cid` is prefixed by kind — c=reimbursement, m=meal, a=advance — mirroring
  // the insights SQL, so we split it back into (type, id) for the drawer.
  $$('#modal .row-open').forEach(tr => {
    const open = () => {
      const cid = tr.dataset.cid || '';
      const type = cid[0] === 'm' ? 'meal' : cid[0] === 'a' ? 'advance' : 'reimbursement';
      const id = cid.slice(1);
      if (!id) return;
      // Keep this drill-down window open behind the claim: open the drawer
      // elevated above the modal so closing it returns to the list.
      openDrawer(id, type).then(() => {
        $('#drawer').classList.add('over-modal');
        $('#drawerScrim').classList.add('over-modal');
      }).catch(ex => toast(ex.message, true));
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

// A dependency-free SVG line/area chart for the monthly / yearly trend, with a
// hover tooltip. Inline SVG inherits the theme CSS variables (var(--pine) etc.).
function renderTrend() {
  const d = state.insights.data;
  const cur = d.currency || 'IDR';
  const monthly = state.insights.trend === 'month';
  const monthNames = I18N.months();
  const points = monthly
    ? d.byMonth.map((m, i) => ({ label: monthNames[i], value: m.cents / 100 }))
    : d.byYear.map(y => ({ label: y.year, value: y.cents / 100 }));
  // Monthly view: last year's months as a dashed comparison line, when it has data.
  const prevYear = String(Number(d.year) - 1);
  const prevPts = (monthly && (d.byMonthPrev || []).some(m => m.cents > 0))
    ? d.byMonthPrev.map(m => m.cents / 100) : null;

  const sub = $('#trendSub');
  // Name the high point, so the chart's takeaway reads without hovering.
  const peak = points.reduce((best, p) => (p.value > (best ? best.value : 0) ? p : best), null);
  if (sub) sub.textContent = (monthly ? t('{year} · by month', { year: d.year }) : t('All years'))
    + (peak ? ' · ' + t('Peak: {label} ({amount})', { label: peak.label, amount: moneyShort(peak.value, cur) }) : '');

  const host = $('#trendChart');
  const hasData = points.some(p => p.value > 0);
  if (!points.length || !hasData) {
    host.innerHTML = `<p class="muted chart-empty">${esc(t('No expenses to plot for this period.'))}</p>`;
    return;
  }

  // Axis text lives in HTML around the SVG (SVG text shrinks with the chart).
  const W = 720, H = 220, padL = 10, padR = 12, padT = 8, padB = 6;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...points.map(p => p.value), ...(prevPts || []), 1);
  const n = points.length;
  const xAt = i => padL + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yAt = v => padT + plotH * (1 - v / max);

  // Three light horizontal gridlines + the baseline.
  let grid = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (plotH * g) / 3;
    grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="grid" />`;
  }
  const line = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
  const area = `M ${xAt(0).toFixed(1)},${(padT + plotH).toFixed(1)} L ${line.split(' ').join(' L ')} L ${xAt(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const prevLine = prevPts ? prevPts.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ') : '';
  // Emphasise the month currently picked in the Month filter (monthly view only).
  const selMo = (monthly && state.insights.month) ? (parseInt(state.insights.month, 10) - 1) : -1;
  const dots = points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="${i === selMo ? 5.5 : 3.5}" class="dot${i === selMo ? ' dot-sel' : ''}" />`).join('');
  const xlabels = points.map((p, i) =>
    `<span style="left:${((xAt(i) / W) * 100).toFixed(2)}%"${i === selMo ? ' class="on"' : ''}>${esc(p.label)}</span>`).join('');
  // Larger transparent hit targets drive the hover tooltip.
  const hits = points.map((p, i) =>
    `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="16" fill="transparent"
       data-x="${((xAt(i) / W) * 100).toFixed(2)}" data-y="${((yAt(p.value) / H) * 100).toFixed(2)}"
       data-lab="${esc(monthly ? `${p.label} ${d.year}` : p.label)}" data-val="${esc(money(p.value, cur))}"
       ${prevPts ? `data-prev="${esc(`${p.label} ${prevYear}: ${money(prevPts[i], cur)}`)}"` : ''} class="hit" />`).join('');

  host.innerHTML = `
    <div class="trend-tip" id="trendTip" hidden></div>
    <div class="trend-max">${esc(moneyShort(max, cur))}</div>
    <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="none" role="img"
         aria-label="${monthly ? 'Monthly' : 'Yearly'} expense total for ${esc(d.year)}">
      ${grid}
      <path d="${area}" class="area" />
      ${prevLine ? `<polyline points="${prevLine}" class="line-prev" />` : ''}
      <polyline points="${line}" class="line" />
      ${dots}
      ${hits}
    </svg>
    <div class="trend-x${n > 8 ? ' dense' : ''}" aria-hidden="true">${xlabels}</div>
    ${prevPts ? `<div class="trend-legend"><span class="lg-cur">${esc(d.year)}</span><span class="lg-prev">${esc(prevYear)}</span></div>` : ''}`;

  const tip = $('#trendTip');
  $$('#trendChart .hit').forEach(h => {
    h.addEventListener('mouseenter', () => {
      tip.innerHTML = `<span class="tip-lab">${esc(h.dataset.lab)}</span><span class="tip-val">${esc(h.dataset.val)}</span>`
        + (h.dataset.prev ? `<span class="tip-lab">${esc(h.dataset.prev)}</span>` : '');
      tip.style.left = h.dataset.x + '%';
      tip.style.top = h.dataset.y + '%';
      tip.hidden = false;
    });
    h.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}
