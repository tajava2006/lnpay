import type { Event } from 'nostr-tools/core';
import { decode } from 'bolt11';
import { SAJWO_REQUEST_KIND } from '@sajwo-tracker/shared';

// ── 어드민 클레임 상태 ─────────────────────────────

export type AdminClaimStatus = 'pending' | 'approved' | 'rejected';

// ── 디코딩된 bolt11 인보이스 ───────────────────────

/** 라우트 힌트 홉 (bolt11 r-tag에서 추출) */
export interface RouteHintHop {
  pubkey: string;
  shortChannelId: string;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
  cltvExpiryDelta: number;
}

export interface DecodedBolt11 {
  /** 수신 노드 pubkey (hex) */
  destination: string;
  /** 금액 (satoshi) */
  amountSat: number;
  /** payment hash (hex) — 프로빙에서 절대 사용 금지 */
  paymentHash: string;
  /** 만료 시각 (unix seconds) */
  expiresAt: number;
  /** 라우트 힌트 (프라이빗 채널용, 각 배열이 한 경로의 홉 체인) */
  routeHints: RouteHintHop[][];
}

// ── 인보이스 정보 (bolt11 + 디코딩 결과 + 유동성 검증) ──

export interface Invoice {
  /** 원본 bolt11 문자열 */
  bolt11: string;
  /** 디코딩 결과 (디코딩 실패 시 null) */
  decoded: DecodedBolt11 | null;
  /** 인바운드 유동성 검증 완료 여부 */
  liquidityVerified: boolean;
}

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
  /** 인보이스 정보 (bolt11 태그가 없으면 null) */
  invoice: Invoice | null;
  /** 클레임 생성 시각 (unix seconds) */
  createdAt: number;
  /** 어드민 처리 상태 */
  status: AdminClaimStatus;
  /** 원본 Nostr 이벤트 */
  raw: Event;
}

// ── bolt11 디코딩 ─────────────────────────────────

/**
 * bolt11 문자열을 디코딩한다.
 * bolt11 패키지가 서명에서 payeeNodeKey를 자동 복원한다.
 * 디코딩 실패 시 콘솔에 경고를 남기고 null 반환.
 */
function decodeBolt11(bolt11: string): DecodedBolt11 | null {
  try {
    const result = decode(bolt11);

    const destination = result.payeeNodeKey;
    if (!destination) return null;

    const amountSat = result.satoshis ?? 0;
    if (amountSat <= 0) return null;

    const paymentHash = result.tagsObject.payment_hash ?? '';
    const expiresAt = result.timeExpireDate ?? 0;

    // 라우트 힌트 추출 (r-tag, 프라이빗 채널용)
    // 각 routing_info 태그가 하나의 경로(홉 체인)를 나타냄
    const routeHints: RouteHintHop[][] = result.tags
      .filter((t): t is { tagName: 'routing_info'; data: NonNullable<typeof result.tagsObject.routing_info> } =>
        t.tagName === 'routing_info' && Array.isArray(t.data),
      )
      .map(t => t.data.map(h => ({
        pubkey: h.pubkey,
        shortChannelId: h.short_channel_id,
        feeBaseMsat: h.fee_base_msat,
        feeProportionalMillionths: h.fee_proportional_millionths,
        cltvExpiryDelta: h.cltv_expiry_delta,
      })));

    return {
      destination,
      amountSat,
      paymentHash,
      expiresAt,
      routeHints,
    };
  } catch (e) {
    console.warn('[decodeBolt11] 디코딩 실패:', e);
    return null;
  }
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
  const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1] ?? null;

  const invoice: Invoice | null = bolt11
    ? { bolt11, decoded: decodeBolt11(bolt11), liquidityVerified: false }
    : null;

  return {
    id: event.id,
    sponsorPubkey: event.pubkey,
    customerPubkey,
    orderId,
    orderEventId,
    invoice,
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
