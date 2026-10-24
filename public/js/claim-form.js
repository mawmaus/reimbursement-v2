'use strict';

// New / edit reimbursement claim, local drafts, and the shell all the forms share.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// New / Edit claim
// ---------------------------------------------------------------------------
let pendingFiles = [];
// On edit & resubmit, the receipts already on the claim, as { id, original_name }.
// The claimant can remove them in the form; whatever survives is sent back as
// keep_attachment_ids and the server drops the rest.
let keptAttachments = [];
let keptClaimId = null;   // claim being edited, for the kept chips' view links

// Render a <select> when the admin has configured options, otherwise a plain
// text input so claims can still be submitted before settings are populated.
function lookupField(name, label, value, options, attrs = '') {
  const cur = value || '';
  if (!options.length) {
    return `<label>${label}<input name="${name}" required ${attrs} value="${esc(cur)}" /></label>`;
  }
  const opts = [...options];
  if (cur && !opts.includes(cur)) opts.unshift(cur); // keep an existing value that was since removed
  return `<label>${label}
    <select name="${name}" required>
      <option value="" ${cur ? '' : 'selected'} disabled>${esc(t('Select…'))}</option>
      ${opts.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select></label>`;
}

// The claim's expense type: the configured list plus an "Others" option that
// reveals a free-text field. When settings have no expense types yet, fall back
// to a plain text input (same behaviour as lookupField). A stored value that
// isn't a configured option is treated as a previous "Others" entry so editing
// keeps it. Wiring (show/hide) is done by wireExpenseTypeField after render.
function expenseTypeField(value) {
  const options = state.lookups.expense_types;
  const cur = value || '';
  if (!options.length) {
    return `<label>${esc(t('Type of expense'))}<input name="expense_type" required placeholder="${esc(t('Travel, Meals, Supplies…'))}" value="${esc(cur)}" /></label>`;
  }
  const isOther = !!cur && !options.some(o => o.toLowerCase() === cur.toLowerCase());
  const selectVal = isOther ? 'Others' : cur;
  // A searchable combobox: a text box filters the list, and a hidden input holds
  // the chosen value (so form submission + the "Others" flow are unchanged). The
  // hidden field is validated in submitClaim, not via native `required`.
  return `<label>${esc(t('Type of expense'))}
      <div class="combo" id="expCombo">
        <input type="text" id="expSearch" class="combo-input" role="combobox"
               aria-autocomplete="list" aria-expanded="false" aria-controls="expList"
               autocomplete="off" placeholder="${esc(t('Search or select…'))}" value="${esc(selectVal)}" />
        <input type="hidden" name="expense_type" id="expType" value="${esc(selectVal)}" />
        <ul class="combo-list" id="expList" role="listbox" hidden></ul>
      </div></label>
    <label class="full" id="expOtherWrap" ${isOther ? '' : 'hidden'}>${esc(t('Please specify the expense type'))}
      <input name="expense_type_other" id="expOther" value="${isOther ? esc(cur) : ''}" placeholder="${esc(t('Enter the expense type'))}" /></label>`;
}
// Wire the expense-type combobox: filter-as-you-type, click/keyboard select, and
// the "Others" free-text reveal. Options are the configured types plus "Others".
function wireExpenseTypeField() {
  const search = $('#expSearch');
  if (!search) return; // no-options fallback renders a plain text input
  const hidden = $('#expType'), list = $('#expList'), combo = $('#expCombo');
  const wrap = $('#expOtherWrap'), other = $('#expOther');
  const OPTIONS = state.lookups.expense_types.concat(['Others']);
  let filtered = OPTIONS.slice();
  let active = -1;

  const syncOther = () => {
    const on = hidden.value === 'Others';
    wrap.hidden = !on;
    if (other) other.required = on;
  };
  const render = () => {
    list.innerHTML = filtered.length
      ? filtered.map((o, i) => `<li class="combo-item${i === active ? ' active' : ''}" role="option"
          data-val="${esc(o)}" aria-selected="${o === hidden.value}">${esc(o)}</li>`).join('')
      : `<li class="combo-empty" aria-disabled="true">${esc(t('No matches'))}</li>`;
  };
  const open = () => { list.hidden = false; search.setAttribute('aria-expanded', 'true'); combo.classList.add('open'); };
  const close = () => { list.hidden = true; search.setAttribute('aria-expanded', 'false'); combo.classList.remove('open'); active = -1; };
  const filter = (term) => {
    const t = term.trim().toLowerCase();
    filtered = t ? OPTIONS.filter(o => o.toLowerCase().includes(t)) : OPTIONS.slice();
    active = filtered.length ? 0 : -1;
    render();
  };
  const commit = (val) => {
    hidden.value = val; search.value = val;
    syncOther(); close();
    if (val === 'Others' && other) other.focus();
  };
  const scrollActive = () => { const el = list.querySelector('.combo-item.active'); if (el) el.scrollIntoView({ block: 'nearest' }); };

  search.addEventListener('focus', () => { filter(''); search.select(); open(); });
  search.addEventListener('input', () => { filter(search.value); open(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) { filter(search.value); open(); } else { active = Math.min(active + 1, filtered.length - 1); render(); }
      scrollActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); active = Math.max(active - 1, 0); render(); scrollActive();
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0 && filtered[active]) { e.preventDefault(); commit(filtered[active]); }
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); close(); }
    }
  });
  // mousedown (not click) so it fires before the input's blur, avoiding a race.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.combo-item');
    if (!li) return;
    e.preventDefault();
    commit(li.dataset.val);
  });
  // On blur, snap the visible text back to the committed value (never leave a
  // half-typed non-selection on screen).
  search.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== search) { search.value = hidden.value; close(); }
  }, 0));

  syncOther();
}

