import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND } from './constants';
import type { TrackedOrder } from '../shared/types';

/**
 * TrackedOrder를 kind 30078 addressable event로 빌드한다.
 *
 * Tags:
 *   ['d', orderId]                  - addressable identifier (NIP-33)
 *   ['status', orderStatus]         - 현재 주문 상태
 *   ['amount', depositPrice, 'KRW'] - 입금해야 할 금액
 *   ['expiration', unixSeconds]     - NIP-40: 무통장입금 기한
 */
export function buildSajwoRequestEvent(order: TrackedOrder): EventTemplate {
  const tags: string[][] = [
    ['d', order.orderId],
    ['status', order.status],
    ['amount', String(order.virtualAccount.depositPrice), 'KRW'],
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
    content: JSON.stringify(order),
  };
}

/** EventTemplate을 유저의 secret key로 서명한다. */
export function signEvent(template: EventTemplate, secretKey: Uint8Array): VerifiedEvent {
  return finalizeEvent(template, secretKey);
}
