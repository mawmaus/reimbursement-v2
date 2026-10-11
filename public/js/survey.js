'use strict';

// Experience survey: the one-time questions after sign-in, and the Super Admin's results.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Experience survey — accounts that knew the paper process (created before
// August 2026) are asked once, right after signing in, to score paper vs
// digital (lib/survey.js). The window can't be closed until it's answered:
// while surveyLock is set, closeModal() and openModal() leave it in place (so
// the ×-less window survives the scrim, Escape and anything else opening). A
// Super Admin reads the results from the Regions screen.
// ---------------------------------------------------------------------------
const SURVEY_QUESTIONS = [
  { key: 'paper_score', text: 'From 1 to 10, how hard was it when reimbursing was still on paper and written by hand?', short: 'Paper, written by hand', lo: 'Very hard', hi: 'Very easy' },
  { key: 'digital_score', text: 'From 1 to 10, how hard is it to reimburse digitally now?', short: 'Digital, now', lo: 'Very hard', hi: 'Very easy' },
  { key: 'overall_score', text: 'From 1 to 10, how good is this digital reimbursement?', short: 'This portal overall', lo: 'Very bad', hi: 'Very good' }
];
let surveyLock = false;
function scheduleSurvey() {
  const u = state.user;
  if (!u || !u.survey_pending || surveyLock) return;
  if (!$('#drawer').hidden) closeDrawer();
  openSurvey();
}
function openSurvey() {
  const question = (item, i) => `
    <fieldset class="sv-q">
      <legend class="sv-legend"><span class="sv-num">${i + 1}</span><span>${esc(t(item.text))}</span></legend>
      <div class="sv-scale">${Array.from({ length: 10 }, (_, n) => `
        <label class="sv-opt"><input type="radio" name="${item.key}" value="${n + 1}" /><span>${n + 1}</span></label>`).join('')}
      </div>
      <div class="sv-ends"><span>1 · ${esc(t(item.lo))}</span><span>10 · ${esc(t(item.hi))}</span></div>
    </fieldset>`;
  openModal(`
    <div class="modal-head">
      <div><h2>${esc(t('Quick survey'))}</h2><p class="wn-sub">${esc(t('Three quick questions about reimbursing before and after the portal.'))}</p></div>
    </div>
    <form class="modal-body sv-body" id="surveyForm" novalidate>
      <p class="sv-scale-note">${esc(t('1 means very bad, 10 means very good.'))}</p>
      ${SURVEY_QUESTIONS.map(question).join('')}
      <p class="form-error" id="svErr" hidden></p>
      <div class="modal-actions sv-actions">
        <button type="submit" class="btn btn-primary" id="svSend" disabled>${esc(t('Send answers'))}</button>
      </div>
    </form>`);
  $('#modal').classList.add('modal-survey');
  surveyLock = true;
  const form = $('#surveyForm');
  const answers = () => SURVEY_QUESTIONS.map(item => form.querySelector(`input[name="${item.key}"]:checked`));
  form.addEventListener('change', () => { $('#svSend').disabled = answers().some(a => !a); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const picked = answers();
    if (picked.some(a => !a)) return;
    const body = Object.fromEntries(SURVEY_QUESTIONS.map((item, i) => [item.key, Number(picked[i].value)]));
    $('#svSend').disabled = true;
    try {
      await api('/survey', { method: 'POST', body: JSON.stringify(body) });
      if (state.user) state.user.survey_pending = false;
      surveyLock = false;
      closeModal();
      toast(t('Thank you for your feedback!'));
    } catch (ex) {
      const el = $('#svErr'); el.textContent = ex.message; el.hidden = false;
      $('#svSend').disabled = false;
    }
  });
}