// Optional inline calculator on the claim form: a running tally that lets a
// claimant add up several receipt amounts and drop the sum into the Amount field.
function calcPanelHtml() {
  return `<div class="calc-panel" id="calcPanel" hidden>
    <div class="calc-input-row">
      <input id="calcInput" inputmode="decimal" placeholder="${esc(t('Add an amount…'))}" />
      <button type="button" class="btn btn-ghost btn-sm" id="calcAdd">${esc(t('Add'))}</button>
    </div>
    <ul class="calc-list" id="calcList"></ul>
    <div class="calc-foot">
      <div class="calc-total-wrap"><span>${esc(t('Total'))}</span><strong id="calcTotal">0</strong></div>
      <div class="calc-foot-btns">
        <button type="button" class="btn btn-ghost btn-sm" id="calcClear">${esc(t('Clear'))}</button>
        <button type="button" class="btn btn-primary btn-sm" id="calcApply">${esc(t('Use total'))}</button>
      </div>
    </div>
  </div>`;
}

function wireClaimCalculator() {
  const toggle = $('#calcToggle'), panel = $('#calcPanel');
  if (!toggle || !panel) return;
  let entries = [];
  const sum = () => entries.reduce((a, b) => a + b, 0);
  const render = () => {
    $('#calcList').innerHTML = entries.length
      ? entries.map((n, i) =>
          `<li><span class="mono">${groupAmount(String(n))}</span>
             <button type="button" data-i="${i}" aria-label="${esc(t('Remove'))}">×</button></li>`).join('')
      : `<li class="calc-empty">${esc(t('No amounts added yet.'))}</li>`;
    $('#calcTotal').textContent = groupAmount(String(sum())) || '0';
    $$('#calcList button[data-i]').forEach(b =>
      b.addEventListener('click', () => { entries.splice(+b.dataset.i, 1); render(); }));
  };
  const add = () => {
    const inp = $('#calcInput');
    const n = Number(String(inp.value).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) entries.push(n);
    inp.value = ''; inp.focus(); render();
  };
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) $('#calcInput').focus();
  });
  $('#calcAdd').addEventListener('click', add);
  $('#calcInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });
  $('#calcInput').addEventListener('input', e => { e.target.value = groupAmount(e.target.value); });
  $('#calcApply').addEventListener('click', () => {
    const amt = $('#claimForm [name="amount"]');
    if (amt) amt.value = groupAmount(String(sum()));
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  });
  $('#calcClear').addEventListener('click', () => { entries = []; render(); });
  render();
}

// When the signed-in account has two or more chooseable Approver 1 candidates,
// render a required picker of them. With one candidate it is used automatically
// (no picker), and with none the approver chain is fixed — both return ''. On
// resubmit, preselect the claim's existing first approver if it is still one of
// the candidates.
function approver1PickerHtml(existing) {
  const choices = (state.user && state.user.approver1_choices) || [];
  if (choices.length < 2) return '';
  const preId = existing && existing.approvers && existing.approvers[0] ? String(existing.approvers[0].id) : '';
  const opts = ['<option value="" disabled' + (preId ? '' : ' selected') + '>' + esc(t('Choose an approver…')) + '</option>']
    .concat(choices.map(c => `<option value="${c.id}" ${String(c.id) === preId ? 'selected' : ''}>${esc(c.name)}</option>`));
  return `<label class="full">${reqLabel(t('Approver 1'))}
    <select name="approver1" required>${opts.join('')}</select></label>`;
}

// A reimbursement claim is an editable table: one row per expense (date, DB no,
// type, amount, description) with that expense's own receipts. Files/kept
// attachments live on the row objects (never in the DOM) so re-rendering the
// table preserves them.
let claimRows = [];
let claimEditId = null;   // claim being edited, for the kept-receipt view links
// Base API path for kept-receipt links in the shared line editor. Reimbursement
// claims use /api/claims; the cash-advance realization form flips it to
// /api/cash-advances so kept receipts open from the right endpoint.
let rcAttachBase = '/api/claims';
// Optional callback fired whenever the shared line editor's total changes, so the
// realization form can refresh its "advance vs spent" difference banner.
let rcTotalHook = null;
const rcAmt = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };
function claimTotal() { return claimRows.reduce((sum, r) => sum + rcAmt(r.amount), 0); }
const blankClaimRow = (date = '') => ({ line_date: date, db_no: '', expense_type: '', expense_type_other: '', amount: '', description: '', files: [], kept: [] });

