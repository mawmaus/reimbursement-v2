'use strict';

// The drawer: one claim, meal allowance or cash advance in detail, with its actions.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Drawer (claim detail + actions)
// ---------------------------------------------------------------------------
function closeDrawer() {
  leaveGhost($('#drawer')); leaveGhost($('#drawerScrim'));
  $('#drawer').hidden = true; $('#drawerScrim').hidden = true;
  $('#drawer').classList.remove('over-modal'); $('#drawerScrim').classList.remove('over-modal');
  syncScrollLock();
}
$('#drawerScrim').addEventListener('click', closeDrawer);
// Escape backs out one layer at a time, topmost first. When the drawer floats
// above the drill-down window (over-modal) it closes first, revealing the
// window; otherwise a modal — which normally stacks above the drawer for an
// edit/reject — takes priority, then the drawer.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const drawer = $('#drawer');
  if (!drawer.hidden && drawer.classList.contains('over-modal')) closeDrawer();
  else if (!$('#modal').hidden) closeModal();
  else if (!drawer.hidden) closeDrawer();
});

// Mirror of the server's userCanApprove — decides whether to show actions.
function canApprove(u, c) {
  if (u.role === 'superadmin') return true;
  const ids = (c.approvers || []).map(a => a.id);
  if (!ids.length) return false;
  return ids[(c.current_step || 1) - 1] === u.id;
}
// State of approver step n (1-based) given the claim's status/current step.
function stepStateFor(c, n) {
  if (c.status === 'approved' || c.status === 'paid') return 'done';
  if (c.status === 'rejected') return n < c.current_step ? 'done' : (n === c.current_step ? 'rejected' : 'pending');
  return n < c.current_step ? 'done' : (n === c.current_step ? 'current' : 'pending');
}
// English step-state labels (kept for the PDF). stepStateLabel() localises them
// for the on-screen approval chain.
const STEP_STATE_LABEL = { done: 'Approved', current: 'Pending', rejected: 'Rejected', pending: 'Upcoming' };
const stepStateLabel = (st) => t(STEP_STATE_LABEL[st] || st || '');

// --- Shared drawer builders (both claim types share these shapes) ------------
function renderChainProgress(c) {
  if (!c.approvers || !c.approvers.length) return '';
  return `
    <div class="section-label">${esc(t('Approval chain'))}</div>
    <ol class="chain-progress">
      ${c.approvers.map((a, idx) => {
        const st = stepStateFor(c, idx + 1);
        return `<li class="cp ${st}">
          <span class="cp-dot">${st === 'done' ? '✓' : (st === 'rejected' ? '×' : idx + 1)}</span>
          <div class="cp-body"><div class="cp-label">${esc(a.name)}</div></div>
          <span class="cp-state">${esc(stepStateLabel(st))}</span></li>`;
      }).join('')}
    </ol>`;
}
// History action verbs are stored as lowercase server enums. Map them to
// translatable Title-Case labels for the on-screen timeline. (The PDF keeps the
// raw English — its embedded font is Latin-only; see pdfSafe.) Unknown verbs
// fall back to a capitalised form so nothing renders blank.
const ACTION_LABEL = {
  submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected',
  resubmitted: 'Resubmitted', paid: 'Paid', settled: 'Settled',
  'realization submitted': 'Realization submitted',
  'realization rejected': 'Realization rejected',
  'realization resubmitted': 'Realization resubmitted',
  'reverted approval': 'Reverted approval',
  'reverted payment': 'Reverted payment',
  'reverted realization approval': 'Reverted realization approval',
  'reverted settlement': 'Reverted settlement',
  'line rejected': 'Line rejected', 'line restored': 'Line restored',
  'lines re-claimed': 'Lines re-claimed'
};
const actionLabel = (a) => {
  const s = String(a || '');
  return t(ACTION_LABEL[s] || (s.charAt(0).toUpperCase() + s.slice(1)));
};
function renderHistory(c) {
  return `
    <div class="section-label">${esc(t('History'))}</div>
    <ul class="timeline">
      ${c.history.map(h => `
        <li><span class="t-action">${esc(actionLabel(h.action))}</span>
          <div class="t-meta">${esc(h.actor_name)} · ${fmtDateTime(h.created_at)}</div>
          ${h.comment ? `<div class="t-comment">${esc(h.comment)}</div>` : ''}</li>`).join('')}
    </ul>`;
}
// Whether the current user may revert (undo one step of) this claim, mirroring
// the server's planRevert: the payer can unpay, the final approver can unapprove,
// the previous-step approver can undo their approval, and the claimant can cancel
// a still-pending submission back to an editable state.
// The set of statuses in which a document is awaiting an approver's decision. For
// cash advances this covers both the request and the realization approval cycle.
const inApprovalStage = (c) => c.status === 'submitted' || (c.type === 'advance' && c.status === 'realize_submitted');

