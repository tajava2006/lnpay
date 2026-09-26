import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, ORDER_KIND, type Order } from '@sajwo-tracker/shared';
import { parseLnOrderEvent } from '@sajwo-tracker/shared/ln';

// ── account-info 이벤트 파싱 ─────────────────────────

/** account-info 요청 이벤트에서 추출한 정보 */
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
 * 요청 이벤트를 AccountInfoEvent로 파싱한다.
 * action이 'account-info'인 이벤트만 처리.
 */
export function parseAccountInfoEvent(event: Event): AccountInfoEvent | null {
  const action = event.tags.find(t => t[0] === 'action')?.[1];
  if (action !== 'account-info') return null;

  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;

  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(ORDER_KIND)) return null;
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

// ── 오더 이벤트 파싱 ──────────────────────

/**
 * 오더 이벤트를 Order로 파싱한다. Admin(APP_PUBKEY)이 발행한 것만.
 *
 * 규칙은 shared `parseLnOrderEvent` 한 곳에 있다 — 데몬이 만드는 쪽과 같은 파일이다. 여기 따로 두었을 때
 * 발행만 하고 안 읽은 태그(payout)가 에코에 증발한 적이 있다(2026-09-19). `expiration`은 **쿠팡 기한**,
 * 릴레이 보존은 `retainUntil`이다.
 */
export function parseEvent(event: Event): Order | null {
  return parseLnOrderEvent(event, APP_PUBKEY);
}