function rcChips(r, i) {
  const kept = (r.kept || []).map((a, k) =>
    `<span class="file-chip file-chip-saved"><a href="${rcAttachBase}/${claimEditId}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.original_name)}</a>` +
    `<button type="button" data-chip="kept" data-row="${i}" data-k="${k}" aria-label="${esc(t('Remove'))}">×</button></span>`);
  const files = (r.files || []).map((f, k) =>
    `<span class="file-chip">${esc(f.name)}<button type="button" data-chip="new" data-row="${i}" data-k="${k}" aria-label="${esc(t('Remove'))}">×</button></span>`);
  return kept.concat(files).join('');
}
// Expense-type picker for a row: a native <select> (clean, and its dropdown is
// never clipped by the scrolling table). "Others" is always offered and reveals
// a free-text field. A legacy custom value is preserved as its own option.
function rcTypeSelect(r) {
  const cur = r.expense_type || '';
  const opts = [...(state.lookups.expense_types || [])];
  if (!opts.some(o => o.toLowerCase() === 'others')) opts.push('Others');
  const extra = (cur && cur !== 'Others' && !opts.includes(cur)) ? cur : null;
  return `<select name="expense_type">
      <option value="" ${cur ? '' : 'selected'}>${esc(t('Select…'))}</option>
      ${extra ? `<option value="${esc(extra)}" selected>${esc(extra)}</option>` : ''}
      ${opts.map(o => `<option value="${esc(o)}" ${o === cur ? 'selected' : ''}>${esc(o === 'Others' ? t('Others (specify)') : o)}</option>`).join('')}
    </select>
    <input name="expense_type_other" class="rc-other" value="${esc(r.expense_type_other || '')}" placeholder="${esc(t('Specify the expense…'))}" ${cur === 'Others' ? '' : 'hidden'} />`;
}
// A "DB number" field. The user first chooses No DB or With DB; picking With DB
// reveals a numbers-only box with a fixed grey "DB" prefix (no spaces). The
// combined value is stored back as "DB <digits>" (or "" for No DB) so every
// downstream reader — the line tables, the PDF export and the DB filter — keeps
// working unchanged. Shared by the meal, reimbursement and realization editors.
function dbParse(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { on: false, digits: '' };
  return { on: true, digits: s.replace(/\D/g, '') };
}
function dbCombine(on, digits) {
  const d = String(digits || '').replace(/\D/g, '');
  return on ? (d ? 'DB ' + d : 'DB') : '';
}
// Display a stored DB string ("DB 200231") with no space → "DB200231". Purely
// cosmetic: the stored value keeps its space so filters/search/PDF stay uniform
// across old and new claims; only what the reader sees is tightened.
const dbFmt = v => String(v == null ? '' : v).replace(/\s+/g, '');
function dbCellHtml(value) {
  const { on, digits } = dbParse(value);
  return `<div class="db-cell">
    <select class="db-mode">
      <option value="no" ${on ? '' : 'selected'}>${esc(t('No DB'))}</option>
      <option value="yes" ${on ? 'selected' : ''}>${esc(t('With DB'))}</option>
    </select>
    <div class="db-entry" ${on ? '' : 'hidden'}>
      <span class="db-prefix" aria-hidden="true">DB</span>
      <input class="db-num" inputmode="numeric" autocomplete="off" value="${esc(digits)}"
        aria-label="${esc(t('DB number'))}" placeholder="500309" />
    </div>
  </div>`;
}
// Read a DB cell (identified by its .db-mode/.db-num children) back into the
// combined stored string.
function dbCellRead(tr) {
  const sel = tr.querySelector('.db-mode'), num = tr.querySelector('.db-num');
  return dbCombine(sel ? sel.value === 'yes' : false, num ? num.value : '');
}
// Wire every DB cell inside `scope`: the select toggles the numbers box, and the
// box strips anything that isn't a digit (so spaces are impossible).
function wireDbCells(scope) {
  $$(scope + ' .db-cell').forEach(cell => {
    const sel = cell.querySelector('.db-mode');
    const entry = cell.querySelector('.db-entry');
    const num = cell.querySelector('.db-num');
    if (!sel || !entry || !num) return;
    sel.addEventListener('change', () => {
      const on = sel.value === 'yes';
      entry.hidden = !on;
      if (on) num.focus();
    });
    num.addEventListener('input', () => {
      const clean = num.value.replace(/[^0-9]/g, '');
      if (clean !== num.value) num.value = clean;
    });
  });
}

