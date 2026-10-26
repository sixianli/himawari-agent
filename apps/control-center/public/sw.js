self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data ? event.data.json() : null;
  } catch {
    message = null;
  }
  const notification = message?.notification;
  if (!notification || typeof notification.title !== "string") return;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(notification.title, {
        body: typeof notification.body === "string" ? notification.body : "",
        lang: typeof notification.lang === "string" ? notification.lang : undefined,
        tag: typeof notification.tag === "string" ? notification.tag : undefined,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { navigate: typeof notification.navigate === "string" ? notification.navigate : "/" },
      }),
      notification.app_badge && "setAppBadge" in self.navigator
        ? self.navigator.setAppBadge(Number(notification.app_badge)).catch(() => undefined)
        : Promise.resolve(),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.navigate ?? "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === target.origin);
      if (open)
        return open
          .focus()
          .then((client) => client.navigate(target.href))
          .catch(() => self.clients.openWindow(target.href));
      return self.clients.openWindow(target.href);
    }),
  );
});
