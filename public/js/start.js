'use strict';

// Starts the app. Loaded last (see index.html): boot() reaches showApp() and
// every screen, so it must not run until app.js and all of public/js/ are in —
// a fast /api/me could otherwise land before a later script had loaded.
boot();

// Installable app (Chrome "Install app" / Add to Home screen): see sw.js.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* not installable here; the site works the same */ });
  });
}
