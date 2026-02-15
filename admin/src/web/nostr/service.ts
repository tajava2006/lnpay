/**
 * 어드민 Nostr 구독 서비스
 *
 * 클레임(kind 1111)과 주문(kind 30402)을 구독하여
 * 각각 claim-store, order-store에 반영한다.
 *
 * 클레임 content에 포함된 주문 원본 이벤트도 검증 후 order-store에 저장한다.
 * (만료된 주문을 릴레이에서 받지 못하는 경우의 복원 경로)
 */
import { verifyEvent } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/core';
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

      // content에 포함된 주문 원본 이벤트를 검증 후 order-store에 저장
      extractOrderFromClaimContent(event);
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

/**
 * 클레임 content에서 주문 원본 이벤트를 추출하여 order-store에 저장한다.
 * 만료된 주문을 릴레이에서 받지 못하는 경우의 복원 경로.
 * 서명 검증을 통과한 이벤트만 저장한다.
 */
function extractOrderFromClaimContent(claimEvent: Event): void {
  if (!claimEvent.content) return;

  let orderEvent: Event;
  try {
    orderEvent = JSON.parse(claimEvent.content) as Event;
  } catch {
    return; // content가 JSON이 아니면 무시 (하위 호환)
  }

  if (!verifyEvent(orderEvent)) {
    console.warn('[Admin] Invalid order signature in claim content, ignoring:', claimEvent.id);
    return;
  }

  const order = parseOrderEvent(orderEvent);
  if (order) upsertOrder(order);
}
