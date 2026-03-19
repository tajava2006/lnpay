import type { Event } from 'nostr-tools/core';
import { decode } from 'bolt11';
import {
  SAJWO_REQUEST_KIND,
  APP_PUBKEY,
  type Order,
  type Invoice,
  type DecodedBolt11,
  type RouteHintHop,
  type Request,
} from '@sajwo-tracker/shared';

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

/**
 * kind 1111 이벤트를 Request 디스크리미네이티드 유니온으로 파싱한다.
 * a-tag에서 orderId를 추출하고, action 태그로 요청 종류를 분류한다.
 */
export function parseRequestEvent(event: Event): Request | null {
  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;

  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return null;
  const orderId = parts[2];

  const action = event.tags.find(t => t[0] === 'action')?.[1] ?? 'claim';

  const expirationTag = event.tags.find(t => t[0] === 'expiration')?.[1];
  const expiration = expirationTag ? Number(expirationTag) : 0;

  const base = {
    eventId: event.id,
    orderId,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    expiration,
    raw: event as object,
  };

  switch (action) {
    case 'order-request':
    case 'parsed-order': {
      const priceTag = event.tags.find(t => t[0] === 'price');
      const price = priceTag?.[1] ? Number(priceTag[1]) : 0;
      return { ...base, action, price };
    }
    case 'claim': {
      const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1] ?? null;
      const invoice: Invoice | null = bolt11
        ? { bolt11, decoded: decodeBolt11(bolt11), liquidityVerified: false }
        : null;
      return { ...base, action, invoice };
    }
    case 'account-info':
      return { ...base, action };
    case 'payment-confirm':
    case 'cancel-request':
    case 'remit-request':
    case 'dispute-message':
    case 'claim-price-error':
      return { ...base, action };
    default:
      console.warn('[parseRequestEvent] Unknown action:', action);
      return null;
  }
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
  const disbursed = event.tags.find(t => t[0] === 'disbursed')?.[1] === 'true' || undefined;

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
    ...(disbursed ? { disbursed } : {}),
    price,
    createdAt: event.created_at,
    updatedAt: event.created_at,
    expiration,
    raw: event,
  };
}