function canRevert(c, u, isOwner) {
  const ids = (c.approvers || []).map(a => a.id);
  const step = c.current_step || 0;
  const isSuper = u.role === 'superadmin';
  // Cash-advance realization phase mirrors the request phase one status set up.
  if (c.type === 'advance') {
    if (c.status === 'settled') return canPay(u);
    if (c.status === 'realize_approved') return isSuper || c.manager_id === u.id;
    if (c.status === 'realize_submitted') {
      if (step > 1) return isSuper || ids[step - 2] === u.id;
      return isOwner || isSuper;
    }
  }
  if (c.status === 'paid') return canPay(u);
  if (c.status === 'approved') return isSuper || c.manager_id === u.id;
  if (c.status === 'submitted') {
    if (step > 1) return isSuper || ids[step - 2] === u.id;
    return isOwner || isSuper; // claimant cancels a not-yet-approved submission
  }
  return false;
}
// Contextual label + confirmation copy for the revert button.
function revertInfo(c) {
  const step = c.current_step || 0;
  if (c.type === 'advance' && c.status === 'settled') return { label: t('Revert settlement'), confirm: t('Revert this settlement? The realization will go back to Approved.') };
  if (c.type === 'advance' && c.status === 'realize_approved') return { label: t('Revert approval'), confirm: t('Revert your approval? The realization will go back to pending review.') };
  if (c.type === 'advance' && c.status === 'realize_submitted') {
    if (step > 1) return { label: t('Revert approval'), confirm: t('Revert your approval? The realization will return to the previous approver.') };
    return { label: t('Cancel to edit'), confirm: t('Cancel this realization so you can edit it? It will move back to editable.') };
  }
  if (c.status === 'paid') return { label: t('Revert payment'), confirm: t('Revert this payment? The claim will go back to Approved.') };
  if (c.status === 'approved') return { label: t('Revert approval'), confirm: t('Revert your approval? The claim will go back to pending review.') };
  if (c.status === 'submitted' && step > 1) return { label: t('Revert approval'), confirm: t('Revert your approval? The claim will return to the previous approver.') };
  return { label: t('Cancel to edit'), confirm: t('Cancel this submission so you can edit it? It will move to Rejected, ready to edit and resubmit.') };
}
// The claimant's Approver 1 candidates, but only for a revert that will leave
// the document waiting on step 1 — the mirror of the server's
// revertLandsOnApprover1. Anywhere else the first approver no longer decides
// anything, so there is nothing to re-pick. A claimant's own "Cancel to edit"
// is deliberately absent too: they get the same picker on the resubmit form.
function revertApprover1Choices(c) {
  const choices = c.approver1_choices || [];
  if (choices.length < 2) return [];
  const step = c.current_step || 0;
  if ((c.status === 'approved' || c.status === 'realize_approved') && step === 1) return choices;
  if ((c.status === 'submitted' || c.status === 'realize_submitted') && step === 2) return choices;
  return [];
}
function buildActions(c, u, isOwner) {
  const btns = [];
  if (inApprovalStage(c) && canApprove(u, c)) {
    btns.push(`<button class="btn btn-approve" data-act="approve">${esc(t('Approve'))}</button>`);
    btns.push(`<button class="btn btn-danger" data-act="reject">${esc(t('Reject & return'))}</button>`);
  }
  if (canPay(u) && c.status === 'approved') {
    btns.push(`<button class="btn btn-primary" data-act="paid">${esc(t('Mark as paid'))}</button>`);
  }
  // Cash-advance-only actions.
  if (c.type === 'advance') {
    if (isOwner && (c.status === 'paid' || c.status === 'rejected_realize')) {
      btns.push(`<button class="btn btn-primary" data-act="realize">${esc(c.status === 'paid' ? t('Realize advance') : t('Edit & resubmit realization'))}</button>`);
    }
    if (canPay(u) && c.status === 'realize_approved') {
      btns.push(`<button class="btn btn-primary" data-act="settle">${esc(owesRefund(c) ? t('Confirm refund received') : t('Settle'))}</button>`);
    }
  }
  if (isOwner && c.status === 'rejected') {
    btns.push(`<button class="btn btn-primary" data-act="edit">${esc(t('Edit & resubmit'))}</button>`);
  }
  // Rejected lines are re-claimed on a new document (label set by syncLineActions).
  if (isOwner && reclaimableLines(c).length) {
    btns.push(`<button class="btn btn-brand-soft" data-act="reclaim">${esc(t('Re-claim rejected lines'))}</button>`);
  }
  if (canRevert(c, u, isOwner)) {
    btns.push(`<button class="btn btn-ghost" data-act="revert">${esc(revertInfo(c).label)}</button>`);
  }
  return btns.join('\n            ');
}

