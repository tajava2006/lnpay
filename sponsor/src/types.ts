import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, SAJWO_REQUEST_KIND, type Order, type OrderState, type AccountInfo } from '@sajwo-tracker/shared';

// ── IDB 저장용 request 타입 ──────────────────────────

/** Sponsor IDB에 저장되는 request (claim, account-info 등) */
export interface SponsorRequest {
  eventId: string;
  orderId: string;
  action: string;
  pubkey: string;
  createdAt: number;
  expiration: number;
  /** 복호화된 계좌정보 (account-info 액션인 경우) */
  accountInfo?: AccountInfo;
  raw: object;
}

// ── account-info 이벤트 파싱 ─────────────────────────

/** account-info kind 1111 이벤트에서 추출한 정보 */
export interface AccountInfoEvent {
  eventId: string;
  orderId: string;
  customerPubkey: string;
  encryptedContent: string;
  commitment: string;
  createdAt: number;
  expiration: number;
}

/**
 * kind 1111 이벤트를 AccountInfoEvent로 파싱한다.
 * action이 'account-info'인 이벤트만 처리.
 */
export function parseAccountInfoEvent(event: Event): AccountInfoEvent | null {
  const action = event.tags.find(t => t[0] === 'action')?.[1];
  if (action !== 'account-info') return null;

  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;

  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return null;
  const orderId = parts[2]!;

  const commitment = event.tags.find(t => t[0] === 'commitment')?.[1] ?? '';
  const expiration = Number(event.tags.find(t => t[0] === 'expiration')?.[1] ?? '0');

  return {
    eventId: event.id,
    orderId,
    customerPubkey: event.pubkey,
    encryptedContent: event.content,
    commitment,
    createdAt: event.created_at,
    expiration,
  };
}

// ── kind 30402 오더 이벤트 파싱 ──────────────────────

/**
 * kind 30402 이벤트를 Order로 파싱한다.
 * Admin(APP_PUBKEY)이 발행한 이벤트만 수용.
 */
export function parseEvent(event: Event): Order | null {
  if (event.pubkey !== APP_PUBKEY) return null;

  const orderId = event.tags.find(t => t[0] === 'd')?.[1];
  if (!orderId) return null;

  const status = (event.tags.find(t => t[0] === 'status')?.[1] ?? 'active') as 'active' | 'sold';
  const state = (event.tags.find(t => t[0] === 'state')?.[1] ?? 'requested') as OrderState;
  const customerPubkey = event.tags.find(t => t[0] === 'customer')?.[1] ?? '';
  const sponsorPubkey = event.tags.find(t => t[0] === 'sponsor')?.[1];

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
    price,
    createdAt: event.created_at,
    updatedAt: event.created_at,
    expiration,
    raw: event,
  };
}
