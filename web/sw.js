/* FlickSync service worker — caches the shell so the app opens instantly.
   Media and API calls always go to the network (never cached). */

const CACHE = 'flicksync-v1';
const SHELL = ['/', '/style.css', '/app.js', '/sync.js', '/players.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;       // CDNs, media hosts: straight to network
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => cached || Response.error())),
  );
});
