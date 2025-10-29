const CACHE_NAME = 'bella-vita-cache-v1';
const urlsToCache = [
  '/',
  '/index.html', // Add other static files if needed (CSS, JS specific files)
  // Add paths to your actual icons here
  'https://placehold.co/192x192/FDCB01/121212?text=BV',
  'https://placehold.co/512x512/FDCB01/121212?text=BV',
  'https://fonts.googleapis.com/css2?family=Poppins:wght@400;700;900&family=Tajawal:wght@400;500;700;800&display=swap'
];

// Install event: Cache core assets
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

// Activate event: Clean up old caches
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event: Serve cached assets or fetch from network
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
        // Cache hit - return response
        if (response) {
          return response;
        }
        // Not in cache - fetch from network, cache it, then return
        return fetch(event.request).then(
          networkResponse => {
            // Check if we received a valid response
            if(!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
              return networkResponse;
            }
            // IMPORTANT: Clone the response. A response is a stream
            // and because we want the browser to consume the response
            // as well as the cache consuming the response, we need
            // to clone it so we have two streams.
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
            return networkResponse;
          }
        ).catch(error => {
            console.error('Fetching failed:', error);
            // Optional: Return a fallback offline page if fetch fails
        });
      })
    );
});