// --- Per-line approval ----------------------------------------------------------
// An approver may reject single lines while approving the rest; a rejected line
// stays on the document as history (struck through, with its reason) and leaves
// the payable total. The claimant re-claims rejected lines on a new document.
const lineRejected = (l) => !!(l && l.rejected);
const activeLines = (c) => (c.lines || []).filter(l => !lineRejected(l));
// Rejected lines not yet carried onto a new document.
const reclaimableLines = (c) => (c.lines || []).filter(l => lineRejected(l) && !l.resubmitted_doc_id);
// The viewer may reject single lines: it's their turn, the document has lines
// (a cash advance only once realized), and at least two are still live — with
// one, rejecting it is just "Reject & return".
function canDecideLines(c, u) {
  if (!inApprovalStage(c) || !canApprove(u, c)) return false;
  if (c.type === 'advance' && c.status !== 'realize_submitted') return false;
  return activeLines(c).length >= 2;
}
// Drawer-local choices, reset whenever the drawer opens: the lines the approver
// has marked to reject (id -> reason typed so far) and the rejected lines the
// claimant has ticked to re-claim.
let lineMarks = new Map();
let reclaimPicks = new Set();
// The document's payable total (what the header carries), and the part of it the
// approver's pending marks would take out.
const payableOf = (c) => c.type === 'meal' ? (c.total_amount || 0) : c.type === 'advance' ? (c.realized_total || 0) : (c.amount || 0);
const markedTotal = (c) => (c.lines || []).filter(l => lineMarks.has(l.id)).reduce((s, l) => s + (l.amount || 0), 0);
// Which drawer a carried line / a source document opens in.
const reclaimTargetType = (c) => c.type === 'meal' ? 'meal' : 'reimbursement';
const sourceDrawerType = (k) => k === 'meal' ? 'meal' : k === 'advance' ? 'advance' : 'reimbursement';