function claimRowHtml(r, i) {
  return `<tr data-i="${i}" data-n="${esc(t('Line {n}', { n: i + 1 }))}">
    <td data-label="${esc(t('Date'))}">${claimDateInput('line_date', r.line_date, r.carried)}</td>
    <td data-label="${esc(t('DB No.'))}">${dbCellHtml(r.db_no)}</td>
    <td data-label="${esc(t('Type of expense'))}">${rcTypeSelect(r)}</td>
    <td data-label="${esc(t('Amount'))}"><div class="rc-amt-wrap">
      <input name="amount" class="rc-amt" inputmode="decimal" value="${esc(r.amount == null ? '' : groupAmount(String(r.amount)))}" placeholder="0" />
      <button type="button" class="rc-calc" data-calc="${i}" title="${esc(t('Add up amounts'))}" aria-label="${esc(t('Add up amounts'))}">🧮</button>
    </div></td>
    <td data-label="${esc(t('Description / purpose'))}"><input name="description" value="${esc(r.description || '')}" placeholder="${esc(t('What was this for?'))}" /></td>
    <td class="rc-receipts" data-label="${esc(t('Receipts'))}">
      <div class="file-chips">${rcChips(r, i)}</div>
      <div class="rc-pick">
        <button type="button" class="btn btn-ghost btn-sm rc-add rc-cam" data-add="${i}" data-cam>📷 ${esc(t('Take photo'))}</button>
        <button type="button" class="btn btn-ghost btn-sm rc-add" data-add="${i}">📎 ${esc(t('Add'))}</button>
      </div>
      <input type="file" class="rc-input" data-input="${i}" multiple hidden accept=".pdf,image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif" />
    </td>
    <td class="meal-x"><button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove'))}">×</button></td>
  </tr>`;
}
// Copy scalar fields from the DOM back into claimRows before any re-render, so
// files/kept (not in the DOM) survive.
function readClaimRows() {
  $$('#rcRows tr[data-i]').forEach(tr => {
    const i = +tr.dataset.i, r = claimRows[i]; if (!r) return;
    const g = (n) => { const el = tr.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
    r.line_date = g('line_date'); r.db_no = dbCellRead(tr); r.expense_type = g('expense_type');
    r.expense_type_other = g('expense_type_other'); r.amount = g('amount'); r.description = g('description');
  });
}
// Point a validation error at its line: "Line 2: …" in the form's error box,
// the row outlined, scrolled into view and its field focused — on a phone the
// faulty line is usually off-screen in the scrolling list.
function flagClaimRow(err, r, msg, field) {
  const i = claimRows.indexOf(r);
  err.textContent = i >= 0 ? `${t('Line {n}', { n: i + 1 })}: ${msg}` : msg;
  err.hidden = false;
  $$('#rcRows tr.row-err').forEach(tr => tr.classList.remove('row-err'));
  const tr = $(`#rcRows tr[data-i="${i}"]`); if (!tr) return;
  tr.classList.add('row-err');
  tr.addEventListener('input', () => tr.classList.remove('row-err'), { once: true });
  tr.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  const el = field && tr.querySelector(`[name="${field}"]`);
  if (el) el.focus({ preventScroll: true });
}
function renderClaimRows() {
  const body = $('#rcRows');
  body.innerHTML = claimRows.length
    ? claimRows.map(claimRowHtml).join('')
    : `<tr><td colspan="7" class="muted" style="padding:14px;text-align:center">${esc(t('No rows yet — add one below.'))}</td></tr>`;
  $('#rcTotal').textContent = liveAmt(claimTotal());
  syncLineCount(claimRows.filter(r => rcAmt(r.amount) > 0).length);
  if (rcTotalHook) rcTotalHook();
  $$('#rcRows [data-rm]').forEach(b => b.addEventListener('click', () => {
    readClaimRows(); claimRows.splice(+b.dataset.rm, 1); renderClaimRows();
  }));
  $$('#rcRows .rc-add').forEach(b => b.addEventListener('click', () => {
    const inp = $(`#rcRows .rc-input[data-input="${b.dataset.add}"]`); if (inp) pickFiles(inp, b.hasAttribute('data-cam'));
  }));
  $$('#rcRows .rc-input').forEach(inp => inp.addEventListener('change', async () => {
    const i = +inp.dataset.input, r = claimRows[i]; if (!r) return;
    const accepted = await processFiles(inp.files, (r.files || []).length + (r.kept || []).length);
    r.files = (r.files || []).concat(accepted);
    readClaimRows(); renderClaimRows();
  }));
  $$('#rcRows [data-chip]').forEach(b => b.addEventListener('click', () => {
    const r = claimRows[+b.dataset.row]; if (!r) return;
    (b.dataset.chip === 'kept' ? r.kept : r.files).splice(+b.dataset.k, 1);
    readClaimRows(); renderClaimRows();
  }));
  $$('#rcRows .rc-amt').forEach(el => el.addEventListener('input', () => {
    el.value = groupAmount(el.value); // thousands separators as they type
    readClaimRows(); $('#rcTotal').textContent = liveAmt(claimTotal());
    syncLineCount(claimRows.filter(r => rcAmt(r.amount) > 0).length); if (rcTotalHook) rcTotalHook();
  }));
  // Reveal the "specify" field when the type is set to Others.
  $$('#rcRows select[name="expense_type"]').forEach(sel => sel.addEventListener('change', () => {
    const other = sel.closest('td').querySelector('.rc-other');
    if (other) { other.hidden = sel.value !== 'Others'; if (!other.hidden) other.focus(); }
  }));
  // Per-row calculator: tally amounts and drop the sum into this row's Amount.
  $$('#rcRows .rc-calc').forEach(b => b.addEventListener('click', () => openCalcModal(+b.dataset.calc)));
  wireDbCells('#rcRows');
}

// A small calculator (over the claim form) that adds up several amounts and
// writes the total into row `rowIndex`'s Amount field.
function openCalcModal(rowIndex) {
  let entries = [];
  const sum = () => entries.reduce((a, b) => a + b, 0);
  openModal2(`
    <div class="modal-head"><h2>${esc(t('Add up amounts'))}</h2><button class="x-btn" id="calcClose">×</button></div>
    <div class="modal-body">
      <div class="calc-input-row">
        <input id="calcInput" inputmode="decimal" placeholder="${esc(t('Add an amount…'))}" />
        <button type="button" class="btn btn-ghost btn-sm" id="calcAdd">${esc(t('Add'))}</button>
      </div>
      <ul class="calc-list" id="calcList"></ul>
      <div class="calc-foot">
        <div class="calc-total-wrap"><span>${esc(t('Total'))}</span><strong id="calcTotal">0</strong></div>
        <div class="calc-foot-btns">
          <button type="button" class="btn btn-ghost btn-sm" id="calcClear">${esc(t('Clear'))}</button>
          <button type="button" class="btn btn-primary btn-sm" id="calcApply">${esc(t('Use total'))}</button>
        </div>
      </div>
    </div>`);
  const render = () => {
    $('#calcList').innerHTML = entries.length
      ? entries.map((n, i) =>
          `<li><span class="mono">${groupAmount(String(n))}</span>
             <button type="button" data-i="${i}" aria-label="${esc(t('Remove'))}">×</button></li>`).join('')
      : `<li class="calc-empty">${esc(t('No amounts added yet.'))}</li>`;
    $('#calcTotal').textContent = groupAmount(String(sum())) || '0';
    $$('#calcList button[data-i]').forEach(b =>
      b.addEventListener('click', () => { entries.splice(+b.dataset.i, 1); render(); }));
  };
  const add = () => {
    const inp = $('#calcInput');
    const n = Number(String(inp.value).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) entries.push(n);
    inp.value = ''; inp.focus(); render();
  };
  $('#calcClose').addEventListener('click', closeModal2);
  $('#calcAdd').addEventListener('click', add);
  $('#calcInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  $('#calcInput').addEventListener('input', e => { e.target.value = groupAmount(e.target.value); });
  $('#calcClear').addEventListener('click', () => { entries = []; render(); });
  $('#calcApply').addEventListener('click', () => {
    readClaimRows();
    if (claimRows[rowIndex]) claimRows[rowIndex].amount = String(sum());
    closeModal2();
    renderClaimRows();
  });
  render();
  setTimeout(() => { const inp = $('#calcInput'); if (inp) inp.focus(); }, 0);
}

// ---------------------------------------------------------------------------
// Local drafts — an unsent "New claim" / "New meal allowance" / "New cash
// advance" form is kept in the browser so a mis-click, an accidental close, or
// a reload never throws the work away. Drafts are stored per signed-in user (so
// they never leak between accounts sharing a device) and per form type. The
// typed fields go to localStorage; a claim's receipt files can't be serialized
// there, so those File objects are stored in IndexedDB (which holds Blobs
// natively) and re-hydrated onto the rows when the draft reopens.
//
// Two ways in: an explicit "Save draft" button, and an automatic save whenever
// the form is closed by its × / the scrim / Escape while it has content (the
// mis-click case). Pressing "Cancel" is treated as a deliberate discard, and a
// successful submit clears the draft. A reopened form shows a banner with a
// "Start fresh" option to drop the draft.
// ---------------------------------------------------------------------------
const DRAFT_BTN = { claim: '#newClaimBtn', meal: '#newMealBtn', mealgps: '#newMealGpsBtn', advance: '#newAdvanceBtn' };
function draftKey(kind) { return `draft:${kind}:${state.user ? state.user.id : 'anon'}`; }
function loadDraft(kind) {
  try { const raw = localStorage.getItem(draftKey(kind)); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function saveDraftData(kind, data) {
  try { localStorage.setItem(draftKey(kind), JSON.stringify({ savedAt: Date.now(), data })); }
  catch { /* storage full / disabled — nothing more we can do */ }
  refreshDraftBadges();
}
function clearDraft(kind) {
  try { localStorage.removeItem(draftKey(kind)); } catch { /* ignore */ }
  clearDraftFiles(kind); // drop any stored receipt blobs alongside the fields
  refreshDraftBadges();
}

// Receipt blobs for a claim draft live in IndexedDB, keyed by the same draftKey
// as the typed fields. localStorage can't hold File objects; IndexedDB stores
// them (and their name/type) natively via structured clone. Every op is
// best-effort — if IndexedDB is unavailable (private mode, disabled), the draft
// still keeps its typed fields and just loses the attachments.
const DRAFT_DB = 'reimbursement-drafts';
const DRAFT_STORE = 'files';
function draftDbOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DRAFT_DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(DRAFT_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// `rowsFiles` is a per-row array of File arrays, aligned index-for-index with the
// draft's saved rows so each receipt returns to the row it was attached to.
async function saveDraftFiles(kind, rowsFiles) {
  try {
    const db = await draftDbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readwrite');
      tx.objectStore(DRAFT_STORE).put(rowsFiles, draftKey(kind));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* IndexedDB unavailable — typed fields still saved */ }
}
async function loadDraftFiles(kind) {
  try {
    const db = await draftDbOpen();
    const val = await new Promise((resolve, reject) => {
      const tx = db.transaction(DRAFT_STORE, 'readonly');
      const rq = tx.objectStore(DRAFT_STORE).get(draftKey(kind));
      rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error);
    });
    db.close();
    return Array.isArray(val) ? val : null;
  } catch { return null; }
}
function clearDraftFiles(kind) {
  draftDbOpen().then(db => {
    const tx = db.transaction(DRAFT_STORE, 'readwrite');
    tx.objectStore(DRAFT_STORE).delete(draftKey(kind));
    tx.oncomplete = () => db.close();
  }).catch(() => { /* ignore */ });
}
// Show a small dot on a "New …" button whenever that form has a saved draft, so
// the claimant can see one is waiting and reopen it.
function refreshDraftBadges() {
  for (const kind of Object.keys(DRAFT_BTN)) {
    const btn = $(DRAFT_BTN[kind]); if (!btn) continue;
    btn.classList.toggle('has-draft', !!loadDraft(kind));
  }
  syncNewMenu();
}

// The banner shown at the top of a form that was reopened from a saved draft.
// `note` is an optional extra line (used to remind claim drafts to re-attach
// receipts).
function draftBannerHtml(note) {
  return `<div class="draft-banner" id="draftBanner">
    <span class="draft-banner-txt">📝 ${esc(t('Picked up from your saved draft.'))}${note ? ' ' + esc(note) : ''}</span>
    <button type="button" class="draft-discard" id="draftDiscard">${esc(t('Start fresh'))}</button>
  </div>`;
}
// Wire the banner's "Start fresh": drop the draft and reopen the form empty.
function wireDraftBanner(kind, reopen) {
  const b = $('#draftDiscard'); if (!b) return;
  b.addEventListener('click', () => { clearDraft(kind); modalCloseHook = null; reopen(); });
}
// Auto-save on an accidental close (×, scrim, Escape). `collect` returns the
// draft data, or null when the form is effectively empty (nothing worth saving).
// `collectFiles` (optional) returns the per-row File arrays to persist to
// IndexedDB — only the claim form has receipts, so meal/advance omit it.
function armDraftAutosave(kind, collect, collectFiles) {
  modalCloseHook = () => {
    const data = collect();
    if (!data) { clearDraft(kind); return; }
    saveDraftData(kind, data);
    if (collectFiles) saveDraftFiles(kind, collectFiles());
    toast(t('Draft saved — reopen it from the New button.'));
  };
}
// Explicit "Save draft": save (if there's anything) and close.
function saveDraftAndClose(kind, collect, collectFiles) {
  const data = collect();
  if (!data) { toast(t('Nothing to save yet — fill in the form first.'), true); return; }
  saveDraftData(kind, data);
  if (collectFiles) saveDraftFiles(kind, collectFiles());
  modalCloseHook = null; // already saved; don't double-save on close
  toast(t('Draft saved'));
  closeModal();
}
// "Cancel": deliberate discard — drop any draft and close without saving.
function discardDraftAndClose(kind) { clearDraft(kind); modalCloseHook = null; closeModal(); }

// `reclaim` (see startReclaim) opens a NEW claim prefilled with another document's
// rejected lines: { type: 'claim'|'advance', id, no, floor, lines }.
function openClaimModal(existing = null, reclaim = null) {
  const isEdit = !!existing;
  // A rejected claim may keep the dates it already had, even past the window,
  // or be re-dated within the window it was first submitted into. A re-claim is
  // held to the window its source was first submitted into, the same way.
  setClaimDateContext(isEdit ? existing : reclaim ? { date_floor: reclaim.floor, lines: reclaim.lines } : null);
  claimEditId = isEdit ? existing.id : reclaim ? reclaim.id : null;
  rcAttachBase = reclaim && reclaim.type === 'advance' ? '/api/cash-advances' : '/api/claims';
  const fresh = !isEdit && !reclaim;
  const draft = fresh ? loadDraft('claim') : null;
  if (isEdit || reclaim) {
    // An edit carries only the live lines (rejected ones stay on the claim as
    // history); a re-claim carries exactly the rejected lines picked for it.
    claimRows = (isEdit ? activeLines(existing) : reclaim.lines).map(l => ({
      line_date: l.line_date, db_no: l.db_no || '', expense_type: l.expense_type,
      amount: l.amount != null ? String(l.amount) : '', description: l.description || '',
      // The date came in with the claim, so it may stay even if it now sits
      // outside the window.
      carried: !claimDateUnlocked(),
      files: [], kept: (l.attachments || []).map(a => ({ id: a.id, original_name: a.original_name }))
    }));
    if (!claimRows.length) claimRows = [blankClaimRow()];
  } else if (draft && Array.isArray(draft.data.rows) && draft.data.rows.length) {
    // Restore the saved draft's rows. Files start empty here and are re-hydrated
    // from IndexedDB once the modal is open (see the loadDraftFiles call below).
    claimRows = draft.data.rows.map(r => ({ ...blankClaimRow(), ...r, files: [], kept: [] }));
  } else {
    claimRows = [blankClaimRow(todayWIB())];
  }
  openModal(`
    ${formHeadHtml(isEdit ? t('Edit & resubmit claim') : reclaim ? t('Re-claim rejected lines') : t('New reimbursement claim'))}
    <div class="modal-body">
      <form id="claimForm" class="form lf-form">
        ${draft ? draftBannerHtml() : ''}
        ${reclaim ? reclaimNoteHtml(reclaim) : ''}
        <p class="form-error" id="claimError" hidden></p>
        <div class="meal-scroll">
          <section class="lf-sec">
            ${linesSectionHead(t('Expense lines'), t('One row per expense — attach that expense\'s receipts on its own row (PDF or images, up to 8 per row).'))}
            <div class="meal-table-wrap">
              <table class="meal-table rc-table">
                <colgroup>
                  <col class="c-date" /><col class="c-db" /><col class="c-type" /><col class="c-amt" /><col /><col class="c-recv" /><col class="c-x" />
                </colgroup>
                <thead><tr>
                  <th>${esc(t('Date'))}</th><th>${esc(t('DB No.'))}</th><th>${esc(t('Type of expense'))}</th>
                  <th>${esc(t('Amount'))}</th><th>${esc(t('Description / purpose'))}</th>
                  <th>${esc(t('Receipts'))}</th><th aria-label="${esc(t('Remove'))}"></th>
                </tr></thead>
                <tbody id="rcRows"></tbody>
              </table>
            </div>
            <button type="button" class="lf-add" id="rcAddRow">${esc(t('+ Add another line'))}</button>
            <div id="claimDateBox"></div>
          </section>
          ${approvalSectionHtml(approver1PickerHtml(existing) + (isEdit ? resubmitNoteHtml() : ''))}
        </div>
        <div class="modal-actions meal-foot">
          ${footTotalHtml('rcTotal')}
          <button type="button" class="btn btn-ghost" id="cancelClaim">${esc(t('Cancel'))}</button>
          ${fresh ? `<button type="button" class="btn btn-ghost" id="rcSaveDraft">${esc(t('Save draft'))}</button>` : ''}
          <button type="submit" class="btn btn-primary">${isEdit ? esc(t('Resubmit claim')) : esc(t('Submit claim'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-xwide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#cancelClaim').addEventListener('click', fresh ? () => discardDraftAndClose('claim') : closeModal);
  $('#rcAddRow').addEventListener('click', () => {
    readClaimRows(); claimRows.push(blankClaimRow()); renderClaimRows();
  });
  $('#claimForm').addEventListener('submit', e => submitClaim(e, existing, reclaim));
  renderClaimDateBox();
  renderClaimRows();
  if (fresh) {
    // Preselect the draft's Approver 1 (the picker only renders when ≥2 choices).
    if (draft && draft.data.approver1) {
      const sel = $('#claimForm [name="approver1"]'); if (sel) sel.value = draft.data.approver1;
    }
    const collect = collectClaimDraft;
    $('#rcSaveDraft').addEventListener('click', () => saveDraftAndClose('claim', collect, collectClaimFiles));
    armDraftAutosave('claim', collect, collectClaimFiles);
    if (draft) wireDraftBanner('claim', () => openClaimModal());
    // Re-hydrate the draft's receipts from IndexedDB back onto their rows, then
    // re-render so the file chips reappear. Async, so the modal shows instantly.
    if (draft) loadDraftFiles('claim').then(perRow => {
      if (!perRow) return;
      readClaimRows(); // keep any edits the user made before restore landed
      perRow.forEach((files, idx) => {
        if (claimRows[idx] && Array.isArray(files)) claimRows[idx].files = files;
      });
      renderClaimRows();
    });
  }
}
// --- Shared shell of the claim / meal / advance / realization forms -----------
// Header with who is claiming (name · department · currency), titled sections,
// a line count, and a footer with the running total beside the actions.
function formHeadHtml(title) {
  const u = state.user || {};
  const sub = [u.full_name, u.department, regionCurrency()].filter(Boolean);
  return `<div class="modal-head lf-modal-head">
      <div class="lf-head-text"><h2>${esc(title)}</h2><div class="lf-sub">${sub.map(s => `<span>${esc(s)}</span>`).join('')}</div></div>
      <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
    </div>`;
}
function linesSectionHead(title, hint) {
  return `<div class="lf-sec-head"><h3>${esc(title)}</h3><span class="lf-count" data-lf-count></span></div>
    ${hint ? `<p class="lf-hint">${esc(hint)}</p>` : ''}`;
}
// Approver 1 / resubmit note get their own section — omitted when empty.
function approvalSectionHtml(inner) {
  return String(inner || '').trim()
    ? `<section class="lf-sec lf-approval"><div class="lf-sec-head"><h3>${esc(t('Approval'))}</h3></div>${inner}</section>` : '';
}
function resubmitNoteHtml() {
  return `<label class="full">${esc(t('Note to manager (optional)'))}
    <input name="resubmit_note" placeholder="${esc(t('What you changed since the rejection'))}" /></label>`;
}
// Footer total: label, the live amount (id kept for the existing updaters) and
// how many lines carry an amount.
function footTotalHtml(id) {
  return `<div class="lf-total"><span class="lf-total-l">${esc(t('Total'))}</span>
    <span class="meal-total" id="${id}">0</span><span class="lf-total-n" data-lf-count></span></div>`;
}
const lineCountText = (n) => n === 1 ? t('{n} line', { n }) : t('{n} lines', { n });
function syncLineCount(n) { $$('#modal [data-lf-count]').forEach(el => { el.textContent = lineCountText(n); }); }
// A required field's label text with its asterisk, kept on one line (form
// labels stack their children, which used to drop the * onto its own row).
const reqLabel = (text) => `<span class="lbl">${esc(text)} <span class="req" aria-hidden="true">*</span></span>`;

// The banner on a re-claim form: where the lines came from and what happens.
function reclaimNoteHtml(reclaim) {
  const n = reclaim.lines.length;
  return `<p class="form-note">${esc(n === 1
    ? t('This line was rejected on {no}. Fix it if needed, then submit it as a new claim.', { no: reclaim.no })
    : t('These {n} lines were rejected on {no}. Fix them if needed, then submit them as a new claim.', { n, no: reclaim.no }))}</p>`;
}
// Gather the claim form's typed fields into a draft payload, or null when the
// form is effectively empty. Receipt File objects go to IndexedDB separately
// (see collectClaimFiles) since they can't be JSON-serialized into localStorage.
function collectClaimDraft() {
  readClaimRows();
  const rows = claimRows.map(r => ({
    line_date: r.line_date || '', db_no: r.db_no || '', expense_type: r.expense_type || '',
    expense_type_other: r.expense_type_other || '', amount: r.amount || '', description: r.description || ''
  }));
  const typed = rows.some(r => r.line_date || r.db_no || r.expense_type || r.expense_type_other || r.amount || r.description);
  // A row with only a receipt attached (no typed fields yet) is still worth
  // keeping — otherwise the auto-save on close would silently drop it.
  const hasFiles = claimRows.some(r => (r.files || []).length);
  if (!typed && !hasFiles) return null;
  const approver1 = (($('#claimForm [name="approver1"]') || {}).value) || '';
  return { rows, approver1 };
}
// The per-row receipt File arrays, aligned index-for-index with collectClaimDraft's
// rows (both map over claimRows in order), for persisting to IndexedDB.
function collectClaimFiles() {
  readClaimRows();
  return claimRows.map(r => (r.files || []).slice());
}

// Only PDFs and images are accepted. The <input accept> covers the file picker,
// but drag & drop bypasses it, so validate by MIME type (falling back to the
// extension when the browser doesn't report one).
function isAllowedUpload(f) {
  if (f.type) return f.type === 'application/pdf' || f.type.startsWith('image/');
  return /\.(pdf|jpe?g|png|gif|webp|heic|heif|bmp|tiff?|svg)$/i.test(f.name);
}
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB — hard ceiling for any one file
// Images are compressed to comfortably under this so they upload through our own
// origin (POST /api/uploads/direct) rather than the vercel.com direct-upload
// host, which some office networks / iOS setups can't reach. See DIRECT_BLOB_THRESHOLD.
const COMPRESS_TARGET = 3.6 * 1024 * 1024;

// iPhone photos: HEIC/HEIF. Browsers report the type as image/heic, image/heif
// or (often) an empty string, so fall back to the extension too.
function isHeic(f) {
  const t = (f.type || '').toLowerCase();
  return t === 'image/heic' || t === 'image/heif' || /\.(heic|heif)$/i.test(f.name || '');
}

// Decode a HEIC/HEIF photo and re-encode it as JPEG so it displays everywhere.
async function heicToJpeg(file) {
  const heic2any = await loadHeic2any();
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}

// Re-encode an oversized image to JPEG, shrinking quality then dimensions until
// it fits under `maxBytes`. Used to keep large photos under the 10 MB cap
// instead of rejecting them outright. Returns a new File.
async function compressImage(file, maxBytes) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => rej(new Error('decode failed'));
    im.src = dataUrl;
  });
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  // Only downscale genuinely enormous images. Real photos compress well, so we
  // keep the resolution high and only trim quality (or size, as a last resort)
  // by as much as it takes to slip under the cap — no more.
  const MAX_DIM = 6000;
  if (Math.max(w, h) > MAX_DIM) { const s = MAX_DIM / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let quality = 0.92, blob = null;
  for (let i = 0; i < 12; i++) {
    canvas.width = w; canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size <= maxBytes) break;
    if (quality > 0.6) quality -= 0.07;                     // first, ease quality down gently
    else { w = Math.round(w * 0.85); h = Math.round(h * 0.85); } // then, shrink size as a last resort
  }
  if (!blob) throw new Error('compress failed');
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}
