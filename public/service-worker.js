// Web Push notifications for HyperCheese.  The subscribe flow lives in
// app/assets/javascripts/gallery/notifications.coffee; the payload comes
// from WebPushSender on the server.

self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'HyperCheese', {
      body: data.body || '',
      icon: '/images/icon.png',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(url));
});
