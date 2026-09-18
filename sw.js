/* РУКА — сервис-воркер прототипа. Кэширует само приложение,
   чтобы после первого открытия оно работало и без сети. */
const CACHE = 'ruka-manager-v5';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

/* addAll — атомарный: одна неудавшаяся ссылка валит всю установку и приложение
   никогда не закэшируется для офлайна. Кэшируем по одной, ошибка одной не
   мешает остальным — сам сайт при этом всё равно открывается по сети */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.all(ASSETS.map(url => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* сеть в приоритете (чтобы правки сразу доходили), кэш — запасной вариант
   офлайн. Только свой источник — чужие запросы (шрифты и т.п.) сервис-воркер
   не трогает вовсе, их обрабатывает сам браузер как обычно. Замена ответа на
   index.html — только для навигации (открытие/переход страницы), а не для
   вложенных запросов (манифест/иконки/шрифты), иначе при сбое сети вместо
   картинки или манифеста подставился бы HTML */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
        return res;
      })
      .catch(() =>
        caches.match(req).then(res => res || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
      )
  );
});
