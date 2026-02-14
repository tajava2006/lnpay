/**
 * 어드민 Nostr 구독 서비스
 *
 * 클레임(kind 1111)과 주문(kind 30402)을 구독하여
 * 각각 claim-store, order-store에 반영한다.
 */
import { getRelays } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeAdmin } from './subscribe';
import { parseClaimEvent, parseOrderEvent } from '../types';
import { upsertClaim, markSynced } from '../claim-store';
import { upsertOrder, deleteOrder } from '../order-store';

let cleanup: (() => void) | null = null;

export async function startAdminSubscription(): Promise<void> {
  if (cleanup) return;

  const relays = await getRelays(storage);

  cleanup = subscribeAdmin(relays, {
    onClaim: (event) => {
      const claim = parseClaimEvent(event);
      if (claim) upsertClaim(claim);
    },
    onOrderActive: (event) => {
      const order = parseOrderEvent(event);
      if (order) upsertOrder(order);
    },
    onOrderSold: (event) => {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (dTag) deleteOrder(dTag);
    },
    onEose: () => {
      markSynced();
    },
  });
}

export function stopAdminSubscription(): void {
  cleanup?.();
  cleanup = null;
}
