import type { Event } from 'nostr-tools/core';
import { decode } from 'bolt11';
import {
  SAJWO_REQUEST_KIND,
  APP_PUBKEY,
  type RequestAction,
  type Order,
  type AdminRequest,
} from '@sajwo-tracker/shared';

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
  destination: string;
  amountSat: number;
  paymentHash: string;
  expiresAt: number;
  routeHints: RouteHintHop[][];
}

export interface Invoice {
  bolt11: string;
  decoded: DecodedBolt11 | null;
  liquidityVerified: boolean;
}

// ── bolt11 디코딩 ─────────────────────────────────

export function decodeBolt11(bolt11: string): DecodedBolt11 | null {
  try {
    const result = decode(bolt11);

    const destination = result.payeeNodeKey;
    if (!destination) return null;

    const amountSat = result.satoshis ?? 0;
    if (amountSat <= 0) return null;

    const paymentHash = result.tagsObject.payment_hash ?? '';
    const expiresAt = result.timeExpireDate ?? 0;

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

    return { destination, amountSat, paymentHash, expiresAt, routeHints };
  } catch (e) {
    console.warn('[decodeBolt11] 디코딩 실패:', e);
    return null;
  }
}

// ── kind 1111 요청 이벤트 파싱 ────────────────────

/** Admin 처리용 확장 요청 (base AdminRequest + action별 추가 필드) */
export interface ProcessedRequest extends AdminRequest {
  /** claim action일 때만 존재하는 인보이스 정보 */
  invoice: Invoice | null;
  /** order-request action일 때만 존재하는 금액 (KRW) */
  price: number;
}

/**
 * kind 1111 이벤트를 ProcessedRequest로 파싱한다.
 * a-tag에서 orderId를 추출하고, action 태그로 요청 종류를 분류한다.
 */
export function parseRequestEvent(event: Event): ProcessedRequest | null {
  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;

  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return null;
  // 새 아키텍처: a-tag은 30402:<admin-pubkey>:<orderId>
  // 호환성: 이전 30402:<customer-pubkey>:<orderId>도 수용
  const orderId = parts[2];

  const action = (event.tags.find(t => t[0] === 'action')?.[1] ?? 'claim') as RequestAction;

  const expirationTag = event.tags.find(t => t[0] === 'expiration')?.[1];
  const expiration = expirationTag ? Number(expirationTag) : 0;

  const priceTag = event.tags.find(t => t[0] === 'price');
  const price = priceTag?.[1] ? Number(priceTag[1]) : 0;

  const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1] ?? null;
  const invoice: Invoice | null = bolt11
    ? { bolt11, decoded: decodeBolt11(bolt11), liquidityVerified: false }
    : null;

  return {
    eventId: event.id,
    orderId,
    action,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    expiration,
    raw: event,
    invoice,
    price,
  };
}

// ── kind 30402 오더 이벤트 파싱 ───────────────────

/**
 * kind 30402 이벤트를 Order로 파싱한다.
 * Admin이 발행한 이벤트만 수용 (pubkey === APP_PUBKEY 검증).
 */
export function parseOrderEvent(event: Event): Order | null {
  if (event.pubkey !== APP_PUBKEY) return null;

  const orderId = event.tags.find(t => t[0] === 'd')?.[1];
  if (!orderId) return null;

  const status = (event.tags.find(t => t[0] === 'status')?.[1] ?? 'active') as 'active' | 'sold';
  const state = (event.tags.find(t => t[0] === 'state')?.[1] ?? 'requested') as Order['state'];
  const customerPubkey = event.tags.find(t => t[0] === 'customer')?.[1] ?? '';
  const sponsorPubkey = event.tags.find(t => t[0] === 'sponsor')?.[1];
  const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];

  const priceTag = event.tags.find(t => t[0] === 'price');
  const price = priceTag?.[1] ? Number(priceTag[1]) : 0;

  const expirationTag = event.tags.find(t => t[0] === 'expiration')?.[1];
  const expiration = expirationTag ? Number(expirationTag) : 0;

  return {
    orderId,
    status,
    state,
    customerPubkey,
    ...(sponsorPubkey ? { sponsorPubkey } : {}),
    ...(bolt11 ? { bolt11 } : {}),
    price,
    createdAt: event.created_at,
    updatedAt: event.created_at,
    expiration,
    raw: event,
  };
}
