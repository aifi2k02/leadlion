// LeadLion service worker — caches the app shell for instant loads / offline.
// Network-first for HTML/API so data stays fresh; cache-first for static assets.

const CACHE = 'leadlion-v70';
const SHELL = ['/app', '/app.html', '/app.js', '/styles.css', '/logo.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never touch API calls, hosted reports, admin, or other top-level pages —
  // let them always hit the network so they're never served a stale/app shell.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/r/') ||
    url.pathname === '/admin' || url.pathname === '/admin.html' ||
    url.pathname === '/privacy' || url.pathname === '/terms' ||
    url.pathname === '/byok' || url.pathname === '/byok.html' ||
    url.pathname === '/' || url.pathname === '/index.html'
  ) return;

  // Static assets: cache-first.
  if (['/app.js', '/styles.css', '/logo.png', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'].includes(url.pathname)) {
    e.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
      return res;
    })));
    return;
  }

  // App HTML only: network-first, fall back to cached shell offline.
  if (request.mode === 'navigate' && url.pathname.startsWith('/app')) {
    e.respondWith(fetch(request).catch(() => caches.match('/app.html')));
  }
});
