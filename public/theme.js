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
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var listeners = [];

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; }
    catch (e) { return null; }
  }
  function resolved() { return stored() || (mq && mq.matches ? 'dark' : 'light'); }

  // Mobile browser chrome (address bar) tint, matched to the page background.
  function syncMeta(theme) {
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
    m.content = theme === 'dark' ? '#131315' : '#f5f4f2';
  }

  function apply() {
    var theme = resolved();
    if (root.getAttribute('data-theme') !== theme) {
      // Swap every colour at once: without this, each element's own colour
      // transition would fade on its own schedule and the switch would ripple.
      root.classList.add('theme-switching');
      root.setAttribute('data-theme', theme);
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
    onChange: function (fn) { listeners.push(fn); }
  };
})();
