/**
 * kind 1111 이벤트 빌드 + 발행
 *
 * Customer가 Admin에게 보내는 요청 이벤트를 빌드, 서명, 발행한다.
 * - order-request: 의뢰 등록
 * - payment-confirm: 입금 완료 통보
 * - cancel-request: 주문 취소 요청
 * - account-info: 계좌정보 전달 (NIP-44 암호화)
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import {
  SAJWO_REQUEST_KIND,
  SAJWO_REQUEST_EVENT_KIND,
  APP_PUBKEY,
  CLIENT_TAG,
  REQUEST_ACTIONS,
  getSecretKey,
  getReadRelays,
  nip44Encrypt,
  generateCommitmentSalt,
  computeAccountCommitment,
  type RequestAction,
  type AccountInfo,
  type AccountInfoEnvelope,
  type DisputeMessagePayload,
  type PreparedChatMessage,
  storage,
} from '@sajwo-tracker/shared';
import type { CustomerOrder } from '../types';

export interface PublishResult {
  success: boolean;
  publishedTo: string[];
  errors: string[];
  /** 발행된 서명 이벤트 원본 (JSON 직렬화) */
  raw?: string;
}

/** kind 1111 order-request 이벤트 빌드 */
function buildOrderRequestEvent(order: CustomerOrder): EventTemplate {
  const tags: string[][] = [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`],
    ['action', 'order-request'],
    ['price', String(order.price), 'KRW'],
    ['t', CLIENT_TAG],
    ['p', APP_PUBKEY],
  ];

  if (order.expiration > 0) {
    tags.push(['expiration', String(order.expiration)]);
  }

  return {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** 상태 통보 이벤트 빌드 (payment-confirm, cancel-request) */
function buildNotificationEvent(order: CustomerOrder, action: RequestAction): EventTemplate {
  const tags: string[][] = [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`],
    ['action', action],
    ['t', CLIENT_TAG],
    ['p', APP_PUBKEY],
  ];

  if (order.expiration > 0) {
    tags.push(['expiration', String(order.expiration)]);
  }

  return {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** 이벤트를 서명하고 릴레이에 발행한다. */
async function signAndPublish(template: EventTemplate): Promise<PublishResult> {
  const [sk, relays] = await Promise.all([
    getSecretKey(storage),
    getReadRelays(storage),
  ]);

  const signed = finalizeEvent(template, sk);

  console.log('[Nostr] Publishing event:', signed.id, 'to', relays.length, 'relays');

  const pool = new SimplePool();
  const publishedTo: string[] = [];
  const errors: string[] = [];

  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        publishedTo.push(result.value);
      } else {
        errors.push(String(result.reason));
      }
    }
  } finally {
    pool.destroy();
  }

  const success = publishedTo.length > 0;
  console.log('[Nostr] Published to', publishedTo.length, 'relays, errors:', errors.length);

  return {
    success,
    publishedTo,
    errors,
    raw: success ? JSON.stringify(signed) : undefined,
  };
}

/** 의뢰를 릴레이에 발행한다. */
export async function publishOrderRequest(order: CustomerOrder): Promise<PublishResult> {
  const template = buildOrderRequestEvent(order);
  return signAndPublish(template);
}

/** 상태 통보를 릴레이에 발행한다 (payment-confirm, cancel-request). */
export async function publishNotification(
  order: CustomerOrder,
  action: Exclude<RequestAction, 'order-request' | 'claim' | 'account-info' | 'remit-request'>,
): Promise<PublishResult> {
  const template = buildNotificationEvent(order, action);
  return signAndPublish(template);
}

/**
 * 계좌정보를 NIP-44 암호화하여 kind 1111로 발행한다.
 * Sponsor pubkey로 암호화하며, commitment 태그에 솔티드 해시를 포함한다.
 *
 * 솔트는 암호문 안에만 들어간다 — 후원자만 알고, 분쟁 시 계좌정보와 함께 공개된다.
 * 커밋먼트 자체는 공개 태그라 솔트가 없으면 계좌번호가 브루트포스된다(감사 A-1).
 */
export async function publishAccountInfo(
  order: CustomerOrder,
  accountInfo: AccountInfo,
): Promise<PublishResult> {
  const sponsorPubkey = order.sponsorPubkey;
  if (!sponsorPubkey) throw new Error('sponsorPubkey 없음');

  const sk = await getSecretKey(storage);
  const salt = generateCommitmentSalt();
  const envelope: AccountInfoEnvelope = { accountInfo, salt };
  const encrypted = nip44Encrypt(JSON.stringify(envelope), sk, sponsorPubkey);
  const commitment = await computeAccountCommitment(accountInfo, salt);

  const tags: string[][] = [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`],
    ['action', 'account-info'],
    ['t', CLIENT_TAG],
    ['p', APP_PUBKEY],
    ['p', sponsorPubkey],
    ['commitment', commitment],
  ];

  if (order.expiration > 0) {
    tags.push(['expiration', String(order.expiration)]);
  }

  const template = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encrypted,
  };

  return signAndPublish(template);
}

/**
 * 분쟁 채팅 메시지를 NIP-44 암호화하여 kind 1111로 발행한다.
 * 수신자는 항상 APP_PUBKEY (Admin).
 * dispute-message는 증거 보존 목적으로 expiration 없음.
 */
/**
 * 분쟁 채팅 메시지를 서명까지만 끝내고, 발행은 호출부가 돌리게 한다.
 *
 * 서명을 먼저 하는 이유는 **발행 전에 진짜 eventId를 확보하기 위해서**다.
 * 그 id로 스토어에 낙관적으로 넣어두면 릴레이 에코가 도착해도 중복 제거된다
 * (shared/chat-send 참조). 수신자는 항상 APP_PUBKEY(Admin).
 * dispute-message는 증거 보존 목적으로 expiration 없음.
 */
export async function prepareDisputeMessage(
  order: CustomerOrder,
  payload: DisputeMessagePayload,
): Promise<PreparedChatMessage> {
  const sk = await getSecretKey(storage);
  const myPubkey = getPublicKey(sk);
  const encrypted = nip44Encrypt(JSON.stringify(payload), sk, APP_PUBKEY);
  const createdAt = Math.floor(Date.now() / 1000);

  const signed = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`],
      ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE],
      ['t', CLIENT_TAG],
      ['p', APP_PUBKEY],
      ['p', myPubkey],
    ],
    content: encrypted,
  }, sk);

  return {
    message: {
      eventId: signed.id,
      orderId: order.orderId,
      senderPubkey: myPubkey,
      recipientPubkey: APP_PUBKEY,
      payload,
      createdAt,
    },
    publish: () => publishSigned(signed),
  };
}

/** 서명된 이벤트를 읽기 릴레이에 발행한다. 한 곳이라도 성공하면 true. */
async function publishSigned(signed: ReturnType<typeof finalizeEvent>): Promise<boolean> {
  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    return results.some(r => r.status === 'fulfilled');
  } finally {
    pool.destroy();
  }
}
