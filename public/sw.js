const CACHE_NAME = 'bella-vita-cache-v2'; // غيّرنا الإصدار لإجبار التحديث
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png', // <-- السطر ده جديد
  '/icon-512.png', // <-- السطر ده جديد
  'https://fonts.googleapis.com/css2?family=Poppins:wght@400;700;900&family=Tajawal:wght@400;500;700;800&display=swap'
  // سنضيف الأيقونات الحقيقية هنا لاحقًا
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
            return caches.delete(cacheName); // حذف أي كاش قديم
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. Fetch event: Serve cached assets or fetch from network
self.addEventListener('fetch', event => {
  // Always try network first for API calls or non-GET requests
  if (event.request.url.includes('/api/') || event.request.method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // For other GET requests (static assets), try cache first
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response; // Return from cache
        }
        // Not in cache - fetch, cache, and return
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

// --- PUSH NOTIFICATION LOGIC ---

// 4. Listen for push notifications
self.addEventListener('push', event => {
  console.log('[Service Worker] Push Received.');
  let data;
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'Bélla Vita', body: 'لديك تحديث جديد!' };
  }

  const title = data.title || 'Bélla Vita';
  const options = {
    body: data.body || 'لديك رسالة جديدة.',
    icon: data.icon || '/icon-192.png', // تأكد من وجود أيقونة بهذا الاسم
    badge: '/badge-72.png', // أيقونة صغيرة لشريط الإشعارات
    vibrate: [200, 100, 200]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// 5. Handle notification click
self.addEventListener('notificationclick', event => {
  console.log('[Service Worker] Notification click Received.');
  event.notification.close();
  
  // يفتح التطبيق عند الضغط على الإشعار
  event.waitUntil(
    clients.openWindow('/')
  );
});

