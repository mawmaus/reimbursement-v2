'use strict';

// Review mode (Glass look): the claims waiting for you as a deck of floating
// cards, one at a time. Swipe right (or Approve / → / A) to approve, left (or
// Reject / ← / R) to open the usual rejection form, up (or Skip / ↑ / S) to
// move a claim to the back. "View full claim" opens the normal drawer on top.
// An approval is held for a few seconds behind an Undo bar before it is sent,
// so a mis-swipe never reaches the server; closing the deck sends it at once.
// A plain <script> sharing globals with app.js (see index.html).

const REVIEW_UNDO_MS = 5000;
const review = { queue: [], i: 0, full: new Map(), pending: null, busy: false, checking: new Set() };

const reviewBase = (c) => c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
const reviewKey = (c) => claimKey(c.type, c.id);
const reviewDeck = () => $('#reviewDeck');

// The button lives in the list head; only Needs my approval, only in Glass.
function syncReviewButton() {
  const btn = $('#reviewBtn');
  if (!btn) return;
  const n = state.view === 'approval' ? approvalQueue().length : 0;
  btn.hidden = !(document.documentElement.hasAttribute('data-glass') && n > 0);
  btn.querySelector('.rv-lab').textContent = n === 1 ? t('Review 1 claim') : t('Review {n} claims', { n });
}
$('#reviewBtn').addEventListener('click', openReview);
if (window.Theme) Theme.onChange(syncReviewButton);

function openReview() {
  if (reviewDeck()) return;
  review.queue = sortClaims(approvalQueue());
  review.i = 0;
  review.full = new Map();
  const deck = document.createElement('div');
  deck.id = 'reviewDeck';
  deck.className = 'rv-deck';
  deck.setAttribute('role', 'dialog');
  deck.setAttribute('aria-modal', 'true');
  deck.setAttribute('aria-label', t('Review mode'));
  deck.innerHTML = `
    <div class="rv-top">
      <div class="rv-title"><span class="rv-name">${esc(t('Review mode'))}</span><span class="rv-count" aria-live="polite"></span></div>
      <button type="button" class="x-btn rv-close" aria-label="${esc(t('Close'))}">×</button>
    </div>
    <div class="rv-progress" aria-hidden="true"><i></i></div>
    <div class="rv-stage"></div>
    <p class="rv-hint">${esc(t('Swipe right to approve, left to reject, up to skip.'))}</p>
    <div class="rv-actions">
      <button type="button" class="btn rv-reject">${esc(t('Reject'))}</button>
      <button type="button" class="btn btn-ghost rv-skip">${esc(t('Skip'))}</button>
      <button type="button" class="btn btn-approve rv-approve">${esc(t('Approve'))}</button>
    </div>
    <div class="rv-undo" role="status" hidden><span class="rv-undo-txt"></span>
      <button type="button" class="btn btn-ghost btn-sm rv-undo-btn">${esc(t('Undo'))}</button></div>`;
  document.body.appendChild(deck);
  deck.querySelector('.rv-close').addEventListener('click', closeReview);
  deck.querySelector('.rv-approve').addEventListener('click', () => reviewApprove());
  deck.querySelector('.rv-reject').addEventListener('click', () => reviewReject());
  deck.querySelector('.rv-skip').addEventListener('click', () => reviewSkip());
  deck.querySelector('.rv-undo-btn').addEventListener('click', reviewUndo);
  // Capture phase: runs before drawer.js's Escape handler, so an Escape meant
  // for a drawer or form opened from the deck doesn't also close the deck.
  document.addEventListener('keydown', reviewKeys, true);
  syncScrollLock();
  renderReview();
  deck.querySelector('.rv-approve').focus({ preventScroll: true });
}

