'use strict';

// Step-by-step guide: dims the screen, cuts a lit "hole" around one element at
// a time and explains it in a bubble beside it (Back / Next / Skip). A plain
// <script> sharing globals with app.js; forms build their own steps and call
// runGuide (the GPS meal form: js/meal-gps.js).
//
// Steps: { el: () => Element | null, title, html } — `el` is re-queried every
// time the guide paints, so a form that re-renders underneath it still works;
// a step whose element is missing or hidden is skipped. While the guide is open
// the page underneath can't be clicked; Esc or "Skip" closes it.

let guideState = null;

const guideVisible = (el) => !!el && el.isConnected && !el.closest('[hidden]') && el.getClientRects().length > 0;

function runGuide(steps, { onEnd } = {}) {
  endGuide();
  const shown = () => steps.filter(s => guideVisible(s.el()));
  const block = document.createElement('div');
  block.className = 'guide-block';
  const hole = document.createElement('div');
  hole.className = 'guide-hole';
  const bubble = document.createElement('div');
  bubble.className = 'guide-bubble';
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-live', 'polite');
  document.body.append(block, hole, bubble);
  guideState = { steps, i: 0, block, hole, bubble, onEnd, timer: null, onKey: null, onMove: null, last: null };

  const paint = (scroll) => {
    const list = shown();
    if (!list.length) return endGuide();
    const g = guideState;
    if (g.i >= list.length) g.i = list.length - 1;
    const step = list[g.i];
    const el = step.el();
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    // The root is zoomed (80% on desktop, styles.css --app-zoom): rects come back
    // in screen pixels, while the fixed hole and bubble are placed in CSS pixels.
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const sr = el.getBoundingClientRect();
    const r = { top: sr.top / z, left: sr.left / z, width: sr.width / z, height: sr.height / z, bottom: sr.bottom / z };
    const pad = 6;
    Object.assign(hole.style, { top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    if (g.last !== step || scroll) {
      g.last = step;
      const n = list.length, at = g.i + 1;
      bubble.innerHTML = `
        <div class="guide-top"><span class="guide-count">${esc(t('Step {n} of {m}', { n: at, m: n }))}</span>
          <button type="button" class="guide-skip" data-g="skip">${esc(t('Skip guide'))}</button></div>
        <h3 class="guide-title">${esc(step.title)}</h3>
        <div class="guide-text">${step.html}</div>
        <div class="guide-dots" aria-hidden="true">${list.map((_, k) => `<span class="${k === g.i ? 'on' : k < g.i ? 'done' : ''}"></span>`).join('')}</div>
        <div class="guide-acts">
          ${g.i ? `<button type="button" class="btn btn-ghost btn-sm" data-g="back">${esc(t('Back'))}</button>` : ''}
          <button type="button" class="btn btn-primary btn-sm" data-g="next">${esc(at === n ? t('Got it') : t('Next'))}</button>
        </div>`;
      bubble.querySelector('[data-g="next"]').focus({ preventScroll: true });
    }
    // Beside the lit element: below if it fits, else above, else over the bottom.
    const vw = document.documentElement.clientWidth / z, vh = window.innerHeight / z, gap = 12;
    const w = Math.min(360, vw - 24);
    bubble.style.width = `${w}px`;
    const h = bubble.offsetHeight;
    let top = r.bottom + pad + gap;
    if (top + h > vh - 12) top = r.top - pad - gap - h >= 12 ? r.top - pad - gap - h : Math.max(12, vh - h - 12);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), vw - w - 12);
    Object.assign(bubble.style, { top: `${top}px`, left: `${left}px` });
  };
  const go = (d) => {
    const n = shown().length;
    if (guideState.i + d >= n) return endGuide();
    guideState.i = Math.max(0, guideState.i + d);
    paint(true);
  };
  bubble.addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    if (b.dataset.g === 'next') go(1);
    else if (b.dataset.g === 'back') go(-1);
    else endGuide();
  });
  guideState.onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); endGuide(); }
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  };
  guideState.onMove = () => paint(false);
  document.addEventListener('keydown', guideState.onKey, true);
  window.addEventListener('resize', guideState.onMove);
  document.addEventListener('scroll', guideState.onMove, true);
  // The form may re-render under the guide (customer sites arriving, say).
  guideState.timer = setInterval(guideState.onMove, 400);
  paint(true);
}

function endGuide() {
  const g = guideState;
  if (!g) return;
  guideState = null;
  clearInterval(g.timer);
  document.removeEventListener('keydown', g.onKey, true);
  window.removeEventListener('resize', g.onMove);
  document.removeEventListener('scroll', g.onMove, true);
  g.block.remove(); g.hole.remove(); g.bubble.remove();
  if (g.onEnd) g.onEnd();
}

// Whether this account has already been through a guide on this device.
// Storage can be missing (private mode); then the guide just offers itself again.
function guideSeen(key) {
  try { return localStorage.getItem(`guide.${key}.${(state.user && state.user.id) || ''}`) === '1'; } catch { return false; }
}
function markGuideSeen(key) {
  try { localStorage.setItem(`guide.${key}.${(state.user && state.user.id) || ''}`, '1'); } catch { /* not stored: offered again next time */ }
}
