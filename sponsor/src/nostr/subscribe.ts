import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, CLIENT_TAG } from './constants';

export interface SubscriptionCallbacks {
  /** status=active 이벤트 수신 */
  onActive: (event: Event) => void;
  /** status=sold 이벤트 수신 (삭제 처리용) */
  onSold: (event: Event) => void;
  /** 초기 로딩 완료 (stored events 모두 수신) */
  onEose: () => void;
}

/**
 * 사줘 요청 이벤트를 실시간 구독한다.
 *
 * active 이벤트 → upsert, sold 이벤트 → 삭제 처리를 위해 status 무관하게 모두 수신.
 * 반환: cleanup 함수 (구독 해제 + pool 파괴)
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
      '#t': [CLIENT_TAG],
    },
    {
      onevent: (event) => {
        const statusTag = event.tags.find(t => t[0] === 'status')?.[1];
        if (statusTag === 'active') {
          callbacks.onActive(event);
        } else if (statusTag === 'sold') {
          callbacks.onSold(event);
        }
      },
      oneose: callbacks.onEose,
    },
  );

  console.log('[Nostr] Subscribed to sajwo requests on', relays.length, 'relays');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[Nostr] Subscription closed');
  };
}
