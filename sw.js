// Service worker for the World Cup 2026 schedule.
// Scope is the SW's own directory (/wc/ on GitHub Pages) since it is registered
// with a relative path.
//
// Caching strategy (the critical rule for this project):
//   • App SHELL (HTML/CSS/JS/icons) ............ cache-first  (instant, offline)
//   • data/tournament.json ..................... NETWORK-FIRST (never frozen!)
//   • cross-origin (flag SVGs, fonts) .......... stale-while-revalidate
//
// data/tournament.json is auto-updated by a cron Action; serving it cache-first
// would freeze live results, so it is always fetched fresh with a cached
// last-known fallback for offline.

const SHELL = 'wc-shell-v5';
const DATA = 'wc-data-v1';
const RUNTIME = 'wc-runtime-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './match.html',
  './predict.html',
  './assets/styles.css',
  './assets/match.css',
  './assets/app.js',
  './assets/match.js',
  './assets/engine.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_ASSETS);
    // seed the data cache so the very first offline open still has fixtures
    // (boot's own fetch can race ahead of the SW taking control)
    try { const data = await caches.open(DATA); await data.add('./data/tournament.json'); } catch (e2) { /* offline install */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => ![SHELL, DATA, RUNTIME].includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 0) FIFA live API — always go to network (never cache live match data)
  if (url.host === 'api.fifa.com') return;

  // 1) tournament data — NETWORK-FIRST (results must never be stale-cached)
  if (url.pathname.endsWith('/data/tournament.json')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        const c = await caches.open(DATA);
        c.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(req);
        return cached || new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // 2) same-origin shell — cache-first, fall back to network, then app shell
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200 && fresh.type === 'basic') {
          const c = await caches.open(SHELL);
          c.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw err;
      }
    })());
    return;
  }

  // 3) cross-origin (flag SVGs, web fonts) — stale-while-revalidate
  e.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    const cached = await cache.match(req);
    const fetching = fetch(req)
      .then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; })
      .catch(() => cached);
    return cached || fetching;
  })());
});
