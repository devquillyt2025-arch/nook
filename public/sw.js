const CACHE_NAME = 'nook-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
      .catch(err => console.warn("Failed to cache some files", err))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Only GETs are cacheable (cache.put rejects anything else); leave the rest to the network.
  if (event.request.method !== 'GET') return;
  // Cross-origin requests (Supabase, Google APIs, fonts, favicons) are never cached here (only same-origin
  // 'basic' responses are), so don't intercept them: a request made *by the worker* is checked against the
  // worker's own CSP connect-src, which would block fonts and favicons. Left alone, the page's CSP governs them.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  // Network first for everything, fallback to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Clone the response and cache it
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// ─── Web Push: task reminders ───────────────────────────────────────
// Payload shape sent by the send-task-reminders Edge Function:
//   { title, body, source_type: 'task', source_id, url }
// `url` should be `/?reminder=task:<source_id>` — App.jsx parses that
// query param on load and opens the task straight to its Scheduling tab.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const title = data.title || 'Nook reminder';
  const options = {
    body: data.body || '',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: data.source_id ? `${data.source_type}-${data.source_id}` : undefined,
    data: {
      url: data.url || '/',
      source_type: data.source_type,
      source_id: data.source_id,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// A push payload's url is just data. Only ever navigate to a page of this app.
function sameOriginUrl(raw) {
  const home = self.location.origin + '/';
  try {
    const u = new URL(raw || '/', self.location.origin);
    return u.origin === self.location.origin ? u.href : home;
  } catch { return home; }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = sameOriginUrl(event.notification.data && event.notification.data.url);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus an existing Nook tab if one is open, navigating it to the target.
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      // Otherwise open a new window/tab.
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
