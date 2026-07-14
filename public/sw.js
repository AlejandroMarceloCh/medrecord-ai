// sw.js — cachea el shell de la app para que ABRA sin conexión.
//
// El móvil prometía "Sin conexión. Tus grabaciones se guardan y se suben solas al volver",
// pero sin red la app ni siquiera cargaba: React y Babel venían de unpkg. Pantalla en
// blanco, con el paciente sentado enfrente. Ahora el bundle es local y esto lo precachea.
//
// Nunca cacheamos /api ni el WebSocket: la data clínica no se guarda en el Cache Storage
// del navegador. Solo el cascarón de la app.
const CACHE = 'medrecord-shell-v1';
const SHELL = [
  '/mobile',
  '/mobile.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // un asset que falte no debe impedir instalar
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // nada de terceros
  if (url.pathname.startsWith('/api/')) return;         // la PII nunca va al cache
  if (url.pathname === '/health') return;

  // Network-first con respaldo en cache: si hay red, siempre la versión fresca (así una
  // actualización del código llega sin que nadie borre nada); si no la hay, el shell.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/mobile')))
  );
});
