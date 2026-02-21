import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, SAJWO_REQUEST_EVENT_KIND, APP_PUBKEY, CLIENT_TAG, type RequestAction } from '@sajwo-tracker/shared';
import type { TrackedOrder } from '../shared/types';

/**
 * TrackedOrder를 kind 1111 order-request 이벤트로 빌드한다.
 * Admin에게 오더 생성을 요청하는 이벤트.
 *
 * Content: 빈 문자열
 *
 * Tags:
 *   ['a', '30402:<APP_PUBKEY>:<orderId>']  - Admin 오더 주소 참조 (a-tag)
 *   ['action', 'order-request']             - 요청 종류
 *   ['price', depositPrice, 'KRW']         - NIP-99 가격 태그
 *   ['expiration', unixSeconds]             - NIP-40 만료 시각
 *   ['t', 'sajwo-tracker']                  - 클라이언트 식별
 *   ['p', APP_PUBKEY]                       - Admin 참조
 */
function buildOrderRequestEvent(order: TrackedOrder): EventTemplate {
  const tags: string[][] = [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`],
    ['action', 'order-request'],
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
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/**
 * action에 따라 적절한 kind 1111 이벤트를 빌드한다.
 * 현재는 order-request만 지원. 향후 payment-confirm 등 추가 시 여기에 분기.
 */
export function buildRequestEvent(order: TrackedOrder, action: RequestAction): EventTemplate {
  switch (action) {
    case 'order-request':
      return buildOrderRequestEvent(order);
    default:
      throw new Error(`Unsupported request action: ${action}`);
  }
}

/** EventTemplate을 유저의 secret key로 서명한다. */
export function signEvent(template: EventTemplate, secretKey: Uint8Array): VerifiedEvent {
  return finalizeEvent(template, secretKey);
}
