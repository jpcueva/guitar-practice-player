// Offline cache for the app itself (songs live in IndexedDB, not here).
const VERSION = 'gpp-v3';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/engine.js', 'js/timeline.js', 'js/tab.js', 'js/library.js', 'js/importer.js', 'js/beats.js', 'js/pdftab.js',
  'vendor/jszip.min.js', 'vendor/signalsmith-stretch.mjs', 'vendor/alphatab/alphaTab.min.js',
  'vendor/alphatab/font/Bravura.woff2', 'vendor/alphatab/font/Bravura.woff',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up when online), falling back to the cache offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
