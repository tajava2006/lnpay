import type { Event } from 'nostr-tools/core';

// ── 후원자 측 주문 상태 ────────────────────────────

/**
 * 후원자 앱에서의 주문 상태
 *
 * - detected: 오더북에서 발견 (초기 상태)
 * - claimed: 사주겠다고 클레임 발행함 (어드민 검증 대기)
 */
export type SponsorOrderStatus = 'detected' | 'claimed';

/** 허용된 상태 전이 */
export const SPONSOR_TRANSITIONS: Record<SponsorOrderStatus, SponsorOrderStatus[]> = {
  detected: ['claimed'],
  claimed: [],
};

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
  /** 후원자 측 상태 */
  status: SponsorOrderStatus;
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
    status: 'detected',
  };
}
