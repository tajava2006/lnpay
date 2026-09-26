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

  // 유저 앱 sw.js와 같은 처리 — 둘이 갈라져 있었다(린터가 잡았다)
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          // no-store 요청은 Cache.put이 거부할 수 있다. 캐싱은 부수효과라 실패해도 응답엔 영향이 없게 삼킨다
          caches.open(CACHE_NAME)
            .then(c => c.put(event.request, clone))
            .catch(() => {});
        }
        return res;
      })
      // 캐시에도 없으면 respondWith(undefined)로 터진다 — 반드시 Response를 준다
      .catch(async () => (await caches.match(event.request)) ?? Response.error()),
  );
});
