/**
 * Admin kind 30402 오더 이벤트 발행
 *
 * Admin이 유일한 오더 상태 소유자로서 kind 30402를 발행/갱신한다.
 * NIP-46 원격 서명자를 사용하여 APP_PUBKEY로 서명한다.
 * 비즈니스 이벤트이므로 읽기 릴레이에 발행한다.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import {
  SAJWO_REQUEST_KIND,
  SAJWO_REQUEST_EVENT_KIND,
  APP_PUBKEY,
  CLIENT_TAG,
  REQUEST_ACTIONS,
  getReadRelays,
  type Order,
  type OrderState,
  type DisputeMessagePayload,
  type PreparedChatMessage,
  storage,
} from '@sajwo-tracker/shared';
import { getSigner } from './nip46';

/**
 * Order 데이터로 kind 30402 이벤트를 빌드, 서명, 발행한다.
 * 반환: 서명된 이벤트 (order-store에 raw로 저장하기 위함)
 */
export async function publishOrder(order: Order): Promise<object> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const status = toListingStatus(order.state);
  const now = Math.floor(Date.now() / 1000);

  // verified 이후인데 payout이 비어 있으면 **되돌릴 수 없는 상태**를 만드는 중이다.
  // kind 30402는 addressable이라 이 발행이 이전 이벤트를 덮어쓰고, 한 번 빠진
  // 태그는 영영 복구되지 않는다(2026-09-19 주문 두 건을 그렇게 잃었다).
  // 막지는 않는다 — 발행을 멈추면 거래가 더 크게 망가진다. 대신 크게 남긴다.
  if (order.payoutSat === undefined && order.state !== 'requested'
      && order.state !== 'claimed' && order.state !== 'cancelled') {
    console.error(
      '[Admin] 불변조건 위반: payoutSat 없이 %s 발행 — 이 주문은 후원자가 인보이스를 낼 수 없게 된다:',
      order.state, order.orderId,
    );
  }

  const tags: string[][] = [
    ['d', order.orderId],
    ['t', CLIENT_TAG],
    ['status', status],
    ['state', order.state],
    ['price', String(order.price), 'KRW'],
    ['customer', order.customerPubkey],
    ['expiration', String(order.expiration)],
  ];
  if (order.sponsorPubkey) {
    tags.push(['sponsor', order.sponsorPubkey]);
  }
  if (order.bolt11) {
    tags.push(['bolt11', order.bolt11]);
  }
  // 후원자가 만들 인보이스 금액. 새 kind 1111을 만드는 대신 오더에 싣는다 —
  // 양쪽 다 이미 이 이벤트를 구독 중이고, addressable이라 재전송 중복도 없다.
  if (order.payoutSat) {
    tags.push(['payout', String(order.payoutSat)]);
  }
  if (order.sponsorInvoice) {
    tags.push(['sponsor-invoice', order.sponsorInvoice]);
  }
  if (order.disbursed) {
    tags.push(['disbursed', 'true']);
  }
  if (order.depositPaymentHash) {
    tags.push(['customer-deposit-payment-hash', order.depositPaymentHash]);
  }
  if (order.sponsorDepositPaymentHash) {
    tags.push(['sponsor-deposit-payment-hash', order.sponsorDepositPaymentHash]);
  }

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_KIND,
    created_at: now,
    tags,
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('모든 릴레이에 발행 실패');
    console.log('[Admin] Published order', order.orderId, 'state:', order.state, 'to', relays.length, 'relays');
  } finally {
    pool.destroy();
  }

  return signed;
}

/**
 * FSM 상태 → NIP-99 listing status 매핑
 * 터미널 상태(paid, cancelled, sponsor_wins, customer_wins)는 'sold', 나머지는 'active'.
 */
function toListingStatus(state: OrderState): 'active' | 'sold' {
  const TERMINAL: ReadonlySet<OrderState> = new Set([
    'paid', 'cancelled', 'sponsor_wins', 'customer_wins',
  ]);
  return TERMINAL.has(state) ? 'sold' : 'active';
}

/**
 * 분쟁 채팅 메시지를 서명까지만 끝낸다. 발행은 호출부가 돌린다.
 *
 * 서명을 먼저 해야 발행 전에 eventId가 확정되어 낙관적 렌더링이 중복을 안 만든다
 * (shared/chat-send 참조). Admin은 NIP-46 원격 서명이라 이 단계에 번커 왕복이
 * 한 번 들어가지만, 발행 + 에코를 기다리는 것보다는 훨씬 짧다.
 */
export async function prepareDisputeMessage(
  orderId: string,
  recipientPubkey: string,
  payload: DisputeMessagePayload,
): Promise<PreparedChatMessage> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const encrypted = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(payload));
  const createdAt = Math.floor(Date.now() / 1000);

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE],
      ['t', CLIENT_TAG],
      ['p', recipientPubkey],
      ['p', APP_PUBKEY],
    ],
    content: encrypted,
  };

  const signed = await signer.signEvent(template);

  return {
    message: {
      eventId: signed.id,
      orderId,
      senderPubkey: APP_PUBKEY,
      recipientPubkey,
      payload,
      createdAt,
    },
    publish: async () => {
      const relays = await getReadRelays(storage);
      const pool = new SimplePool();
      try {
        const results = await Promise.allSettled(pool.publish(relays, signed));
        return results.some(r => r.status === 'fulfilled');
      } finally {
        pool.destroy();
      }
    },
  };
}

