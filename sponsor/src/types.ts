import type { Event } from 'nostr-tools/core';

/** Nostr 이벤트를 파싱한 사줘 요청 */
export interface SajwoRequest {
  /** 이벤트 ID */
  id: string;
  /** 요청자 pubkey */
  pubkey: string;
  /** 주문 ID (d-tag) */
  orderId: string;
  /** 입금 금액 */
  price: number;
  /** 통화 */
  currency: string;
  /** NIP-40 만료 시각 (unix seconds), 없으면 null */
  expiresAt: number | null;
  /** 이벤트 생성 시각 (unix seconds) */
  createdAt: number;
}

/**
 * kind 30402 이벤트를 SajwoRequest로 파싱한다.
 * 필수 태그가 없으면 null을 반환한다.
 */
export function parseEvent(event: Event): SajwoRequest | null {
  const dTag = event.tags.find(t => t[0] === 'd')?.[1];
  if (!dTag) return null;

  const priceTag = event.tags.find(t => t[0] === 'price');
  const price = priceTag?.[1] ? Number(priceTag[1]) : 0;
  const currency = priceTag?.[2] ?? 'KRW';

  const expirationTag = event.tags.find(t => t[0] === 'expiration')?.[1];
  const expiresAt = expirationTag ? Number(expirationTag) : null;

  return {
    id: event.id,
    pubkey: event.pubkey,
    orderId: dTag,
    price,
    currency,
    expiresAt,
    createdAt: event.created_at,
  };
}
