'use strict';

// ---------------------------------------------------------------------------
// Service worker — makes the portal installable as an app (Chrome's "Install
// app" / Add to Home screen) and shows a friendly offline page instead of the
// browser's dinosaur when a page is opened with no connection.
//
// Deliberately minimal: it never caches /api responses (claims, receipts and
// sessions are per-user and must always come fresh from the server) and never
// serves a stale app shell — pages always go to the network first, so a deploy
// is picked up exactly as it is in a normal tab. Only offline.html and the few
// files it needs are kept, for when the network fails.
//
// Bump VERSION when the offline page or its assets change.
// ---------------------------------------------------------------------------
const VERSION = 'v1';
const CACHE = 'reimb-offline-' + VERSION;
const OFFLINE_ASSETS = ['/offline.html', '/offline.js', '/logo.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Bypass the HTTP cache so the copies stored are the current deploy's.
      .then((cache) => cache.addAll(OFFLINE_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('reimb-offline-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Page loads: always the network; the offline page only when it fails.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // The offline page's own assets, when they can't be fetched.
  if (OFFLINE_ASSETS.includes(url.pathname)) {
    event.respondWith(fetch(req).catch(() => caches.match(url.pathname)));
  }
});
