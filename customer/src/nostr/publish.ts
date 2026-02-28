/**
 * kind 1111 이벤트 빌드 + 발행
 *
 * Customer가 Admin에게 보내는 요청 이벤트를 빌드, 서명, 발행한다.
 * - order-request: 사줘 요청
 * - payment-confirm: 입금 완료 통보
 * - cancel-request: 주문 취소 요청
 * - account-info: 계좌정보 전달 (NIP-44 암호화)
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import {
  SAJWO_REQUEST_KIND,
  SAJWO_REQUEST_EVENT_KIND,
  APP_PUBKEY,
  CLIENT_TAG,
  getSecretKey,
  getReadRelays,
  nip44Encrypt,
  sha256Hex,
  type RequestAction,
  type AccountInfo,
} from '@sajwo-tracker/shared';
import { storage } from './storage';
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

/** 사줘 요청을 릴레이에 발행한다. */
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
 * Sponsor pubkey로 암호화하며, commitment 태그에 sha256 해시를 포함한다.
 */
export async function publishAccountInfo(
  order: CustomerOrder,
  accountInfo: AccountInfo,
): Promise<PublishResult> {
  const sponsorPubkey = order.sponsorPubkey;
  if (!sponsorPubkey) throw new Error('sponsorPubkey 없음');

  const sk = await getSecretKey(storage);
  const plaintext = JSON.stringify(accountInfo);
  const encrypted = nip44Encrypt(plaintext, sk, sponsorPubkey);
  const commitment = await sha256Hex(plaintext);

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
