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
      // Si la app ya está abierta, la enfocamos en vez de abrir otra — buscamos coincidencia
      // exacta de url primero y si no, cualquier ventana abierta (la url del push puede llevar
      // un ?parametro que la pestaña ya abierta no tiene en su barra de direcciones).
      const client = clientList.find((c) => c.url === url) || clientList[0];
      if (client && 'focus' in client) {
        // Enfocar NO recarga la página, así que el JS que ya está corriendo ahí no se entera del
        // nuevo push por sí solo — solo avisamos por mensaje para el aviso de "hay novedades"
        // (con su ?novedades=1), no para el resto de notificaciones normales de la app.
        if (url.includes('novedades=1')) client.postMessage({ type: 'novedades-disponibles', url });
        return client.focus();
      }
      // Si no hay ninguna ventana abierta, se abre una nueva — esa ya carga el index.html fresco.
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