async function closeReview() {
  const deck = reviewDeck();
  if (!deck) return;
  document.removeEventListener('keydown', reviewKeys, true);
  const sent = flushReviewPending();
  deck.classList.add('leaving');
  setTimeout(() => deck.remove(), reducedMotion() ? 0 : 220);
  deck.id = '';
  syncScrollLock();
  const btn = $('#reviewBtn'); if (btn && !btn.hidden) btn.focus({ preventScroll: true });
  await sent;
  loadAll();
}

function reviewKeys(e) {
  // The drawer or a form opened from the deck owns the keyboard while it's up.
  const el = e.target instanceof Element ? e.target : null;
  if (!$('#modal').hidden || !$('#drawer').hidden || (el && el.closest('input, textarea, select'))) return;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); reviewUndo(); }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'escape') { e.preventDefault(); closeReview(); }
  else if (k === 'arrowright' || k === 'a') { e.preventDefault(); reviewApprove(); }
  else if (k === 'arrowleft' || k === 'r') { e.preventDefault(); reviewReject(); }
  else if (k === 'arrowup' || k === 's') { e.preventDefault(); reviewSkip(); }
  else if (k === 'd' || (k === 'enter' && !(el && el.closest('button')))) { e.preventDefault(); reviewDetails(); }
  else if (k === 'u') { e.preventDefault(); reviewUndo(); }
}

const reviewCurrent = () => review.queue[review.i] || null;

function renderReview(enter) {
  const deck = reviewDeck();
  if (!deck) return;
  const n = review.queue.length;
  const done = review.i >= n;
  deck.querySelector('.rv-count').textContent = done ? '' : t('{i} of {n}', { i: review.i + 1, n });
  deck.querySelector('.rv-progress i').style.width = (n ? Math.round(Math.min(review.i, n) / n * 100) : 100) + '%';
  deck.querySelector('.rv-actions').hidden = done;
  deck.querySelector('.rv-hint').hidden = done;
  const stage = deck.querySelector('.rv-stage');
  if (done) {
    stage.innerHTML = `
      <article class="rv-card rv-done" data-depth="0">
        <div class="rv-done-mark" aria-hidden="true">✓</div>
        <h3>${esc(t('All caught up'))}</h3>
        <p>${esc(t('Every claim waiting for you has been reviewed.'))}</p>
        <button type="button" class="btn btn-primary rv-back">${esc(t('Back to list'))}</button>
      </article>`;
    stage.querySelector('.rv-back').addEventListener('click', closeReview);
    return;
  }
  // The top card plus two behind it, back to front so the top one paints last.
  const cards = review.queue.slice(review.i, review.i + 3);
  stage.innerHTML = cards.map((c, d) => reviewCardHtml(c, d)).reverse().join('');
  const top = stage.querySelector('.rv-card[data-depth="0"]');
  if (enter) top.classList.add('enter-' + enter);
  top.querySelector('.rv-details').addEventListener('click', reviewDetails);
  wireReviewSwipe(top);
  loadReviewLines(cards[0]);
  if (cards[1]) loadReviewLines(cards[1], true);
}

function reviewCardHtml(c, depth) {
  const v = rowView(c);
  const meta = [v.date, c.department, v.db ? dbFmt(v.db) : ''].filter(Boolean);
  return `
    <article class="rv-card" data-depth="${depth}" data-key="${esc(reviewKey(c))}" ${depth ? 'aria-hidden="true"' : ''}>
      <div class="rv-stamp rv-stamp-ok" aria-hidden="true">${esc(t('Approve'))}</div>
      <div class="rv-stamp rv-stamp-no" aria-hidden="true">${esc(t('Reject'))}</div>
      <div class="rv-card-top"><span class="rv-type">${esc(v.typeLabel || '')}</span><span class="rv-no">${esc(c.claim_no)}</span></div>
      <div class="rv-who">${esc(c.claimant_name || '')}</div>
      <div class="rv-amt">${esc(money(v.amount, c.currency))}</div>
      <div class="rv-meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>
      <div class="rv-lines">${reviewLinesHtml(c)}</div>
      <button type="button" class="btn btn-ghost btn-sm rv-details">${esc(t('View full claim'))}</button>
    </article>`;
}

