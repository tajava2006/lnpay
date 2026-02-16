import type { Event } from 'nostr-tools/core';

// ── 후원자 측 주문 상태 ────────────────────────────

/**
 * 후원자 앱에서의 주문 상태
 *
 * 상태 흐름:
 * detected → claimed → approved → selected → completed
 *                    ↘ rejected
 *
 * - detected: 오더북에서 발견 (초기 상태)
 * - claimed: 사주겠다고 클레임 발행함 (어드민 검증 대기)
 * - approved: 어드민 승인 (유동성 검증 통과, 고객 선택 대기)
 * - rejected: 어드민 거절 (유동성 부족 등, 최종 상태)
 * - selected: 고객이 이 후원자를 선택 (KRW 입금 대기)
 * - completed: 거래 완료 (최종 상태)
 */
export type SponsorOrderStatus =
  | 'detected'
  | 'claimed'
  | 'approved'
  | 'rejected'
  | 'selected'
  | 'completed';

/**
 * 허용된 상태 전이 맵
 * key: 현재 상태, value: 전이 가능한 상태 목록
 */
export const SPONSOR_TRANSITIONS: Record<SponsorOrderStatus, SponsorOrderStatus[]> = {
  detected: ['claimed'],
  claimed: ['approved', 'rejected'],
  approved: ['selected'],
  rejected: [],       // 최종 상태
  selected: ['completed'],
  completed: [],      // 최종 상태
};

// ── 상태 전이 결과 타입 ──────────────────────────────

export type TransitionResult =
  | { success: true; order: SajwoRequest }
  | { success: false; error: TransitionError };

export type TransitionError =
  | { type: 'ORDER_NOT_FOUND'; orderId: string }
  | { type: 'INVALID_TRANSITION'; from: SponsorOrderStatus; to: SponsorOrderStatus };

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
  /** 원본 Nostr 이벤트 (클레임 발행 시 content에 포함용) */
  raw: Event;
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
    raw: event,
  };
}
