'use strict';

// ---------------------------------------------------------------------------
// Night mode. Loaded synchronously in <head> (before styles paint) so the page
// never flashes light before switching to dark.
//
// The theme follows the device's light/dark setting until the user picks one
// with the toggle; that explicit choice is remembered per device (localStorage)
// and wins from then on. The resolved theme is always written to
// <html data-theme="light|dark">, which is all styles.css keys off.
// ---------------------------------------------------------------------------
(function () {
  var KEY = 'reimb.theme';
  // The look ("classic" | "ios" | "glass") is a second, independent axis: any
  // of them runs light or dark. Stored per device too; written to <html
  // data-style>. Glass is the Modern look plus frosted surfaces, so it sets
  // data-style="ios" and adds <html data-glass>.
  var STYLE_KEY = 'reimb.style';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var listeners = [];

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; }
    catch (e) { return null; }
  }
  function resolved() { return stored() || (mq && mq.matches ? 'dark' : 'light'); }
  function style() {
    try { var v = localStorage.getItem(STYLE_KEY); return v === 'ios' || v === 'glass' ? v : 'classic'; }
    catch (e) { return 'classic'; }
  }

  // Mobile browser chrome (address bar) tint, matched to the page background.
  function syncMeta(theme) {
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    var look = style();
    m.content = theme === 'dark'
      ? (look === 'glass' ? '#070c18' : look === 'ios' ? '#0a1120' : '#131315')
      : (look === 'glass' ? '#e9eef8' : look === 'ios' ? '#f1f3f7' : '#f5f4f2');
  }

  function apply() {
    var theme = resolved();
    var glass = style() === 'glass';
    var look = style() === 'classic' ? null : 'ios';
    if (root.getAttribute('data-theme') !== theme || root.getAttribute('data-style') !== look ||
        root.hasAttribute('data-glass') !== glass) {
      // Swap every colour at once: without this, each element's own colour
      // transition would fade on its own schedule and the switch would ripple.
      root.classList.add('theme-switching');
      root.setAttribute('data-theme', theme);
      if (look) root.setAttribute('data-style', look); else root.removeAttribute('data-style');
      if (glass) root.setAttribute('data-glass', ''); else root.removeAttribute('data-glass');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { root.classList.remove('theme-switching'); });
      });
    }
    syncMeta(theme);
    listeners.forEach(function (fn) { try { fn(theme); } catch (e) { /* ignore */ } });
  }

  apply();
  // Keep following the OS while the user hasn't chosen explicitly.
  if (mq) {
    var onOs = function () { if (!stored()) apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onOs); else if (mq.addListener) mq.addListener(onOs);
  }

  window.Theme = {
    get: resolved,
    set: function (theme) {
      try { localStorage.setItem(KEY, theme === 'dark' ? 'dark' : 'light'); } catch (e) { /* private mode */ }
      apply();
    },
    toggle: function () { this.set(resolved() === 'dark' ? 'light' : 'dark'); },
    getStyle: style,
    setStyle: function (s) {
      try { localStorage.setItem(STYLE_KEY, s === 'ios' || s === 'glass' ? s : 'classic'); } catch (e) { /* private mode */ }
      apply();
    },
    onChange: function (fn) { listeners.push(fn); }
  };
})();
