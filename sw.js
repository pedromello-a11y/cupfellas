// Service worker do CupFellas.
// 1) Cumpre o requisito de instalação do PWA (Chrome/Android exige SW com fetch).
// 2) Recebe Web Push e mostra notificação MESMO COM O APP FECHADO.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));

// push: o robô (rats/worldfellas-triggers.js) manda {title, body, tag, url}
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "⚽ CupFellas", {
      body: d.body || "",
      icon: "/assets/icons/icon-192.png",
      badge: "/assets/icons/icon-192.png",
      tag: d.tag || "cupfellas",
      renotify: true,
      data: { url: d.url || "/" },
    })
  );
});

// clicar na notificação foca/abre o app
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ("focus" in w) return w.focus(); }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
