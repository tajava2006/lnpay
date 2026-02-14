import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, SAJWO_CLAIM_KIND, CLIENT_TAG, APP_PUBKEY } from '@sajwo-tracker/shared';

export interface AdminSubscriptionCallbacks {
  /** kind 1111 클레임 이벤트 수신 */
  onClaim: (event: Event) => void;
  /** kind 30402 active 주문 수신 */
  onOrderActive: (event: Event) => void;
  /** kind 30402 sold 주문 수신 */
  onOrderSold: (event: Event) => void;
  /** 초기 로딩 완료 */
  onEose: () => void;
}

/**
 * 어드민용 Nostr 구독.
 * - kind 1111 (claims): #p=APP_PUBKEY, #t=sajwo-tracker
 * - kind 30402 (orders): #p=APP_PUBKEY, #t=sajwo-tracker
 *
 * 반환: cleanup 함수
 */
export function subscribeAdmin(
  relays: string[],
  callbacks: AdminSubscriptionCallbacks,
): () => void {
  const pool = new SimplePool();

  let claimEose = false;
  let orderEose = false;

  function checkEose() {
    if (claimEose && orderEose) callbacks.onEose();
  }

  // 클레임 구독 (kind 1111)
  const claimSub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_CLAIM_KIND],
      '#p': [APP_PUBKEY],
      '#t': [CLIENT_TAG],
    },
    {
      onevent: callbacks.onClaim,
      oneose: () => { claimEose = true; checkEose(); },
    },
  );

  // 주문 구독 (kind 30402)
  const orderSub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_KIND],
      '#p': [APP_PUBKEY],
      '#t': [CLIENT_TAG],
    },
    {
      onevent: (event) => {
        const statusTag = event.tags.find(t => t[0] === 'status')?.[1];
        if (statusTag === 'sold') {
          callbacks.onOrderSold(event);
        } else {
          callbacks.onOrderActive(event);
        }
      },
      oneose: () => { orderEose = true; checkEose(); },
    },
  );

  console.log('[Admin] Subscribed to claims + orders on', relays.length, 'relays');

  return () => {
    claimSub.close();
    orderSub.close();
    pool.destroy();
    console.log('[Admin] Subscriptions closed');
  };
}