/**
 * 보증금 결제 요청 알림을 kind 1111로 발행한다.
 * Customer 또는 Sponsor에게 보증금 hold invoice를 전달한다.
 */
export async function publishDepositRequired(
  orderId: string,
  recipientPubkey: string,
  bolt11: string,
  expiration: number,
): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const now = Math.floor(Date.now() / 1000);

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: now,
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.DEPOSIT_REQUIRED],
      ['t', CLIENT_TAG],
      ['p', recipientPubkey],
      ['p', APP_PUBKEY],
      ['bolt11', bolt11],
      ['expiration', String(expiration)],
    ],
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    await Promise.allSettled(pool.publish(relays, signed));
    console.log('[Admin] Published deposit-required for', orderId, 'to', recipientPubkey.slice(0, 12));
  } finally {
    pool.destroy();
  }
}

/**
 * 보증금 상태 변경 알림을 kind 1111로 발행한다 (fire-and-forget).
 * accepted: 보증금 결제 확인, cancelled: 환불, settled: 몰수.
 */
export async function publishDepositStatus(
  orderId: string,
  recipientPubkey: string,
  status: 'accepted' | 'cancelled' | 'settled',
): Promise<void> {
  const signer = getSigner();
  if (!signer) return;

  const actionMap = {
    accepted: REQUEST_ACTIONS.DEPOSIT_ACCEPTED,
    cancelled: REQUEST_ACTIONS.DEPOSIT_CANCELLED,
    settled: REQUEST_ACTIONS.DEPOSIT_SETTLED,
  } as const;

  const now = Math.floor(Date.now() / 1000);

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: now,
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', actionMap[status]],
      ['t', CLIENT_TAG],
      ['p', recipientPubkey],
      ['p', APP_PUBKEY],
      ['expiration', String(now + 86400)],
    ],
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    await Promise.allSettled(pool.publish(relays, signed));
    console.log(`[Admin] Published deposit-${status} for`, orderId, 'to', recipientPubkey.slice(0, 12));
  } finally {
    pool.destroy();
  }
}

/**
 * 후원자 인보이스 거절 사유를 kind 1111로 알린다.
 *
 * 거절은 조용하면 안 된다 — 후원자는 제출했다고 믿고 계좌를 기다리는데
 * 영영 안 오는 상태가 된다. 오더 상태에는 영향이 없다(알림 전용).
 *
 * `expected-sats`에 지급 예정액을 실어 보내 후원자가 바로 다시 만들 수 있게 한다.
 */
export async function publishInvoiceRejected(
  orderId: string,
  sponsorPubkey: string,
  reason: 'DECODE_FAILED' | 'AMOUNT_MISMATCH' | 'EXPIRES_TOO_SOON' | 'EXPIRED_BEFORE_PAYOUT' | 'LIQUIDITY_WARNING' | 'ESCROW_ENDING_SOON',
  expectedSats = 0,
): Promise<void> {
  const signer = getSigner();
  if (!signer) return;

  const now = Math.floor(Date.now() / 1000);

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: now,
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.CLAIM_PRICE_ERROR],
      ['t', CLIENT_TAG],
      ['p', sponsorPubkey],
      ['p', APP_PUBKEY],
      ['reason', reason],
      ['expected-sats', String(expectedSats)],
      ['expiration', String(now + 3600)],
    ],
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    await Promise.allSettled(pool.publish(relays, signed));
    console.log('[Admin] Published invoice-rejected(%s) for %s to %s', reason, orderId, sponsorPubkey.slice(0, 12));
  } finally {
    pool.destroy();
  }
}

/**
 * 후원자에게 계좌정보 공개를 요청한다 (분쟁 중재용).
 *
 * 공개는 커밋먼트 대조를 위한 분쟁 대응 수단이다. 후원자 화면에서 이 요청을
 * 받기 전에는 공개 버튼이 열리지 않는다 — 정상 흐름에서 계좌가 Admin에게까지
 * 흘러가는 일을 막기 위해서다.
 */
export async function publishRevealRequest(
  orderId: string,
  sponsorPubkey: string,
  expiration: number,
): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const tags: string[][] = [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
    ['action', REQUEST_ACTIONS.REVEAL_REQUEST],
    ['t', CLIENT_TAG],
    ['p', sponsorPubkey],
    ['p', APP_PUBKEY],
  ];
  if (expiration > 0) tags.push(['expiration', String(expiration)]);

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    await Promise.allSettled(pool.publish(relays, signed));
    console.log('[Admin] 계좌정보 공개 요청 발행:', orderId, '→', sponsorPubkey.slice(0, 12));
  } finally {
    pool.destroy();
  }
}
