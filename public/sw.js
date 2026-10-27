'use strict';

// Service worker только для пушей о напоминаниях (src/modules/patient/push.js). Страницы и данные не кэшируются.
// Текст пуша нейтральный («Есть напоминание»): на заблокированном экране нет сведений о здоровье.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Капель', {
      body: data.body || 'Есть напоминание',
      tag: data.tag || 'reminder',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/app?tab=chat' },
      icon: '/favicon.svg',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app?tab=chat';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
