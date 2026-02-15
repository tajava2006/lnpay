import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND } from '@sajwo-tracker/shared';

// ── 어드민 클레임 상태 ─────────────────────────────

export type AdminClaimStatus = 'pending' | 'approved' | 'rejected';

// ── 클레임 이벤트 (kind 1111) ─────────────────────

export interface ClaimEvent {
  /** 클레임 이벤트 ID */
  id: string;
  /** 후원자 pubkey */
  sponsorPubkey: string;
  /** 참조된 주문의 고객 pubkey (a-tag에서 추출) */
  customerPubkey: string;
  /** 참조된 주문 ID (a-tag에서 추출) */
  orderId: string;
  /** 참조된 주문 이벤트 ID (e-tag) */
  orderEventId: string | null;
  /** 클레임 생성 시각 (unix seconds) */
  createdAt: number;
  /** 어드민 처리 상태 */
  status: AdminClaimStatus;
  /** 원본 Nostr 이벤트 */
  raw: Event;
}

/**
 * kind 1111 이벤트를 ClaimEvent로 파싱한다.
 * a-tag에서 주문 정보를 추출하며, 유효하지 않으면 null 반환.
 */
export function parseClaimEvent(event: Event): ClaimEvent | null {
  // a-tag: "30402:<customer-pubkey>:<orderId>"
  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;

  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return null;

  const customerPubkey = parts[1];
  const orderId = parts[2];

  const orderEventId = event.tags.find(t => t[0] === 'e')?.[1] ?? null;

  return {
    id: event.id,
    sponsorPubkey: event.pubkey,
    customerPubkey,
    orderId,
    orderEventId,
    createdAt: event.created_at,
    status: 'pending',
    raw: event,
  };
}

// ── 주문 참조 정보 (kind 30402) ───────────────────

export interface OrderRef {
  orderId: string;
  pubkey: string;
  price: number;
  currency: string;
  expiresAt: number | null;
  createdAt: number;
  /** 원본 Nostr 이벤트 */
  raw: Event;
}

/**
 * kind 30402 이벤트를 OrderRef로 파싱한다.
 */
export function parseOrderEvent(event: Event): OrderRef | null {
  const dTag = event.tags.find(t => t[0] === 'd')?.[1];
  if (!dTag) return null;

  const priceTag = event.tags.find(t => t[0] === 'price');
  const price = priceTag?.[1] ? Number(priceTag[1]) : 0;
  const currency = priceTag?.[2] ?? 'KRW';

  const expirationTag = event.tags.find(t => t[0] === 'expiration')?.[1];
  const expiresAt = expirationTag ? Number(expirationTag) : null;

  return {
    orderId: dTag,
    pubkey: event.pubkey,
    price,
    currency,
    expiresAt,
    createdAt: event.created_at,
    raw: event,
  };
}
