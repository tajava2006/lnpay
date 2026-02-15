/**
 * 클레임 이벤트 발행
 *
 * NIP-22 Comment (kind 1111)로 사줘 요청(kind 30402)에 대한 클레임을 발행한다.
 * 어드민이 인바운드 유동성 검증 후 고객에게 전달하는 구조.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import {
  SAJWO_CLAIM_KIND,
  SAJWO_REQUEST_KIND,
  CLIENT_TAG,
  APP_PUBKEY,
  getSecretKey,
  getRelays,
} from '@sajwo-tracker/shared';
import { storage } from './storage';
import type { SajwoRequest } from '../types';

/**
 * 특정 사줘 요청에 대해 클레임 이벤트를 발행한다.
 *
 * NIP-22 태그 구조:
 * - K/A/P (대문자): root scope (원본 리스팅)
 * - k/a/e/p (소문자): parent item (top-level 클레임이므로 root와 동일)
 * - t: 클라이언트 식별
 * - p (APP_PUBKEY): 어드민이 #p 필터로 조회 가능하도록
 */
export async function publishClaim(request: SajwoRequest): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const relays = await getRelays(storage);

  const aCoord = `${SAJWO_REQUEST_KIND}:${request.pubkey}:${request.orderId}`;
  const now = Math.floor(Date.now() / 1000);

  const template = {
    kind: SAJWO_CLAIM_KIND,
    created_at: now,
    tags: [
      // Root scope (NIP-22 대문자)
      ['K', String(SAJWO_REQUEST_KIND)],
      ['A', aCoord],
      ['P', request.pubkey],
      // Parent item (top-level이므로 root와 동일)
      ['k', String(SAJWO_REQUEST_KIND)],
      ['a', aCoord],
      ['e', request.id],
      ['p', request.pubkey],
      // 어드민 디스커버리용
      ['p', APP_PUBKEY],
      // 클라이언트 식별
      ['t', CLIENT_TAG],
    ],
    content: JSON.stringify(request.raw),
  };

  const signed = finalizeEvent(template, sk);

  console.log('[Nostr] Publishing claim for order', request.orderId, 'event:', signed.id);

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
