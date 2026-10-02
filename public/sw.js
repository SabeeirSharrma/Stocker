/* Stocker service worker — offline app shell (spec A2).
 *
 * Strategy:
 *  - navigations: network first, fall back to the cached shell (works offline)
 *  - same-origin build assets: cache first (Vite fingerprints them)
 *  - everything else (provider APIs, fonts): pass through untouched — market
 *    data is cached by the app in IndexedDB with TTL + stale labelling (C1–C3)
 */

const CACHE = 'stocker-shell-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // provider APIs: always network

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(async () => (await caches.match('./index.html')) ?? (await caches.match('./')) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