// Column set per document type. Amount is always the 4th column so the total
// rows line up the same way for all three.
function lineColumns(c) {
  const receiptLinks = (atts) => (atts && atts.length)
    ? `<div class="line-receipt-list">${atts.map(a => `<a class="line-receipt" title="${esc(a.original_name)}" href="/api/${c.type === 'advance' ? 'cash-advances' : 'claims'}/${c.id}/attachments/${a.id}" target="_blank" rel="noopener">📎 ${esc(a.original_name)}</a>`).join('')}</div>`
    : `<span class="muted">${esc(t('—'))}</span>`;
  const dash = '<span class="muted">—</span>';
  if (c.type === 'meal') return [
    { h: 'Date', cls: 'mono', v: l => esc(l.line_date) },
    { h: 'DB Number Site', v: l => l.site ? esc(dbFmt(l.site)) : dash },
    { h: 'Job Category', v: l => l.job_category ? esc(l.job_category) : dash },
    { h: 'Amount', cls: 'meal-amt', v: l => `<span class="amt-v">${esc(money(l.amount, c.currency))}</span>` },
    { h: 'Additional Description', v: l => l.description ? esc(l.description) : dash }
  ];
  return [
    { h: 'Date', cls: 'mono', v: l => esc(l.line_date) },
    { h: 'DB No.', v: l => l.db_no ? esc(dbFmt(l.db_no)) : dash },
    { h: 'Type of expense', v: l => esc(l.expense_type) },
    { h: 'Amount', cls: 'meal-amt', v: l => `<span class="amt-v">${esc(money(l.amount, c.currency))}</span>` },
    { h: 'Description / purpose', v: l => l.description ? esc(l.description) : dash },
    { h: 'Receipts', cls: 'line-receipts', v: l => receiptLinks(l.attachments) }
  ];
}
// The note under a rejected line: why and by whom, then where it went — re-claimed
// on another document, or (for the claimant) a tick to include it in a re-claim.
function rejectedNoteHtml(c, l, isOwner, pickable) {
  const r = l.rejected;
  const who = [r.by, r.at ? fmtDateTime(r.at) : ''].filter(Boolean).join(' · ');
  let tail = '';
  if (l.resubmitted_doc_id) {
    tail = `<span class="lr-tail">${esc(t('Re-claimed on'))} <a href="#" data-open-doc="${l.resubmitted_doc_id}" data-doc-type="${reclaimTargetType(c)}">${esc(l.resubmitted_doc_no)}</a></span>`;
  } else if (isOwner && pickable) {
    tail = `<label class="lr-tail lr-pick"><input type="checkbox" data-reclaim="${l.id}" ${reclaimPicks.has(l.id) ? 'checked' : ''} /> ${esc(t('Include in re-claim'))}</label>`;
  } else if (isOwner) {
    tail = `<span class="lr-tail muted">${esc(t('Not paid on this claim — re-claim it on a new one.'))}</span>`;
  }
  return `<div class="lr-note">
      <div class="lr-head"><span class="lr-badge">${esc(t('Line rejected'))}</span>${who ? `<span class="lr-who">${esc(who)}</span>` : ''}</div>
      <div class="lr-reason">${esc(r.reason)}</div>
      ${tail}
    </div>`;
}
// The whole line table for the drawer, re-rendered in place as the approver
// marks lines (see renderDrawerLines).
function drawerLinesHtml(c) {
  const u = state.user;
  const isOwner = c.employee_id === u.id;
  const cols = lineColumns(c);
  const deciding = canDecideLines(c, u);
  const pickable = reclaimableLines(c).length > 1;
  const span = cols.length + (deciding ? 1 : 0);
  const rows = (c.lines || []).map(l => {
    const rejected = lineRejected(l);
    const marked = !rejected && lineMarks.has(l.id);
    const cls = rejected ? 'line-rejected' : marked ? 'line-marked' : '';
    const sub = rejected || marked;
    const cells = cols.map(col => `<td class="${col.cls || ''}" data-label="${esc(t(col.h))}">${col.v(l)}</td>`).join('');
    const decide = deciding ? `<td class="line-decide">${rejected ? '' : marked
      ? `<button type="button" class="btn btn-ghost btn-xs" data-unmark="${l.id}">${esc(t('Keep line'))}</button>`
      : `<button type="button" class="btn btn-ghost btn-xs lr-reject-btn" data-mark="${l.id}">${esc(t('Reject line'))}</button>`}</td>` : '';
    const main = `<tr class="${cls}${sub ? ' has-sub' : ''}">${cells}${decide}</tr>`;
    if (rejected) return main + `<tr class="line-sub line-sub-rejected"><td colspan="${span}">${rejectedNoteHtml(c, l, isOwner, pickable)}</td></tr>`;
    if (marked) return main + `<tr class="line-sub line-sub-marked"><td colspan="${span}">
        <label class="lr-reason-field">${esc(t('Reason for rejecting this line'))}
          <input data-reason="${l.id}" value="${esc(lineMarks.get(l.id) || '')}" maxlength="1000" placeholder="${esc(t('e.g. the receipt is unreadable'))}" /></label></td></tr>`;
    return main;
  }).join('');
  const rejectedSum = (c.lines || []).filter(lineRejected).reduce((s, l) => s + (l.amount || 0), 0);
  const pending = markedTotal(c);
  const out = rejectedSum + pending;
  const totalLabel = c.type === 'meal' ? 'TOTAL CLAIM MEAL ALLOWANCE' : c.type === 'advance' ? 'TOTAL SPENT' : 'TOTAL';
  const rest = span - 4;
  const footRow = (label, amount, cls) => `<tr class="${cls}">
      <td colspan="3" class="meal-total-label">${esc(label)}</td>
      <td class="meal-total">${esc(amount)}</td>${rest > 0 ? `<td colspan="${rest}"></td>` : ''}</tr>`;
  const foot = (out ? footRow(t('Rejected lines'), '− ' + money(out, c.currency), 'lr-foot-rejected') : '')
    + footRow(out ? t(c.type === 'advance' ? 'Counted against the advance' : 'Payable') : t(totalLabel), money(payableOf(c) - pending, c.currency), '');
  const heading = c.type === 'meal' ? t('Meal allowance lines') : c.type === 'advance' ? t('Realization — actual transactions') : t('Expense lines');
  const hint = deciding ? `<p class="lr-hint">${esc(t('To leave a line out, press "Reject line" on it and give a reason. The rest is approved without it, and the claimant re-claims that line on a new claim.'))}</p>` : '';
  return `
    <div class="section-label">${esc(heading)}</div>
    ${hint}
    <div class="meal-table-wrap">
      <table class="meal-table rc-table drawer-lines${deciding ? ' is-deciding' : ''}">
        <thead><tr>${cols.map(col => `<th>${esc(t(col.h))}</th>`).join('')}${deciding ? `<th><span class="sr-only">${esc(t('Decision'))}</span></th>` : ''}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${span}" class="muted" style="padding:12px">${esc(t('No lines.'))}</td></tr>`}</tbody>
        <tfoot>${foot}</tfoot>
      </table>
    </div>`;
}
// Paint the line table and keep the action buttons in step with the marks.
function renderDrawerLines(c) {
  const box = $('#drawerLines');
  if (!box) return;
  box.innerHTML = drawerLinesHtml(c);
  box.querySelectorAll('[data-mark]').forEach(b => b.addEventListener('click', () => {
    lineMarks.set(Number(b.dataset.mark), ''); renderDrawerLines(c);
    const inp = box.querySelector(`[data-reason="${b.dataset.mark}"]`); if (inp) inp.focus();
  }));
  box.querySelectorAll('[data-unmark]').forEach(b => b.addEventListener('click', () => {
    lineMarks.delete(Number(b.dataset.unmark)); renderDrawerLines(c);
  }));
  box.querySelectorAll('[data-reason]').forEach(inp => inp.addEventListener('input', () => {
    lineMarks.set(Number(inp.dataset.reason), inp.value); inp.classList.remove('invalid');
  }));
  box.querySelectorAll('[data-reclaim]').forEach(cb => cb.addEventListener('change', () => {
    const id = Number(cb.dataset.reclaim);
    if (cb.checked) reclaimPicks.add(id); else reclaimPicks.delete(id);
    syncLineActions(c);
  }));
  wireDocLinks(box);
  syncLineActions(c);
}
// Links to another document (a re-claim, or the claim it came from) open it in
// the drawer.
function wireDocLinks(root) {
  root.querySelectorAll('[data-open-doc]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    openDrawer(Number(a.dataset.openDoc), a.dataset.docType).catch(ex => toast(ex.message, true));
  }));
}
// Approve / Re-claim button labels follow the marks and ticks.
function syncLineActions(c) {
  const ap = $('#drawer [data-act="approve"]');
  if (ap) {
    const live = activeLines(c).length;
    const keep = live - lineMarks.size;
    ap.textContent = lineMarks.size ? t('Approve {n} of {m} lines', { n: keep, m: live }) : t('Approve');
    ap.disabled = lineMarks.size > 0 && keep < 1;
    ap.title = ap.disabled ? t('Every line is marked — use "Reject & return" to send the whole claim back.') : '';
  }
  const rc = $('#drawer [data-act="reclaim"]');
  if (rc) {
    const n = reclaimableLines(c).filter(l => reclaimPicks.has(l.id)).length;
    rc.textContent = n === 1 ? t('Re-claim 1 rejected line') : t('Re-claim {n} rejected lines', { n });
    rc.disabled = n < 1;
  }
}
// The approve call, carrying any lines this approver rejected. Every marked line
// needs a reason; the first one missing gets focus instead of a round trip.
async function approveWithLines(c, base) {
  const missing = [...lineMarks].find(([, reason]) => !String(reason || '').trim());
  if (missing) {
    const inp = $(`#drawer [data-reason="${missing[0]}"]`);
    if (inp) { inp.classList.add('invalid'); inp.focus(); }
    toast(t('Give a reason for every rejected line'), true);
    return false;
  }
  const rejected_lines = [...lineMarks].map(([id, reason]) => ({ id, reason: String(reason).trim() }));
  if (rejected_lines.length) {
    const ok = confirm(t('Approve {n} of {m} lines? The {k} rejected line(s) will not be paid on this claim.',
      { n: activeLines(c).length - rejected_lines.length, m: activeLines(c).length, k: rejected_lines.length }));
    if (!ok) return false;
  }
  await api(`${base}${c.id}/approve`, { method: 'POST', body: JSON.stringify({ rejected_lines }) });
  toast(rejected_lines.length ? t('Approved — {k} line(s) rejected', { k: rejected_lines.length }) : t('Claim approved'));
  return true;
}
// Open the right new-claim form prefilled with the ticked rejected lines.
function startReclaim(c) {
  const lines = reclaimableLines(c).filter(l => reclaimPicks.has(l.id));
  if (!lines.length) return toast(t('Tick at least one rejected line to re-claim'), true);
  const reclaim = {
    type: c.type === 'advance' ? 'advance' : c.type === 'meal' ? 'meal' : 'claim',
    id: c.id, no: c.claim_no, floor: c.reclaim_floor || '', lines
  };
  if (c.type === 'meal') return openMealAllowanceModal(null, reclaim);
  return openClaimModal(null, reclaim);
}
// "Re-claims lines from RC-2026-0012" on a document raised from another's rejected lines.
function sourceKvHtml(c) {
  if (!c.source_doc_no) return '';
  return `<dt>${esc(t('Re-claims lines from'))}</dt><dd><a href="#" data-open-doc="${c.source_doc_id}" data-doc-type="${sourceDrawerType(c.source_doc_type)}">${esc(c.source_doc_no)}</a></dd>`;
}