// Line summary from the full claim (the list rows don't carry lines): up to
// four live lines, then "+N more". Rejected lines are left out.
function reviewLinesHtml(c) {
  const full = review.full.get(reviewKey(c));
  if (!full) return '<div class="rv-line rv-line-skel"></div><div class="rv-line rv-line-skel"></div>';
  const lines = (full.lines || []).filter(l => !lineRejected(l));
  if (!lines.length) return '';
  const shown = lines.slice(0, 4).map(l => {
    const label = l.expense_type || l.job_category || (l.line_date ? l.line_date : '') || l.description || '';
    const sub = l.description && l.description !== label ? l.description : (l.site ? dbFmt(l.site) : '');
    const amt = l.approved_amount != null ? l.approved_amount : l.amount;
    return `<div class="rv-line"><span class="rv-line-l">${esc(label)}${sub ? `<em>${esc(sub)}</em>` : ''}</span><span class="rv-line-a">${esc(money(amt, c.currency))}</span></div>`;
  }).join('');
  const more = lines.length > 4 ? `<div class="rv-more">${esc(t('+{n} more', { n: lines.length - 4 }))}</div>` : '';
  return shown + more;
}

async function loadReviewLines(c, quiet) {
  const key = reviewKey(c);
  if (review.full.has(key)) return;
  try {
    const { claim } = await api(reviewBase(c) + c.id);
    review.full.set(key, claim);
    const el = reviewDeck() && reviewDeck().querySelector(`.rv-card[data-key="${key}"] .rv-lines`);
    if (el) el.innerHTML = reviewLinesHtml(c);
  } catch (ex) { if (!quiet) toast(ex.message, true); }
}

// Fly the top card off in a direction, then show the next one.
function reviewFly(dir, then) {
  const top = reviewDeck() && reviewDeck().querySelector('.rv-card[data-depth="0"]');
  review.busy = true;
  const finish = () => { review.busy = false; then(); };
  if (!top || reducedMotion()) return finish();
  top.style.transition = '';
  top.style.transform = '';
  top.classList.add('fly-' + dir);
  setTimeout(finish, 260);
}

function reviewApprove() {
  const c = reviewCurrent();
  if (!c || review.busy) return;
  flushReviewPending();
  const p = { c, index: review.i };
  p.timer = setTimeout(() => commitReviewApproval(p), REVIEW_UNDO_MS);
  review.pending = p;
  showReviewUndo(t('Approved {no}', { no: c.claim_no }));
  if (navigator.vibrate) navigator.vibrate(12);
  reviewFly('right', () => { review.i++; renderReview(); });
}

// Send a held approval now (deck closing, or the next approval coming in).
function flushReviewPending() {
  const p = review.pending;
  if (!p) return Promise.resolve();
  clearTimeout(p.timer);
  return commitReviewApproval(p);
}

async function commitReviewApproval(p) {
  if (review.pending === p) { review.pending = null; hideReviewUndo(); }
  if (p.sent) return;
  p.sent = true;
  try {
    await api(`${reviewBase(p.c)}${p.c.id}/approve`, { method: 'POST', body: JSON.stringify({ rejected_lines: [] }) });
  } catch (ex) {
    // Put it back in front so it isn't silently lost.
    toast(`${p.c.claim_no}: ${ex.message}`, true);
    if (reviewDeck()) {
      const at = review.queue.indexOf(p.c);
      if (at > -1) review.queue.splice(at, 1);
      review.queue.splice(review.i, 0, p.c);
      renderReview('back');
    }
  }
}

function reviewUndo() {
  const p = review.pending;
  if (!p || review.busy) return;
  clearTimeout(p.timer);
  review.pending = null;
  hideReviewUndo();
  review.i = p.index;
  renderReview('back');
}

