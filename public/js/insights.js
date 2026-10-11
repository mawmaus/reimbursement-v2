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
  const kpiCards = [
    { l: t('Total spend'), v: moneyShort(k.total_cents / 100, cur) },
    { l: t('Claims'), v: String(k.claims) },
    { l: t('Top category'), v: k.top_type ? `${esc(k.top_type)} <span class="kpi-sub">${k.top_share}%</span>` : '—' },
    { l: t('Avg per claim'), v: k.claims ? moneyShort(k.avg_cents / 100, cur) : '—' }
  ].map(c => `<div class="kpi"><div class="kpi-l">${esc(c.l)}</div><div class="kpi-v">${c.v}</div></div>`).join('');

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
    </div>`;

  renderTypeBars();
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

// Horizontal bars for spend-by-type. Long tails past 10 rows fold into "Other".
// Each bar is clickable (pivot-style): it drills into the individual expense
// lines that make up that type. `typeGroups` maps each visible bar to the real
// expense type(s) it stands for (the "Other" bar covers the folded tail).
function renderTypeBars() {
  const d = state.insights.data;
  const cur = d.currency || 'IDR';
  const wrap = $('#typeBars');
  const items = d.byType.slice();
  // A fresh render of the bars starts with no open drill-down (the detail window,
  // if any, was already closed — it blocks the page while open), so clear any
  // stale selection before we paint the highlight below.
  state.insights.drill = null;
  if (!items.length) {
    wrap.innerHTML = `<p class="muted chart-empty">${esc(t('No expenses match these filters.'))}</p>`;
    return;
  }
  // Build the visible bars and, alongside, the label→real-types grouping used by
  // the drill-down. Fold everything past the top 9 into a single "Other" bar.
  let bars;
  if (items.length > 10) {
    const head = items.slice(0, 9).map(x => ({ label: x.type, cents: x.cents, types: [x.type] }));
    const tail = items.slice(9);
    head.push({ label: t('Other'), cents: tail.reduce((s, x) => s + x.cents, 0), types: tail.map(x => x.type) });
    bars = head;
  } else {
    bars = items.map(x => ({ label: x.type, cents: x.cents, types: [x.type] }));
  }
  state.insights.typeGroups = bars;

  const max = Math.max(...bars.map(i => i.cents), 1);
  const sum = bars.reduce((x, i) => x + i.cents, 0) || 1;
  wrap.innerHTML = bars.map((i, idx) => {
    const pct = Math.max(2, Math.round((i.cents / max) * 100));
    const on = state.insights.drill === i.label;
    return `<button type="button" class="bar-row${on ? ' on' : ''}" data-bar="${idx}"
      aria-pressed="${on ? 'true' : 'false'}" title="${esc(t('Show expenses'))}: ${esc(i.label)}">
      <span class="bar-label">${esc(i.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-val">${esc(moneyShort(i.cents / 100, cur))}<span class="bar-pct">${Math.round((i.cents / sum) * 100)}%</span></span>
    </button>`;
  }).join('');

  // Clicking a bar opens the drill-down as a modal window over the page. The
  // clicked bar stays highlighted underneath so it's clear which type is open;
  // the highlight is cleared when the window closes (see clearTypeDrill).
  $$('#typeBars .bar-row').forEach(b => b.addEventListener('click', () => {
    const idx = Number(b.dataset.bar);
    const bar = state.insights.typeGroups[idx];
    if (!bar) return;
    state.insights.drill = bar.label;
    $$('#typeBars .bar-row').forEach(x => {
      const on = Number(x.dataset.bar) === idx;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderTypeDetailModal();
  }));
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

// Clear the active drill-down: drop the highlighted bar and the selected type.
// Runs whenever the detail window closes (its × / the scrim / Escape), so the
// insights page returns to a clean, un-highlighted state.
function clearTypeDrill() {
  state.insights.drill = null;
  $$('#typeBars .bar-row').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
}

// Drill-down for the selected expense type — the individual expense lines behind
// that bar (employee, date, DB, amount) — shown in a modal window over the
// insights page rather than inline beneath the charts. Sortable by any column;
// each row opens its source claim. Rebuilt in place when a column is re-sorted.
function renderTypeDetailModal() {
  const d = state.insights.data;
  const label = state.insights.drill;
  const bar = (state.insights.typeGroups || []).find(g => g.label === label);
  if (!label || !bar) { closeModal(); return; }

  const cur = d.currency || 'IDR';
  const set = new Set(bar.types);
  const rows = (d.details || []).filter(r => set.has(r.type));
  const total = rows.reduce((s, r) => s + r.cents, 0);
  sortTypeDetail(rows); // apply the active column sort (defaults to amount desc)

  // The "Other" bar spans several types, so it gets an extra Type column.
  const showType = bar.types.length > 1;
  // A clickable header cell that sorts by `key` and shows the active arrow.
  const th = (key, label, numeric) => {
    const on = typeDetailSort.key === key;
    const arrow = on ? (typeDetailSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${numeric ? ' num' : ''}" data-sort="${key}" role="button" tabindex="0" aria-sort="${on ? (typeDetailSort.dir === 1 ? 'ascending' : 'descending') : 'none'}" style="cursor:pointer;user-select:none;white-space:nowrap">${esc(label)}<span class="sort-arrow">${arrow}</span></th>`;
  };
  const body = rows.length ? `
    <div class="type-detail-scroll">
      <table class="pivot-table">
        <thead><tr>
          ${th('name', t('Employee'))}
          ${th('no', t('Doc No'))}
          ${th('date', t('Date'))}
          ${th('db', t('DB No'))}
          ${showType ? th('type', t('Type')) : ''}
          ${th('amount', t('Amount'), true)}
        </tr></thead>
        <tbody>${rows.map(r => `<tr${r.cid ? ` class="row-open" data-cid="${esc(r.cid)}" tabindex="0" role="button" title="${esc(t('Open claim'))}"` : ''}>
          <td class="pv-name" data-label="${esc(t('Employee'))}">${esc(r.name || '—')}</td>
          <td data-label="${esc(t('Doc No'))}">${esc(r.no || '—')}</td>
          <td data-label="${esc(t('Date'))}">${esc(r.date || '—')}</td>
          <td data-label="${esc(t('DB No'))}">${esc(dbFmt(r.db) || '—')}</td>
          ${showType ? `<td data-label="${esc(t('Type'))}">${esc(r.type || '—')}</td>` : ''}
          <td class="num" data-label="${esc(t('Amount'))}">${esc(money(r.cents / 100, cur))}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : `<p class="muted chart-empty">${esc(t('No expenses match these filters.'))}</p>`;

  openModal(`
    <div class="modal-head">
      <div>
        <h2>${esc(label)}</h2>
        <p class="muted" style="margin:4px 0 0;font-size:.85rem">${esc(t('{n} expenses', { n: rows.length }))} · ${esc(money(total / 100, cur))}</p>
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
  const max = Math.max(...points.map(p => p.value), 1);
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
  // Emphasise the month currently picked in the Month filter (monthly view only).
  const selMo = (monthly && state.insights.month) ? (parseInt(state.insights.month, 10) - 1) : -1;
  const dots = points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="${i === selMo ? 5.5 : 3.5}" class="dot${i === selMo ? ' dot-sel' : ''}" />`).join('');
  const xlabels = points.map((p, i) =>
    `<span style="left:${((xAt(i) / W) * 100).toFixed(2)}%"${i === selMo ? ' class="on"' : ''}>${esc(p.label)}</span>`).join('');
  // Larger transparent hit targets drive the hover tooltip.
  const hits = points.map((p, i) =>
    `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="16" fill="transparent"
       data-x="${((xAt(i) / W) * 100).toFixed(2)}" data-y="${((yAt(p.value) / H) * 100).toFixed(2)}"
       data-lab="${esc(p.label)}" data-val="${esc(money(p.value, cur))}" class="hit" />`).join('');

  host.innerHTML = `
    <div class="trend-tip" id="trendTip" hidden></div>
    <div class="trend-max">${esc(moneyShort(max, cur))}</div>
    <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="none" role="img"
         aria-label="${monthly ? 'Monthly' : 'Yearly'} expense total for ${esc(d.year)}">
      ${grid}
      <path d="${area}" class="area" />
      <polyline points="${line}" class="line" />
      ${dots}
      ${hits}
    </svg>
    <div class="trend-x${n > 8 ? ' dense' : ''}" aria-hidden="true">${xlabels}</div>`;

  const tip = $('#trendTip');
  $$('#trendChart .hit').forEach(h => {
    h.addEventListener('mouseenter', () => {
      tip.innerHTML = `<span class="tip-lab">${h.dataset.lab}</span><span class="tip-val">${h.dataset.val}</span>`;
      tip.style.left = h.dataset.x + '%';
      tip.style.top = h.dataset.y + '%';
      tip.hidden = false;
    });
    h.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}
