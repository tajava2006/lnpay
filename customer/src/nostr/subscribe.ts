/**
 * Admin kind 30402 오더 구독
 *
 * Admin이 발행한 오더를 구독한다.
 * Customer pubkey 필터링은 service 레이어에서 수행.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, APP_PUBKEY, CLIENT_TAG, NOSTR_SINCE } from '@sajwo-tracker/shared';

export interface CustomerSubscriptionCallbacks {
  onOrder: (event: Event) => void;
  onEose: () => void;
}

/**
 * Admin kind 30402 오더를 구독한다.
 * 반환: cleanup 함수
 */
export function subscribeAdminOrders(
  relays: string[],
  callbacks: CustomerSubscriptionCallbacks,
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

  console.log('[Customer] Subscribed to Admin orders on', relays.length, 'relays');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[Customer] Admin order subscription closed');
  };
}