// Where the money goes: recipient, bank and account number (with a Copy button
// for Finance). A document re-claiming another's rejected lines links back to it
// first — that <dl> is then the drawer's first .kv, which openDrawer wires for
// links. Claimant and department live in the drawer header.
function paymentCardHtml(c) {
  const src = sourceKvHtml(c);
  const dash = '<span class="muted">—</span>';
  return `${src ? `<dl class="kv d-source">${src}</dl>` : ''}
    <section class="d-pay">
      <div class="section-label d-first">${esc(t('Payment details'))}</div>
      <dl class="kv kv-pay">
        <dt>${esc(t('Recipient'))}</dt><dd>${c.recipient_name ? esc(c.recipient_name) : dash}</dd>
        <dt>${esc(t('Bank'))}</dt><dd>${c.bank_name ? esc(c.bank_name) : dash}</dd>
        <dt>${esc(t('Account no.'))}</dt><dd class="d-acct">${c.bank_account_no
          ? `<span class="mono">${esc(c.bank_account_no)}</span><button type="button" class="copy-btn" data-copy="${esc(c.bank_account_no)}">${esc(t('Copy'))}</button>`
          : dash}</dd>
      </dl>
    </section>`;
}

// Body for a reimbursement claim: account/bank details + the itemised line table
// (painted into #drawerLines by renderDrawerLines), each line with its receipts.
function reimbursementBody(c) {
  // Fall back to a single synthetic line for any legacy claim without lines.
  if (!(c.lines && c.lines.length)) c.lines = [{
    line_date: c.expense_date, db_no: c.db_no, expense_type: c.expense_type,
    amount: c.amount, description: c.description, attachments: c.attachments || []
  }];
  return `
    ${paymentCardHtml(c)}
    <div id="drawerLines"></div>`;
}

