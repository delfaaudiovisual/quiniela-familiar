// La Piripiniela - Service Worker
const CACHE_NAME = 'piripiniela-v1';

// Install
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

// Activate
self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Push notification received
self.addEventListener('push', (e) => {
  if (!e.data) return;

  const data = e.data.json();
  const title = data.title || 'La Piripiniela';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon.png',
    badge: '/icon.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'Ver apuestas' }
    ]
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open, focus it and tell it a new push arrived — since focusing does NOT
      // reload the page, the JS still running there needs to know to offer a manual "Actualizar"
      // (the fresh index.html only loads if we actually open a new window, below).
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          client.postMessage({ type: 'novedades-disponibles' });
          return client.focus();
        }
      }
      // Otherwise open new window — this already fetches the fresh index.html
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
