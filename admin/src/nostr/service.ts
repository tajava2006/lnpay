/**
 * 어드민 Nostr 구독 서비스
 *
 * 요청(kind 1111)과 오더(kind 30402)를 구독하여
 * 각각 request-store, order-store에 반영한다.
 *
 * action별 자동 처리:
 * - order-request: 오더 생성 + kind 30402 발행
 * - claim: 오더 상태 전이 (requested → claimed) + kind 30402 갱신
 * - payment-confirm: Customer 입금 확인 → paid 전이 + kind 30402 갱신
 * - cancel-request: Customer 취소 요청 → cancelled 전이 + kind 30402 갱신
 *
 * Admin UI 트리거:
 * - approveOrder: 클레임 승인 (claimed → verified) + kind 30402 갱신
 */
import { getReadRelays, type Order } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeAdmin } from './subscribe';
import { publishOrder } from './publish';
import { parseRequestEvent, parseOrderEvent, type ProcessedRequest } from '../types';
import { upsertRequest, markSynced } from '../request-store';
import { upsertOrder, getOrder } from '../order-store';
import { canTransition } from '../state-machine';

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
      } else if (request.action === 'claim') {
        void handleClaim(request);
      } else if (request.action === 'payment-confirm') {
        void handlePaymentConfirm(request);
      } else if (request.action === 'cancel-request') {
        void handleCancelRequest(request);
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

// ============================================================
// Admin UI Actions
// ============================================================

/**
 * 클레임을 승인하여 claimed → verified로 전이하고 kind 30402를 갱신 발행한다.
 * ClaimCard의 승인 버튼에서 호출된다.
 */
export async function approveOrder(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'verified')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → verified` };
  }

  const now = Math.floor(Date.now() / 1000);
  const updatedOrder: Order = {
    ...order,
    state: 'verified',
    updatedAt: now,
  };

  upsertOrder(updatedOrder);

  try {
    const signed = await publishOrder(updatedOrder);
    upsertOrder({ ...updatedOrder, raw: signed, updatedAt: now });
    console.log('[Admin] Order', orderId, 'approved (claimed → verified)');
  } catch (e) {
    console.error('[Admin] Failed to publish verified order for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  return { success: true };
}

// ============================================================
// Action Handlers (Inbound Request)
// ============================================================

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

/**
 * payment-confirm 수신 시 오더를 paid로 전이하고 kind 30402를 갱신 발행한다.
 * escrowed 또는 remitted 상태에서 전이 가능 (Customer의 자동 파싱으로 입금 감지).
 */
async function handlePaymentConfirm(request: ProcessedRequest): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) return;

  if (order.customerPubkey !== request.pubkey) {
    console.warn('[Admin] payment-confirm pubkey mismatch for', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'paid')) {
    console.warn('[Admin] Cannot transition to paid for', request.orderId, '- current state:', order.state);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const updatedOrder: Order = {
    ...order,
    state: 'paid',
    status: 'sold',
    updatedAt: now,
  };

  upsertOrder(updatedOrder);

  try {
    const signed = await publishOrder(updatedOrder);
    upsertOrder({ ...updatedOrder, raw: signed, updatedAt: now });
    console.log('[Admin] Order', request.orderId, 'paid (payment-confirm from customer)');
  } catch (e) {
    console.error('[Admin] Failed to publish paid order for', request.orderId, e);
  }
}

/**
 * cancel-request 수신 시 오더를 cancelled로 전이하고 kind 30402를 갱신 발행한다.
 * remitted 상태에서는 전이 불가 (분쟁 판정 경로로만 종결).
 */
async function handleCancelRequest(request: ProcessedRequest): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) return;

  if (order.customerPubkey !== request.pubkey) {
    console.warn('[Admin] cancel-request pubkey mismatch for', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'cancelled')) {
    console.warn('[Admin] Cannot cancel order', request.orderId, '- current state:', order.state);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const updatedOrder: Order = {
    ...order,
    state: 'cancelled',
    status: 'sold',
    updatedAt: now,
  };

  upsertOrder(updatedOrder);

  try {
    const signed = await publishOrder(updatedOrder);
    upsertOrder({ ...updatedOrder, raw: signed, updatedAt: now });
    console.log('[Admin] Order', request.orderId, 'cancelled (cancel-request from customer)');
  } catch (e) {
    console.error('[Admin] Failed to publish cancelled order for', request.orderId, e);
  }
}

/**
 * claim 수신 시 오더를 requested → claimed로 전이하고 kind 30402를 갱신 발행한다.
 * - 오더가 없거나 전이 불가면 무시 (선착순: 이미 claimed면 후속 클레임 거부)
 * - sponsorPubkey를 기록하여 이후 유동성 검증 등에 사용
 */
async function handleClaim(request: ProcessedRequest): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) {
    console.warn('[Admin] Claim for unknown order:', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'claimed')) {
    console.warn('[Admin] Cannot claim order', request.orderId, '- current state:', order.state);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const updatedOrder: Order = {
    ...order,
    state: 'claimed',
    sponsorPubkey: request.pubkey,
    updatedAt: now,
  };

  // 로컬 스토어에 즉시 반영
  upsertOrder(updatedOrder);

  try {
    const signed = await publishOrder(updatedOrder);
    upsertOrder({ ...updatedOrder, raw: signed, updatedAt: now });
    console.log('[Admin] Order', request.orderId, 'claimed by', request.pubkey);
  } catch (e) {
    console.error('[Admin] Failed to publish claimed order for', request.orderId, e);
  }
}
