/**
 * Sponsor → Admin 요청 이벤트 발행
 *
 * - claim: kind 1111로 클레임 요청을 발행한다.
 * - remit-request: 원화 송금 완료 통보를 발행한다.
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
import { idbMigrateClaim } from '../idb-store';
import type { SponsorRequest } from '../types';

/**
 * 특정 오더에 대해 클레임 이벤트를 발행한다.
 * 성공 시 오더와 클레임 request를 IDB에 원자적으로 이관한다.
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

    // 클레임 성공 시 IDB에 오더 + 클레임 request 원자적 이관
    if (ok) {
      const claimRequest: SponsorRequest = {
        eventId: signed.id,
        orderId: order.orderId,
        action: 'claim',
        pubkey: signed.pubkey,
        createdAt: signed.created_at,
        expiration: order.expiration,
        raw: signed,
      };
      void idbMigrateClaim(order, claimRequest).catch(err => {
        console.warn('[Nostr] IDB claim migration failed for', order.orderId, err);
      });
    }

    return ok;
  } finally {
    pool.destroy();
  }
}

/**
 * 원화 송금 완료 통보를 발행한다 (escrowed → remitted 전이 요청).
 *
 * Tags:
 *   ['a', '30402:<APP_PUBKEY>:<orderId>']  - Admin 오더 참조
 *   ['action', 'remit-request']            - 요청 종류
 *   ['p', APP_PUBKEY]                      - Admin 디스커버리용
 *   ['t', CLIENT_TAG]                      - 클라이언트 식별
 *   ['expiration', ...]                    - 오더 만료 시각
 */
export async function publishRemitRequest(order: Order): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const relays = await getReadRelays(storage);

  const aCoord = `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`;
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ['a', aCoord],
    ['action', 'remit-request'],
    ['p', APP_PUBKEY],
    ['t', CLIENT_TAG],
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

  console.log('[Nostr] Publishing remit-request for order', order.orderId, 'event:', signed.id);

  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    for (const r of results) {
      if (r.status === 'fulfilled') {
        console.log('[Nostr] Remit-request published to:', r.value);
      } else {
        console.warn('[Nostr] Remit-request publish failed:', String(r.reason));
      }
    }
    return ok;
  } finally {
    pool.destroy();
  }
}
