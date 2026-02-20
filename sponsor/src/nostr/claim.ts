/**
 * 클레임 이벤트 발행
 *
 * kind 1111로 Admin에게 클레임 요청을 발행한다.
 * a-tag으로 Admin의 오더를 참조하고, bolt11 태그에 유동성 검증용 인보이스를 포함한다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import {
  SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND,
  CLIENT_TAG,
  APP_PUBKEY,
  getSecretKey,
  getReadRelays,
  type Order,
} from '@sajwo-tracker/shared';
import { storage } from './storage';

/**
 * 특정 오더에 대해 클레임 이벤트를 발행한다.
 *
 * Tags:
 *   ['a', '30402:<APP_PUBKEY>:<orderId>']  - Admin 오더 참조
 *   ['action', 'claim']                    - 요청 종류
 *   ['p', APP_PUBKEY]                      - Admin 디스커버리용
 *   ['t', CLIENT_TAG]                      - 클라이언트 식별
 *   ['bolt11', invoice]                    - 유동성 검증용 인보이스
 *   ['expiration', ...]                    - 오더 만료 시각
 */
export async function publishClaim(order: Order, bolt11: string): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const relays = await getReadRelays(storage);

  const aCoord = `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`;
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ['a', aCoord],
    ['action', 'claim'],
    ['p', APP_PUBKEY],
    ['t', CLIENT_TAG],
    ['bolt11', bolt11],
  ];

  if (order.expiration > 0) {
    tags.push(['expiration', String(order.expiration)]);
  }

  const template = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: now,
    tags,
    content: '',
  };

  const signed = finalizeEvent(template, sk);

  console.log('[Nostr] Publishing claim for order', order.orderId, 'event:', signed.id);

  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    for (const r of results) {
      if (r.status === 'fulfilled') {
        console.log('[Nostr] Claim published to:', r.value);
      } else {
        console.warn('[Nostr] Claim publish failed:', String(r.reason));
      }
    }
    return ok;
  } finally {
    pool.destroy();
  }
}
