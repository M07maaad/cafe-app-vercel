const CACHE_NAME = 'bella-vita-cache-v4';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-144.png',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Poppins:wght@400;700;900&family=Tajawal:wght@400;500;700;800&display=swap'
];

// 1. Install event: Cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
          console.error('Failed to cache', err);
      })
  );
  self.skipWaiting();
});

// 2. Activate event: Clean up old caches
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName); // حذف أي كاش قديم (مثل v2)
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. Fetch event: Serve cached assets or fetch from network
self.addEventListener('fetch', event => {
  if (event.request.url.includes('/api/') || event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response; // Return from cache
        }
        return fetch(event.request).then(
          networkResponse => {
            if(!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
              return networkResponse;
            }
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
            return networkResponse;
          }
        );
      })
    );
});

// 4. Listen for push notifications
self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch (e) { data = { title: 'Bélla Vita', body: 'لديك تحديث جديد!' }; }
  const title = data.title || 'Bélla Vita';
  const options = {
    body: data.body || 'لديك رسالة جديدة.',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200]
  };
  event.waitUntil( self.registration.showNotification(title, options) );
});

// 5. Handle notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil( clients.openWindow('/') );
});