let reviewUndoTimer = null;
function showReviewUndo(text) {
  const bar = reviewDeck() && reviewDeck().querySelector('.rv-undo');
  if (!bar) return;
  bar.querySelector('.rv-undo-txt').textContent = text;
  bar.hidden = false;
  bar.classList.remove('run'); void bar.offsetWidth; bar.classList.add('run');
  clearTimeout(reviewUndoTimer);
  reviewUndoTimer = setTimeout(hideReviewUndo, REVIEW_UNDO_MS);
}
function hideReviewUndo() {
  const bar = reviewDeck() && reviewDeck().querySelector('.rv-undo');
  if (bar) bar.hidden = true;
}

function reviewSkip() {
  const c = reviewCurrent();
  if (!c || review.busy) return;
  if (review.queue.length - review.i < 2) { snapReviewCard(); return; } // nothing to skip to
  reviewFly('up', () => {
    review.queue.splice(review.i, 1);
    review.queue.push(c);
    renderReview();
  });
}

// Reject goes through the usual form (a reason is required). The card waits in
// the middle; once the claim really is rejected it flies off to the left.
function reviewReject() {
  const c = reviewCurrent();
  if (!c || review.busy) return;
  flushReviewPending();
  snapReviewCard();
  openRejectModal(c);
  modalCloseHook = () => reviewRecheck(c, 'left');
}

function reviewDetails() {
  const c = reviewCurrent();
  if (!c || review.busy) return;
  review.detailsOf = c;
  openDrawer(c.id, c.type);
}
// drawer.js calls this whenever the drawer closes: if the claim opened from
// the deck was approved or rejected there, move on.
function reviewAfterDrawer() {
  const c = review.detailsOf;
  review.detailsOf = null;
  if (c && reviewDeck()) reviewRecheck(c, 'right');
}

async function reviewRecheck(c, dir) {
  const key = reviewKey(c);
  if (review.checking.has(key)) return;
  review.checking.add(key);
  try {
    const { claim } = await api(reviewBase(c) + c.id);
    claim.type = c.type;
    if (reviewCurrent() === c && !isMyTurn(claim)) {
      if (claim.status === 'rejected' || claim.status === 'rejected_realize') dir = 'left';
      reviewFly(dir, () => { review.i++; renderReview(); });
    }
  } catch (ex) { /* the list reload will show the truth */ }
  finally { review.checking.delete(key); }
}

function snapReviewCard() {
  const top = reviewDeck() && reviewDeck().querySelector('.rv-card[data-depth="0"]');
  if (!top) return;
  top.style.transition = 'transform .28s var(--ease-out)';
  top.style.transform = '';
  top.style.setProperty('--ok', 0); top.style.setProperty('--no', 0);
}

// Drag the top card. Starts only on the card itself (not its button) and not
// at the screen edge, where Android's back gesture lives. Crossing the
// threshold buzzes once; letting go past it acts, short of it springs back.
function wireReviewSwipe(card) {
  let start = null, crossed = false;
  const limit = () => Math.min(140, window.innerWidth * 0.28);
  card.addEventListener('pointerdown', e => {
    if (review.busy || e.button > 0 || e.target.closest('button')) return;
    if (e.clientX < 24 || e.clientX > window.innerWidth - 24) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    crossed = false;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    card.style.transform = `translate(${dx / z}px, ${Math.min(dy, 40) / z}px) rotate(${dx / 22}deg)`;
    card.style.setProperty('--ok', Math.max(0, Math.min(1, dx / limit())));
    card.style.setProperty('--no', Math.max(0, Math.min(1, -dx / limit())));
    const over = Math.abs(dx) > limit() || -dy > limit();
    if (over !== crossed) { crossed = over; if (over && navigator.vibrate) navigator.vibrate(8); }
  });
  const end = e => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (dx > limit()) reviewApprove();
    else if (dx < -limit()) reviewReject();
    else if (-dy > limit() && Math.abs(dx) < limit()) reviewSkip();
    else snapReviewCard();
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', e => { if (start && e.pointerId === start.id) { start = null; snapReviewCard(); } });
}
