const CACHE = 'coinflip-v7';
const ASSETS = [
  '/',
  '/login.html',
  '/register.html',
  '/wallet.html',
  '/profile.html',
  '/referral.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/css/style2.css?v=3',
  '/js/app2.js?v=3',
  '/js/game2.js?v=3',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Never cache API responses — game data must always be fresh.
  if (new URL(e.request.url).pathname.startsWith('/api')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetched = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
