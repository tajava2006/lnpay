import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, SAJWO_REQUEST_EVENT_KIND, CLIENT_TAG, APP_PUBKEY, NOSTR_SINCE } from '@sajwo-tracker/shared';

export interface AdminSubscriptionCallbacks {
  /** kind 1111 요청 이벤트 수신 (Admin 자기 에코 포함 — p=APP_PUBKEY 태그로 자동 수신) */
  onRequest: (event: Event) => void;
  /** kind 30402 오더 수신 (자기 발행 이벤트 동기화) */
  onOrder: (event: Event) => void;
  /** 초기 로딩 완료 */
  onEose: () => void;
}

/**
 * 어드민용 Nostr 구독.
 * - kind 1111 (requests): #p=APP_PUBKEY, #t=CLIENT_TAG
 *   Admin 발행 이벤트도 p=APP_PUBKEY 태그가 포함되어 에코로 자동 수신됨
 * - kind 30402 (orders): authors=APP_PUBKEY, #t=CLIENT_TAG
 *
 * 반환: cleanup 함수
 */
export function subscribeAdmin(
  relays: string[],
  callbacks: AdminSubscriptionCallbacks,
): () => void {
  const pool = new SimplePool();

  let requestEose = false;
  let orderEose = false;

  function checkEose() {
    if (requestEose && orderEose) callbacks.onEose();
  }

  // 요청 구독 (kind 1111) — 고객/스폰서 요청 + Admin 자기 에코 모두 수신
  const requestSub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_EVENT_KIND],
      '#p': [APP_PUBKEY],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    {
      onevent: (event) => {
        callbacks.onRequest(event);
      },
      oneose: () => { requestEose = true; checkEose(); },
    },
  );

  // 오더 구독 (kind 30402) — Admin 자신이 발행한 이벤트만
  const orderSub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_KIND],
      authors: [APP_PUBKEY],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    {
      onevent: (event) => {
        callbacks.onOrder(event);
      },
      oneose: () => { orderEose = true; checkEose(); },
    },
  );

  console.log('[Admin] Subscribed to requests + orders on', relays.length, 'relays');

  return () => {
    requestSub.close();
    orderSub.close();
    pool.destroy();
    console.log('[Admin] Subscriptions closed');
  };
}
