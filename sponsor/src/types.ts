import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, type Order, type OrderState } from '@sajwo-tracker/shared';

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