// Body for a meal allowance claim: account/bank details + the line-item table.
function mealBody(c) {
  return `
    ${paymentCardHtml(c)}
    <div id="drawerLines"></div>`;
}

// Body for a cash advance: account/bank details, the purpose + requested amount,
// and — once realized — the itemised transactions with a settlement summary.
function advanceBody(c) {
  const hasLines = (c.lines || []).length > 0;
  // Phase-1 supporting documents, shown between the request details and the
  // realization so an approver reads the justification before the spend.
  const docs = c.attachments || [];
  const docsBox = docs.length ? `
    <div class="section-label">${esc(t('Supporting documents'))}</div>
    <div class="adv-doc-list">${docs.map(a => `
      <a class="adv-doc" href="/api/cash-advances/${c.id}/attachments/${a.id}" target="_blank" rel="noopener">
        <span class="adv-doc-icon" aria-hidden="true">📄</span>
        <span class="adv-doc-name" title="${esc(a.original_name)}">${esc(a.original_name)}</span>
        <span class="adv-doc-size">${esc(fmtBytes(a.size_bytes))}</span>
      </a>`).join('')}</div>` : '';
  const linesTable = hasLines ? '<div id="drawerLines"></div>'
    : `<p class="muted" style="margin:10px 0">${esc(t('Realization not submitted yet.'))}</p>`;
  // Settlement summary: the recorded outcome once settled, otherwise a live preview.
  let settleBox = '';
  if (hasLines) {
    const diff = (c.realized_total || 0) - (c.amount || 0);
    const dir = c.status === 'settled' ? c.settlement_direction : (diff > 0 ? 'topup' : diff < 0 ? 'return' : 'even');
    const amt = c.status === 'settled' ? c.settlement : Math.abs(diff);
    const msg = dir === 'topup' ? t('Top-up owed to employee: {amt}', { amt: money(amt, c.currency) })
      : dir === 'return' ? (c.status === 'settled'
        ? t('Refund received from employee: {amt}', { amt: money(amt, c.currency) })
        : t('Balance to be returned by employee: {amt}', { amt: money(amt, c.currency) }))
      : t('Advance and actual spend match exactly.');
    settleBox = `<div class="note-box adv-settle adv-diff-${dir}">
      <div class="nb-label">${esc(c.status === 'settled' ? t('Settlement') : t('Settlement (pending)'))}</div>
      <div>${esc(msg)}</div>
      ${owesRefund(c) ? `<div class="muted" style="margin-top:4px">${esc(t('This advance stays open — and new claims stay on hold — until Finance confirms the refund was received.'))}</div>` : ''}
      ${c.status === 'settled' && c.settlement_note ? `<div class="muted" style="margin-top:4px">${esc(c.settlement_note)}</div>` : ''}
    </div>`;
  }
  return `
    ${c.purpose ? `<div class="section-label d-first">${esc(t('Purpose'))}</div><p class="d-purpose">${esc(c.purpose)}</p>` : ''}
    ${paymentCardHtml(c)}
    ${docsBox}
    ${linesTable}
    ${settleBox}`;
}

