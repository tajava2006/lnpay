import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, SAJWO_REQUEST_KIND, type Order, type OrderState } from '@sajwo-tracker/shared';

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

  return {
    orderId,
    status,
    state,
    customerPubkey,
    ...(sponsorPubkey ? { sponsorPubkey } : {}),
    ...(payoutSat && payoutSat > 0 ? { payoutSat } : {}),
    ...(sponsorInvoice ? { sponsorInvoice } : {}),
    price,
    createdAt: event.created_at,
    updatedAt: event.created_at,
    expiration,
    raw: event,
  };
}