// Super Admin: the results, stacked over the Regions screen.
const fmtScore = (v) => v == null ? '—' : Number(v).toFixed(1);
async function openSurveyResults() {
  openModal2(`
    <div class="modal-head">
      <div><h2>${esc(t('Survey results'))}</h2><p class="wn-sub" id="svrSub"></p></div>
      <button type="button" class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="modal-body" id="svrBody"><p class="muted">${esc(t('Loading…'))}</p></div>`);
  $('#modal2').classList.add('modal-wide');
  $('#modal2 .x-btn').addEventListener('click', closeModal2);
  let r;
  try { r = await api('/survey/results'); }
  catch (ex) { $('#svrBody').innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
  $('#svrSub').textContent = `${t('Accounts created before {date} are asked once.', { date: releaseDate(r.eligible_before) })} ${t('1 means very bad, 10 means very good.')}`;
  const people = r.people || [];
  const answered = people.filter(p => p.answered_at).length;
  const pct = r.eligible ? Math.round(answered / r.eligible * 100) : 0;
  const head = `
    <div class="svr-rate">
      <div class="svr-rate-text"><span>${esc(t('{n} of {total} accounts answered', { n: answered, total: r.eligible }))}</span><span class="svr-pct">${pct}%</span></div>
      <div class="svr-track"><span style="width:${Math.min(100, pct)}%"></span></div>
    </div>`;
  if (!r.responses) {
    $('#svrBody').innerHTML = `${head}<p class="rg-empty">${esc(t('No answers yet.'))}</p><div id="svpBox"></div>`;
    renderSurveyPeople(people);
    return;
  }
  const delta = Math.round((r.questions.digital_score.avg - r.questions.paper_score.avg) * 10) / 10;
  const verdict = delta > 0 ? t('Digital is rated {n} points easier than paper.', { n: delta.toFixed(1) })
    : delta < 0 ? t('Digital is rated {n} points harder than paper.', { n: Math.abs(delta).toFixed(1) })
    : t('Digital and paper are rated the same.');
  const card = (item) => {
    const qd = r.questions[item.key], max = Math.max(1, ...qd.dist);
    return `
      <section class="svr-card">
        <div class="svr-card-head">
          <div class="svr-q">${esc(t(item.short))}</div>
          <div class="svr-avg"><strong>${fmtScore(qd.avg)}</strong><span>/ 10</span></div>
        </div>
        <p class="svr-full">${esc(t(item.text))}</p>
        <div class="svr-bars" role="img" aria-label="${esc(qd.dist.map((c, i) => `${i + 1}: ${c}`).join(', '))}">${qd.dist.map((c, i) => `
          <div class="svr-bar" title="${i + 1}: ${c}"><span class="svr-count">${c || ''}</span><span class="svr-col"><span class="svr-fill" style="height:${c ? Math.max(6, c / max * 100) : 0}%"></span></span><span class="svr-tick">${i + 1}</span></div>`).join('')}
        </div>
      </section>`;
  };
  const regions = r.regions.length > 1 || (r.regions[0] && r.regions[0].region) ? `
    <div class="section-label">${esc(t('By region'))}</div>
    <div class="svr-table-wrap"><table class="svr-table">
      <thead><tr><th>${esc(t('Region'))}</th><th>${esc(t('Answers'))}</th><th>${esc(t('Paper'))}</th><th>${esc(t('Digital'))}</th><th>${esc(t('Overall'))}</th></tr></thead>
      <tbody>${r.regions.map(g => `<tr><td>${esc(regionLabel(g.region))}</td><td>${g.n}</td><td>${fmtScore(g.paper_score)}</td><td>${fmtScore(g.digital_score)}</td><td>${fmtScore(g.overall_score)}</td></tr>`).join('')}</tbody>
    </table></div>` : '';
  $('#svrBody').innerHTML = `${head}
    <p class="svr-verdict${delta > 0 ? ' up' : delta < 0 ? ' down' : ''}">${esc(verdict)}</p>
    <div class="svr-cards">${SURVEY_QUESTIONS.map(card).join('')}</div>
    ${regions}
    <div id="svpBox"></div>`;
  renderSurveyPeople(people);
}

// Who has answered, when, and their three scores. A filter (All / Answered /
// Not yet) and a name search narrow the list in place.
const SURVEY_SCORE_LABELS = [['paper_score', 'Paper'], ['digital_score', 'Digital'], ['overall_score', 'Overall']];
function renderSurveyPeople(people) {
  const box = $('#svpBox'); if (!box || !people.length) return;
  const done = people.filter(p => p.answered_at).length;
  let filter = 'all';
  box.innerHTML = `
    <div class="section-label">${esc(t('Who has answered'))}</div>
    <div class="svp-bar">
      ${helpSeg('svpSeg', [['all', t('All'), people.length], ['done', t('Answered'), done], ['todo', t('Not yet'), people.length - done]], filter)}
      <input id="svpSearch" class="input svp-search" type="search" placeholder="${esc(t('Search {noun}…', { noun: t('name') }))}" aria-label="${esc(t('Search {noun}…', { noun: t('name') }))}" />
    </div>
    <div class="svp-list" id="svpList"></div>`;
  const draw = () => {
    const q = $('#svpSearch').value.trim().toLowerCase();
    const rows = people.filter(p => (filter === 'all' || (filter === 'done') === !!p.answered_at)
      && (!q || String(p.full_name || '').toLowerCase().includes(q)));
    $('#svpList').innerHTML = rows.length ? rows.map(p => `
      <div class="svp-row">
        <div class="svp-who">
          <div class="svp-name">${esc(p.full_name || '—')}</div>
          <div class="svp-sub">${esc([regionLabel(p.region), p.department].filter(x => x && x !== '—').join(' · ') || '—')}</div>
        </div>
        ${p.answered_at && p.paper_score != null ? `<div class="svp-scores">${SURVEY_SCORE_LABELS.map(([k, label], i) => `
          <span class="svp-score" title="${esc(t(SURVEY_QUESTIONS[i].text))}"><span>${esc(t(label))}</span><strong>${p[k]}</strong></span>`).join('')}
        </div>` : ''}
        ${p.answered_at
          ? `<span class="svp-pill svp-done">${esc(t('Answered {date}', { date: releaseDate(String(p.answered_at).slice(0, 10)) }))}</span>`
          : `<span class="svp-pill svp-todo">${esc(t('Not yet'))}</span>`}
      </div>`).join('') : `<p class="svp-empty">${esc(t('No matches.'))}</p>`;
  };
  $('#svpSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    filter = b.dataset.v;
    $('#svpSeg').querySelectorAll('button').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    draw();
  });
  $('#svpSearch').addEventListener('input', draw);
  draw();
}
