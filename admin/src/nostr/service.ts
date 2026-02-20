/**
 * 어드민 Nostr 구독 서비스
 *
 * 요청(kind 1111)과 오더(kind 30402)를 구독하여
 * 각각 request-store, order-store에 반영한다.
 *
 * order-request 수신 시 자동으로 오더를 생성하고 kind 30402를 발행한다.
 */
import { getReadRelays, type Order } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeAdmin } from './subscribe';
import { publishOrder } from './publish';
import { parseRequestEvent, parseOrderEvent, type ProcessedRequest } from '../types';
import { upsertRequest, markSynced } from '../request-store';
import { upsertOrder, getOrder } from '../order-store';

let cleanup: (() => void) | null = null;

export async function startAdminSubscription(): Promise<void> {
  if (cleanup) return;

  const relays = await getReadRelays(storage);

  cleanup = subscribeAdmin(relays, {
    onRequest: (event) => {
      const request = parseRequestEvent(event);
      if (!request) return;

      upsertRequest(request);

      // action별 분기 처리
      if (request.action === 'order-request') {
        void handleOrderRequest(request);
      }
    },
    onOrder: (event) => {
      const order = parseOrderEvent(event);
      if (order) upsertOrder(order);
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
 * order-request 수신 시 자동으로 오더를 생성하고 kind 30402를 발행한다.
 * 이미 존재하는 orderId면 중복 생성하지 않는다.
 */
async function handleOrderRequest(request: ProcessedRequest): Promise<void> {
  const existing = getOrder(request.orderId);
  if (existing) return;

  const now = Math.floor(Date.now() / 1000);
  const newOrder: Order = {
    orderId: request.orderId,
    status: 'active',
    state: 'requested',
    customerPubkey: request.pubkey,
    price: request.price,
    createdAt: now,
    updatedAt: now,
    expiration: request.expiration,
    raw: {},
  };

  // 로컬 스토어에 즉시 반영 (UI에 표시)
  upsertOrder(newOrder);

  try {
    const signed = await publishOrder(newOrder);
    // 발행 성공 시 raw를 서명된 이벤트로 갱신
    upsertOrder({ ...newOrder, raw: signed, updatedAt: now });
    console.log('[Admin] Auto-created order', request.orderId, 'from order-request');
  } catch (e) {
    console.error('[Admin] Failed to publish order for', request.orderId, e);
  }
}
