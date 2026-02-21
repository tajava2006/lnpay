/**
 * Admin kind 30402 오더 이벤트 발행
 *
 * Admin이 유일한 오더 상태 소유자로서 kind 30402를 발행/갱신한다.
 * NIP-46 원격 서명자를 사용하여 APP_PUBKEY로 서명한다.
 * 비즈니스 이벤트이므로 읽기 릴레이에 발행한다.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import {
  SAJWO_REQUEST_KIND,
  CLIENT_TAG,
  getReadRelays,
  type Order,
  type OrderState,
} from '@sajwo-tracker/shared';
import { getSigner } from './nip46';
import { storage } from './storage';

/**
 * Order 데이터로 kind 30402 이벤트를 빌드, 서명, 발행한다.
 * 반환: 서명된 이벤트 (order-store에 raw로 저장하기 위함)
 */
export async function publishOrder(order: Order): Promise<object> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const status = toListingStatus(order.state);
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ['d', order.orderId],
    ['t', CLIENT_TAG],
    ['status', status],
    ['state', order.state],
    ['price', String(order.price), 'KRW'],
    ['customer', order.customerPubkey],
    ['expiration', String(order.expiration)],
  ];
  if (order.sponsorPubkey) {
    tags.push(['sponsor', order.sponsorPubkey]);
  }

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_KIND,
    created_at: now,
    tags,
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('모든 릴레이에 발행 실패');
    console.log('[Admin] Published order', order.orderId, 'state:', order.state, 'to', relays.length, 'relays');
  } finally {
    pool.destroy();
  }

  return signed;
}

/**
 * FSM 상태 → NIP-99 listing status 매핑
 * 최종 상태(paid, cancelled)는 'sold', 나머지는 'active'.
 */
function toListingStatus(state: OrderState): 'active' | 'sold' {
  if (state === 'paid' || state === 'cancelled') {
    return 'sold';
  }
  return 'active';
}
