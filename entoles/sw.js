const CACHE_PREFIX = 'rodios-ne-entoles-';
const CACHE_NAME = CACHE_PREFIX + '2026-08-12-2';
const STATIC_ASSETS = ['./', './manifest.json', '../assets/icon-192.png', '../assets/icon-512.png'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => undefined)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  const accept = event.request.headers.get('accept') || '';
  if(event.request.mode === 'navigate' || accept.includes('text/html')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(event.request, {cache: 'no-store'});
        if(response && response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch (_) {
        return (await cache.match(event.request)) || new Response('Η εφαρμογή δεν είναι διαθέσιμη χωρίς σύνδεση.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if(cached) return cached;
    const response = await fetch(event.request);
    if(response && response.ok) await cache.put(event.request, response.clone());
    return response;
  })());
});
