// Service worker do Social Station.
//
// IMPORTANTE: esse SW existe só pra deixar o site "instalável" como PWA.
// Ele propositalmente NÃO guarda o HTML/JS/CSS do app em cache — assim,
// toda vez que a pessoa abrir o app com internet, ela recebe a versão mais
// nova automaticamente, sem precisar desinstalar nem limpar nada.
// A única coisa em cache é uma paginazinha simples pra mostrar quando
// a pessoa abrir o app totalmente sem internet.

const CACHE_NAME = 'social-station-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // só intercepta navegação de página (abrir o app) — todo o resto
  // (socket.io, API, imagens) passa direto pra rede, sem cache.
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL))
  );
});