async function openDrawer(id, type = 'reimbursement') {
  const path = type === 'meal' ? '/meal-claims/' : type === 'advance' ? '/cash-advances/' : '/claims/';
  const { claim: c } = await api(path + id);
  c.type = type;
  const u = state.user;
  const isOwner = c.employee_id === u.id;
  // Fresh per-line choices for this document: no marks yet, and every rejected
  // line the claimant can still re-claim starts ticked.
  lineMarks = new Map();
  reclaimPicks = new Set(reclaimableLines(c).map(l => l.id));
  const rejectedCount = (c.lines || []).filter(lineRejected).length;

  const rejectedNote = (c.status === 'rejected' && c.manager_comment) ? `
    <div class="note-box"><div class="nb-label">${esc(t('Returned by manager'))}</div>
      <div>${esc(c.manager_comment)}</div></div>` : '';
  const body = type === 'meal' ? mealBody(c) : type === 'advance' ? advanceBody(c) : reimbursementBody(c);
  const actions = buildActions(c, u, isOwner);

  // Header = what an approver needs at a glance: what it is, how much, where it
  // stands, and whose it is. The headline amount is what would be paid (or, for
  // an advance, what was asked for); the line table below breaks it down.
  const typeLabel = type === 'meal' ? t('Meal allowance') : type === 'advance' ? t('Cash advance') : t('Reimbursement');
  const headAmt = type === 'advance' ? c.amount : payableOf(c);
  const headAmtLabel = type === 'advance' ? t('Advance requested') : rejectedCount ? t('Payable') : t('Total');
  const meta = [c.claimant_name, c.department, t('Submitted {time}', { time: fmtDateTime(c.created_at) })].filter(Boolean);
  $('#drawer').innerHTML = `
    <div class="drawer-head dh">
      <div class="dh-top">
        <span class="dh-type">${esc(typeLabel)}</span>
        <span class="dh-no">${esc(c.claim_no)}</span>
        <button class="x-btn" aria-label="${esc(t('Close'))}">×</button>
      </div>
      <div class="dh-main">
        <div class="dh-amt-wrap"><div class="dh-amt">${esc(money(headAmt, c.currency))}</div><div class="dh-amt-l">${esc(headAmtLabel)}</div></div>
        <div class="dh-pills"><span class="pill ${pillClass(c)}">${esc(statusLabelFor(c))}</span>${rejectedCount
          ? `<span class="pill lr-pill">${esc(rejectedCount === 1 ? t('1 line rejected') : t('{n} lines rejected', { n: rejectedCount }))}</span>` : ''}</div>
      </div>
      <div class="dh-meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>
    </div>
    <div class="drawer-body">
      ${rejectedNote}
      ${body}
      ${renderChainProgress(c)}
      ${renderHistory(c)}
    </div>
    <div class="drawer-actions">${actions || `<span class="muted da-none">${esc(t('No actions available for your role at this stage.'))}</span>`}</div>`;

  $('#drawer .x-btn').addEventListener('click', closeDrawer);
  // Copy the account number (Finance pastes it into the bank transfer).
  $$('#drawer [data-copy]').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast(t('Copied')); }
    catch { toast(t('Copy failed — select the number and copy it manually.'), true); }
  }));
  $$('#drawer [data-act]').forEach(b => b.addEventListener('click', () => handleAction(b.dataset.act, c)));
  renderDrawerLines(c);
  wireDocLinks($('#drawer .kv') || $('#drawer'));

  $('#drawerScrim').hidden = false;
  $('#drawer').hidden = false;
  syncScrollLock();
}

async function handleAction(act, c) {
  const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
  try {
    if (act === 'approve') {
      if (!(await approveWithLines(c, base))) return;
    } else if (act === 'reclaim') {
      return startReclaim(c);
    } else if (act === 'paid') {
      return openPaidModal(c);
    } else if (act === 'realize') {
      return openRealizeModal(c);
    } else if (act === 'settle') {
      return openSettleModal(c);
    } else if (act === 'revert') {
      // A revert that hands the document back to Approver 1 opens a modal, so it
      // can be re-routed on the way; every other revert stays a one-click confirm.
      if (revertApprover1Choices(c).length) return openRevertModal(c);
      const info = revertInfo(c);
      if (!confirm(info.confirm)) return;
      await api(`${base}${c.id}/revert`, { method: 'POST', body: JSON.stringify({}) });
      toast(t('Reverted'));
    } else if (act === 'reject') {
      return openRejectModal(c);
    } else if (act === 'edit') {
      return c.type === 'meal' ? openMealAllowanceModal(c) : c.type === 'advance' ? openAdvanceRequestModal(c) : openClaimModal(c);
    }
    closeDrawer(); loadAll();
  } catch (ex) { toast(ex.message, true); }
}
