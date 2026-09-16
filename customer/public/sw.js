const CACHE_NAME = 'static-v1';

// ── Web Push ─────────────────────────────────────────────────────────
//
// 브라우저가 닫혀 있어도 여기가 깨어난다. 안드로이드는 구글 플레이 서비스가
// 크롬을 대신 깨우고, iOS는 홈 화면에 추가한 PWA일 때 APNs가 깨운다.
// PC는 창이 아니라 브라우저 프로세스가 살아 있어야 한다.
//
// 페이로드는 어드민이 RFC 8291로 암호화해 보냈고, 복호화는 브라우저가
// 이미 끝낸 상태로 여기 들어온다. 푸시 서비스는 암호문만 봤다.

self.addEventListener('push', (event) => {
  // userVisibleOnly 구독이라 알림을 반드시 띄워야 한다.
  // 안 띄우면 브라우저가 경고를 대신 띄우고, 반복되면 구독을 끊는다.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || '페어바이';
  const options = {
    body: payload.body || '거래에 변화가 있습니다.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    // tag를 orderId로 주면 같은 주문의 알림이 쌓이지 않고 최신 것으로 대체된다.
    tag: payload.tag || 'pairbuy',
    renotify: true,
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  // 이미 열린 탭이 있으면 거기로 보낸다. 매번 새 탭을 여는 건 성가시다.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

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
      // 캐시에도 없으면 undefined가 되는데, respondWith(undefined)는
      // "Failed to convert value to 'Response'"로 터진다. 네트워크가 끊긴
      // 상태에서 처음 보는 경로를 열면 바로 이 경우다 — 반드시 Response를 준다.
      .catch(async () => (await caches.match(event.request)) ?? Response.error()),
  );
});
