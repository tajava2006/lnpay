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
  const action = event.tags.find(t => t[0] === 'action')?.[1] ?? 'claim';

  // 계정 단위 요청은 오더에 묶이지 않으므로 a 태그가 없는 게 정상이다.
  // 아래의 a 태그 필수 검사보다 **먼저** 걸러야 한다 — 안 그러면 조용히 버려진다.
  if (action === 'push-subscription') {
    return {
      eventId: event.id,
      orderId: '', // 오더와 무관. 호출자가 requests 스토어에 넣지 않고 바로 처리한다
      pubkey: event.pubkey,
      createdAt: event.created_at,
      expiration: 0,
      raw: event as object,
      action,
    };
  }

  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;

  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return null;
  const orderId = parts[2];

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

    // ── 온체인 트랙 (PLAN-ONCHAIN-TRACK §5.2) ──
    //
    // ⚠️ PSBT와 후원자의 받을 주소는 **암호문(content)에** 있다. 여기서 풀지
    // 않는다 — 복호화는 핸들러 몫이고, 파서는 `raw`로 넘긴다(account-info와 같은 규약).
    case 'onchain-order-request': {
      const amountSat = Number(event.tags.find(t => t[0] === 'amount-sat')?.[1]);
      const customerXonly = event.tags.find(t => t[0] === 'customer-xonly')?.[1];
      // 둘 중 하나라도 없으면 주소를 만들 수 없다. 받아봐야 어드민 화면에
      // "처리 못 하는 요청"만 쌓인다.
      if (!Number.isInteger(amountSat) || amountSat <= 0 || !customerXonly) return null;
      const reserveRaw = event.tags.find(t => t[0] === 'reserve-krw')?.[1];
      const reserveKrw = reserveRaw === undefined ? undefined : Number(reserveRaw);
      return {
        ...base, action, amountSat, customerXonly,
        ...(reserveKrw !== undefined && Number.isFinite(reserveKrw) ? { reserveKrw } : {}),
      };
    }
    case 'onchain-claim': {
      const sponsorXonly = event.tags.find(t => t[0] === 'sponsor-xonly')?.[1];
      if (!sponsorXonly) return null;
      return { ...base, action, sponsorXonly };
    }
    case 'onchain-presig':
      return { ...base, action };
    case 'onchain-cosign': {
      const purpose = event.tags.find(t => t[0] === 'purpose')?.[1];
      // 무엇에 대한 서명인지 모르면 어느 tx에 붙일지 알 수 없다.
      if (purpose !== 'release' && purpose !== 'refund' && purpose !== 'dispute-customer') {
        return null;
      }
      return { ...base, action, purpose };
    }
    case 'onchain-dispute': {
      const stage = event.tags.find(t => t[0] === 'stage')?.[1];
      return {
        ...base, action,
        ...(stage === 'account-unusable' || stage === 'remitted' ? { stage } : {}),
      };
    }
    case 'sponsor-invoice': {
      // bolt11이 없으면 의미가 없다 — 지급처가 본문이다.
      const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
      if (!bolt11) return null;
      return { ...base, action, bolt11 };
    }
    case 'payment-confirm':
    case 'cancel-request':
    case 'remit-request':
    case 'dispute-message':
    case 'claim-price-error':
    case 'deposit-required':
    case 'deposit-accepted':
    case 'deposit-cancelled':
    case 'deposit-settled':
    case 'reveal-request':
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
  const depositPaymentHash = event.tags.find(t => t[0] === 'customer-deposit-payment-hash')?.[1];
  const sponsorDepositPaymentHash = event.tags.find(t => t[0] === 'sponsor-deposit-payment-hash')?.[1];

  // payout / sponsor-invoice
  //
  // **발행만 하고 읽지 않으면 없는 것과 같다.** 어드민은 전이 때 payoutSat을
  // 오더에 담아 발행하는데, 릴레이 에코가 돌아오면 upsertOrder가 파싱본으로
  // 통째로 갈아끼운다 — 여기서 안 읽으면 그 순간 값이 증발한다.
  // 그러면 후원자 화면엔 "0 sats"가 뜨고 인보이스는 전부 AMOUNT_MISMATCH로
  // 거절된다(2026-09-19 prd에서 실제로 발생).
  const payoutTag = event.tags.find(t => t[0] === 'payout')?.[1];
  const payoutSat = payoutTag ? Number(payoutTag) : undefined;
  const sponsorInvoice = event.tags.find(t => t[0] === 'sponsor-invoice')?.[1];

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
    ...(depositPaymentHash ? { depositPaymentHash } : {}),
    ...(sponsorDepositPaymentHash ? { sponsorDepositPaymentHash } : {}),
    ...(payoutSat && payoutSat > 0 ? { payoutSat } : {}),
    ...(sponsorInvoice ? { sponsorInvoice } : {}),
    price,
    createdAt: event.created_at,
    updatedAt: event.created_at,
    expiration,
    raw: event,
  };
}
