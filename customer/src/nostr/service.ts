/**
 * Admin 오더 구독 오케스트레이터
 *
 * Admin kind 30402 이벤트를 구독하고,
 * customer 태그가 자기 pubkey인 이벤트만 필터링하여
 * order-store에 상태를 반영한다.
 */
import { getReadRelays, getUserPubkey } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeAdminOrders } from './subscribe';
import { parseAdminEvent } from '../types';
import { applyAdminUpdate, markSynced } from '../order-store';

let cleanup: (() => void) | null = null;

export async function startAdminSubscription(): Promise<void> {
  if (cleanup) return;

  const [relays, myPubkey] = await Promise.all([
    getReadRelays(storage),
    getUserPubkey(storage),
  ]);

  cleanup = subscribeAdminOrders(relays, {
    onOrder: (event) => {
      const update = parseAdminEvent(event, myPubkey);
      if (update) {
        applyAdminUpdate(update.orderId, update.adminState, update.bolt11);
      }
    },
    onEose: () => {
      markSynced();
      console.log('[Customer] Admin orders EOSE');
    },
  });
}

export function stopAdminSubscription(): void {
  cleanup?.();
  cleanup = null;
}
