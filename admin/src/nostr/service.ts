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
import type { LightningAdapter } from '../lightning';
import { getPreimage } from '../escrow-store';
import { idbGetOrder, idbUpsertOrder, idbUpsertRequest } from '../idb-store';

let cleanup: (() => void) | null = null;
let lnAdapterRef: LightningAdapter | null = null;

/** LN 어댑터 참조를 설정한다. App 마운트 시 호출. */
export function setLnAdapter(adapter: LightningAdapter | null): void {
  lnAdapterRef = adapter;
}

export async function startAdminSubscription(): Promise<void> {
  if (cleanup) return;

  const relays = await getReadRelays(storage);

  cleanup = subscribeAdmin(relays, {
    onRequest: (event) => {
      const request = parseRequestEvent(event);
      if (!request) return;

      upsertRequest(request);
      void syncRequestToIdb(request);

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
      if (order) {
        upsertOrder(order);
        void syncOrderToIdb(order);
      }
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
 * 클레임을 승인하여 claimed → verified로 전이하고 kind 30402를 발행한다.
 * hold invoice를 생성하여 오더에 첨부한다. 프리이미지는 escrow-store에 자동 저장된다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
export async function approveOrder(
  orderId: string,
  lnAdapter: LightningAdapter,
  amountSat: number,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'verified')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → verified` };
  }

  // hold invoice 만료 = 오더 만료까지 남은 시간 (인지부하 감소를 위해 통일)
  const now = Math.floor(Date.now() / 1000);
  const expiry = order.expiration - now;
  if (expiry <= 0) {
    return { success: false, error: 'ORDER_EXPIRED' };
  }

  // hold invoice 생성 (프리이미지는 LN 어댑터 내부에서 escrow-store에 자동 저장)
  let bolt11: string;
  try {
    const result = await lnAdapter.createHoldInvoice(orderId, amountSat, expiry);
    bolt11 = result.bolt11;
    console.log('[Admin] Hold invoice created for', orderId, '- paymentHash:', result.paymentHash);
  } catch (e) {
    console.error('[Admin] Failed to create hold invoice for', orderId, e);
    return { success: false, error: 'HOLD_INVOICE_FAILED' };
  }

  const updatedOrder: Order = {
    ...order,
    state: 'verified',
    bolt11,
    updatedAt: now,
  };

  try {
    await publishOrder(updatedOrder);
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
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
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

  try {
    await publishOrder(newOrder);
    console.log('[Admin] Auto-created order', request.orderId, 'from order-request');
  } catch (e) {
    console.error('[Admin] Failed to publish order for', request.orderId, e);
  }
}

/**
 * payment-confirm 수신 시 오더를 paid로 전이하고 kind 30402를 발행한다.
 * escrowed 또는 remitted 상태에서 전이 가능 (Customer의 자동 파싱으로 입금 감지).
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
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

  const updatedOrder: Order = {
    ...order,
    state: 'paid',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'paid (payment-confirm from customer)');
  } catch (e) {
    console.error('[Admin] Failed to publish paid order for', request.orderId, e);
    return;
  }

  // Hold invoice settle (프리이미지 제출 → BTC 정산)
  const preimage = getPreimage(request.orderId);
  if (preimage && lnAdapterRef) {
    try {
      await lnAdapterRef.settleInvoice(preimage);
      console.log('[Admin] Hold invoice settled for', request.orderId);
    } catch (e) {
      console.error('[Admin] Failed to settle hold invoice for', request.orderId, e);
    }
  } else {
    console.warn('[Admin] Cannot settle: missing', !preimage ? 'preimage' : 'lnAdapter', 'for', request.orderId);
  }
}

/**
 * cancel-request 수신 시 오더를 cancelled로 전이하고 kind 30402를 발행한다.
 * remitted 상태에서는 전이 불가 (분쟁 판정 경로로만 종결).
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
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

  const updatedOrder: Order = {
    ...order,
    state: 'cancelled',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'cancelled (cancel-request from customer)');
  } catch (e) {
    console.error('[Admin] Failed to publish cancelled order for', request.orderId, e);
  }
}

/**
 * claim 수신 시 오더를 requested → claimed로 전이하고 kind 30402를 발행한다.
 * - 오더가 없거나 전이 불가면 무시 (선착순: 이미 claimed면 후속 클레임 거부)
 * - sponsorPubkey를 기록하여 이후 유동성 검증 등에 사용
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
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

  const updatedOrder: Order = {
    ...order,
    state: 'claimed',
    sponsorPubkey: request.pubkey,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'claimed by', request.pubkey);
  } catch (e) {
    console.error('[Admin] Failed to publish claimed order for', request.orderId, e);
  }
}

// ============================================================
// IndexedDB Sync Helpers (fire-and-forget)
// ============================================================

async function syncOrderToIdb(order: Order): Promise<void> {
  try {
    const existing = await idbGetOrder(order.orderId);
    if (existing) await idbUpsertOrder(order);
  } catch (err) {
    console.warn('[Admin] IndexedDB order sync failed for', order.orderId, err);
  }
}

async function syncRequestToIdb(request: ProcessedRequest): Promise<void> {
  try {
    const existing = await idbGetOrder(request.orderId);
    if (existing) await idbUpsertRequest(request);
  } catch (err) {
    console.warn('[Admin] IndexedDB request sync failed for', request.orderId, err);
  }
}
