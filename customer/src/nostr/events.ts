import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, APP_PUBKEY, CLIENT_TAG } from './constants';
import type { TrackedOrder } from '../shared/types';

/**
 * NIP-99 Classified Listing status로 매핑.
 * 내부 상태(detected, requested, claimed, selected)는 모두 'active',
 * 최종 상태(paid, cancelled)는 'sold'로 매핑한다.
 */
function toListingStatus(orderStatus: TrackedOrder['status']): 'active' | 'sold' {
  if (orderStatus === 'paid' || orderStatus === 'cancelled') {
    return 'sold';
  }
  return 'active';
}

/**
 * TrackedOrder를 kind 30402 (NIP-99 Classified Listing) addressable event로 빌드한다.
 *
 * Content: 빈 문자열 (모든 정보는 태그로 전달)
 *
 * Tags:
 *   ['d', orderId]                  - NIP-33 addressable identifier
 *   ['status', 'active'|'sold']     - NIP-99 리스팅 상태
 *   ['price', depositPrice, 'KRW']  - NIP-99 가격 태그
 *   ['expiration', unixSeconds]     - NIP-40 만료 시각
 *   ['t', 'sajwo-tracker']          - 클라이언트 식별 (다른 30402 이벤트와 구분)
 *   ['p', APP_PUBKEY]               - 어드민이 항상 볼 수 있도록
 */
export function buildSajwoRequestEvent(order: TrackedOrder): EventTemplate {
  const tags: string[][] = [
    ['d', order.orderId],
    ['status', toListingStatus(order.status)],
    ['price', String(order.virtualAccount.depositPrice), 'KRW'],
    ['t', CLIENT_TAG],
    ['p', APP_PUBKEY],
  ];

  // NIP-40 expiration: 쿠팡은 milliseconds, Nostr는 seconds
  if (order.virtualAccount.expirationDate) {
    const expirationSeconds = Math.floor(order.virtualAccount.expirationDate / 1000);
    tags.push(['expiration', String(expirationSeconds)]);
  }

  return {
    kind: SAJWO_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** EventTemplate을 유저의 secret key로 서명한다. */
export function signEvent(template: EventTemplate, secretKey: Uint8Array): VerifiedEvent {
  return finalizeEvent(template, secretKey);
}
