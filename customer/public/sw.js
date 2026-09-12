const CACHE_NAME = 'static-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          // no-store 요청은 Cache.put이 거부할 수 있다. 캐싱은 부수효과일 뿐이라
          // 실패해도 응답에는 영향이 없어야 하므로 삼킨다.
          caches.open(CACHE_NAME)
            .then(c => c.put(event.request, clone))
            .catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
