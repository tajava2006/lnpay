import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, CLIENT_TAG, APP_PUBKEY, NOSTR_SINCE } from '@sajwo-tracker/shared';

export interface SubscriptionCallbacks {
  /** kind 30402 오더 수신 */
  onOrder: (event: Event) => void;
  /** 초기 로딩 완료 */
  onEose: () => void;
}

/**
 * Admin 발행 오더를 실시간 구독한다.
 * authors=[APP_PUBKEY] 필터로 Admin 이벤트만 수신.
 *
 * 반환: cleanup 함수
 */
export function subscribeSajwoRequests(
  relays: string[],
  callbacks: SubscriptionCallbacks,
): () => void {
  const pool = new SimplePool();

  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_KIND],
      authors: [APP_PUBKEY],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    {
      onevent: callbacks.onOrder,
      oneose: callbacks.onEose,
    },
  );

  console.log('[Nostr] Subscribed to Admin orders on', relays.length, 'relays');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[Nostr] Subscription closed');
  };
}
