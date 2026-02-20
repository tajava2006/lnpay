/**
 * Nostr 구독 서비스
 *
 * Admin 발행 오더를 실시간 구독하고,
 * 수신한 이벤트를 order-store에 반영한다.
 */
import { getReadRelays } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeSajwoRequests } from './subscribe';
import { parseEvent } from '../types';
import { upsertOrder, markSynced } from '../order-store';

let cleanup: (() => void) | null = null;

export async function startOrderSubscription(): Promise<void> {
  if (cleanup) return;

  const relays = await getReadRelays(storage);

  cleanup = subscribeSajwoRequests(relays, {
    onOrder: (event) => {
      const parsed = parseEvent(event);
      if (parsed) upsertOrder(parsed);
    },
    onEose: () => {
      markSynced();
    },
  });
}

export function stopOrderSubscription(): void {
  cleanup?.();
  cleanup = null;
}
