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
  if (order.disbursed) {
    tags.push(['disbursed', 'true']);
  }
  if (order.depositPaymentHash) {
    tags.push(['deposit-payment-hash', order.depositPaymentHash]);
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
 * 분쟁 채팅 메시지를 NIP-44 암호화하여 kind 1111로 발행한다.
 * Admin은 Customer/Sponsor 양쪽 모두에게 발행 가능.
 * dispute-message는 증거 보존 목적으로 expiration 없음.
 */
export async function publishDisputeMessage(
  orderId: string,
  recipientPubkey: string,
  payload: DisputeMessagePayload,
): Promise<object> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const plaintext = JSON.stringify(payload);
  const encrypted = await signer.nip44Encrypt(recipientPubkey, plaintext);
  const now = Math.floor(Date.now() / 1000);

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: now,
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

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('모든 릴레이에 발행 실패');
    console.log('[Admin] Published dispute-message for', orderId, 'to', recipientPubkey.slice(0, 12));
  } finally {
    pool.destroy();
  }

  return signed;
}

/**
 * 보증금 결제 요청 알림을 kind 1111로 발행한다.
 * order-request 수신 시 depositPercent > 0이면 호출.
 * Customer가 보증금을 결제해야 오더가 생성된다.
 */
export async function publishDepositRequired(
  orderId: string,
  customerPubkey: string,
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
      ['p', customerPubkey],
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
    console.log('[Admin] Published deposit-required for', orderId, 'to', customerPubkey.slice(0, 12));
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
  customerPubkey: string,
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
      ['p', customerPubkey],
      ['expiration', String(now + 86400)],
    ],
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    await Promise.allSettled(pool.publish(relays, signed));
    console.log(`[Admin] Published deposit-${status} for`, orderId, 'to', customerPubkey.slice(0, 12));
  } finally {
    pool.destroy();
  }
}

/**
 * 클레임 가격 오류 알림을 kind 1111로 발행한다.
 * 인보이스 금액이 현재 시세 범위를 벗어날 때 Sponsor에게 재발행을 요청한다.
 * 오더 상태에 영향 없음 (사용성 개선 목적 알림).
 */
export async function publishClaimPriceError(
  orderId: string,
  sponsorPubkey: string,
  expectedSats: number,
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
    console.log('[Admin] Published claim-price-error for', orderId, 'to', sponsorPubkey.slice(0, 12));
  } finally {
    pool.destroy();
  }
}
