/**
 * 어드민 Nostr 구독 서비스
 *
 * 요청(kind 1111)과 오더(kind 30402)를 구독하여
 * 각각 request-store, order-store에 반영한다.
 *
 * action별 자동 처리:
 * - order-request: 오더 생성 + kind 30402 발행
 * - claim: 오더 상태 전이 (requested → claimed) + kind 30402 갱신
 * - payment-confirm: Customer 입금 컨펌 → paid 전이 + kind 30402 갱신
 * - cancel-request: Customer 취소 요청 → cancelled 전이 + kind 30402 갱신
 *
 * Admin UI 트리거:
 * - approveOrder: 클레임 승인 (claimed → verified) + kind 30402 갱신
 * - revertClaim: 클레임 철회 (claimed → requested) + kind 30402 갱신
 */
import {
  getReadRelays,
  APP_PUBKEY,
  idbGetOrder,
  idbUpsertOrder,
  idbUpsertRequest,
  idbGetRequestsByOrderId,
  idbMigrateOrderWithRequests,
  processDisputeEvent,
  createSubscriptionGuard,
  createSingleFlight,
  type Order,
  type Request,
  type OrderRequest,
  type ClaimRequest,
  type PriceTracker,
  storage,
} from '@sajwo-tracker/shared';
import { subscribeAdmin } from './subscribe';
import { publishOrder, publishClaimPriceError, publishDepositRequired } from './publish';
import { getSigner } from './nip46';
import { parseRequestEvent, parseOrderEvent } from '../types';
import { upsertRequest, markSynced } from '../request-store';
import { upsertOrder, getOrder } from '../order-store';
import { canTransition, isInvoiceAmountValid } from '../state-machine';
import type { LightningAdapter } from '../lightning';
import { getPreimage, getEscrowEntry } from '../escrow-store';
import { getCustomerDepositPercent, getSponsorDepositPercent } from '../deposit-config';
import { savePendingDeposit, getPendingDeposit } from '../pending-deposit-store';
import { handleDepositOnTransition } from '../deposit-lifecycle';

const guard = createSubscriptionGuard('Admin');
let lnAdapterRef: LightningAdapter | null = null;
let priceTrackerRef: PriceTracker | null = null;

/** LN 어댑터 참조를 설정한다. App 마운트 시 호출. */
export function setLnAdapter(adapter: LightningAdapter | null): void {
  lnAdapterRef = adapter;
}

/** PriceTracker 참조를 설정한다. App 마운트 시 호출. */
export function setPriceTracker(tracker: PriceTracker | null): void {
  priceTrackerRef = tracker;
}

export function startAdminSubscription(): Promise<void> {
  return guard.start(async () => {
    const relays = await getReadRelays(storage);

    // EOSE까지 리퀘스트를 버퍼링하여 catch-up 중 stale 상태 기반 처리를 방지한다.
    // 오더 에코가 먼저 로컬에 반영된 후 버퍼의 리퀘스트를 처리하면
    // canTransition이 과거 리퀘스트를 정확히 거부한다.
    let pendingRequests: Request[] | null = [];

    return subscribeAdmin(relays, {
      onRequest: (event) => {
        const request = parseRequestEvent(event);
        if (!request) return;

        // dispute-message는 messages IDB에만 저장 (requests 스토어 skip)
        if (request.action === 'dispute-message') {
          void handleDisputeMessage(request);
          return;
        }

        upsertRequest(request);
        void syncRequestToIdb(request);

        // catch-up 중이면 버퍼에 쌓고, EOSE 이후에 처리
        if (pendingRequests) {
          pendingRequests.push(request);
          return;
        }

        dispatchRequest(request);
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
        // 오더 상태가 최신으로 반영된 후 버퍼의 리퀘스트를 순차 처리
        const buffered = pendingRequests;
        pendingRequests = null;
        if (buffered) {
          for (const req of buffered) {
            dispatchRequest(req);
          }
        }
      },
    });
  });
}

/** 리퀘스트를 action별 핸들러에 분배한다. */
function dispatchRequest(request: Request): void {
  if (request.action === 'order-request') {
    void handleOrderRequest(request);
  } else if (request.action === 'claim') {
    void handleClaim(request);
  } else if (request.action === 'payment-confirm') {
    void handlePaymentConfirm(request);
  } else if (request.action === 'cancel-request') {
    void handleCancelRequest(request);
  } else if (request.action === 'account-info') {
    handleAccountInfo(request);
  } else if (request.action === 'remit-request') {
    void handleRemitRequest(request);
  }
}

export function stopAdminSubscription(): void {
  guard.stop();
}

// ============================================================
// Admin UI Actions
// ============================================================

/**
 * 클레임을 승인하여 claimed → verified로 전이하고 kind 30402를 발행한다.
 * hold invoice를 생성하여 오더에 첨부한다. 프리이미지는 NIP-44 암호화 저장 + 릴레이 백업된다.
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

  // CLTV 타임아웃 = 오더 만료까지 남은 시간 + 48시간 (분쟁 판정 여유)
  // 오더 만료 후에도 Admin이 settle/cancel할 시간을 확보한다.
  // 10분/블록 기준으로 초 → 블록 수 변환 (올림)
  const DISPUTE_MARGIN_SECONDS = 48 * 60 * 60;
  const cltvExpiry = Math.ceil((expiry + DISPUTE_MARGIN_SECONDS) / 600);

  // hold invoice 생성 (프리이미지는 LN 어댑터 내부에서 NIP-44 암호화 저장 + 릴레이 백업)
  let bolt11: string;
  try {
    const result = await lnAdapter.createHoldInvoice(orderId, amountSat, expiry, cltvExpiry);
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

/**
 * 유동성 검증 실패 등으로 클레임을 철회하여 claimed → requested로 되돌린다.
 * sponsorPubkey를 제거하여 다른 후원자가 클레임할 수 있도록 한다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
export async function revertClaim(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'requested')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → requested` };
  }

  const updatedOrder: Order = {
    ...order,
    state: 'requested',
    sponsorPubkey: undefined,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'reverted to requested (claim withdrawn)');
  } catch (e) {
    console.error('[Admin] Failed to publish reverted order for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  return { success: true };
}

/**
 * Sponsor에게 BTC를 송금한다.
 * paid 또는 sponsor_wins 상태에서 호출 가능.
 * IDB에서 해당 Sponsor의 claim request를 조회하여 원본 bolt11로 결제한다.
 * 성공 시 order에 disbursed: true를 기록하여 중복 송금을 방지한다.
 */
export async function disburseSponsor(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (order.state !== 'paid' && order.state !== 'sponsor_wins') {
    return { success: false, error: `INVALID_STATE: ${order.state}` };
  }
  if (order.disbursed) {
    return { success: false, error: 'ALREADY_DISBURSED' };
  }
  if (!order.sponsorPubkey) {
    return { success: false, error: 'NO_SPONSOR_PUBKEY' };
  }
  if (!lnAdapterRef) {
    return { success: false, error: 'NO_LN_ADAPTER' };
  }

  // `disbursed` 검사와 기록 사이에 LN 결제 await이 통째로 들어간다. 버튼 더블클릭이나
  // invoice-watcher와 겹치면 두 호출이 모두 위 검사를 통과해 결제를 시도할 수 있다.
  // 지금까지 이중 지급이 안 난 건 LND가 payment hash로 중복을 걸러줬기 때문이지
  // 이 코드가 막아서가 아니었다(감사 2026-09-13 A-2). 우리 쪽에서 먼저 닫는다.
  const adapter = lnAdapterRef;
  return disbursing.run(
    orderId,
    () => runDisbursement(orderId, order, adapter),
    () => ({ success: false, error: 'DISBURSEMENT_IN_FLIGHT' }),
  );
}

/** 진행 중인 지급. 같은 오더로 두 번 들어오면 두 번째를 거절한다. */
const disbursing = createSingleFlight();

/** 어댑터는 인자로 받는다 — 모듈 참조를 다시 읽으면 위에서 한 null 체크가 무의미해진다. */
async function runDisbursement(
  orderId: string,
  order: Order,
  lnAdapter: LightningAdapter,
): Promise<{ success: boolean; error?: string }> {

  // IDB에서 해당 Sponsor의 claim request 조회 → bolt11 추출
  let sponsorBolt11: string | undefined;
  try {
    const requests = await idbGetRequestsByOrderId(orderId);
    const claimRequest = requests
      .filter((r): r is ClaimRequest => r.action === 'claim' && r.pubkey === order.sponsorPubkey && !!r.invoice?.bolt11)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    sponsorBolt11 = claimRequest?.invoice?.bolt11;
  } catch (e) {
    console.error('[Admin] IDB request lookup failed for', orderId, e);
    return { success: false, error: 'IDB_LOOKUP_FAILED' };
  }

  if (!sponsorBolt11) {
    return { success: false, error: 'NO_SPONSOR_BOLT11' };
  }

  // 결제 전송
  try {
    const result = await lnAdapter.payInvoice(sponsorBolt11);
    if (result.status !== 'succeeded') {
      console.warn('[Admin] Disbursement failed for', orderId, result.failureReason);
      return { success: false, error: result.failureReason ?? 'PAYMENT_FAILED' };
    }
    // preimage는 찍지 않는다 — 수령 증명이라도 콘솔에 남길 이유가 없다(감사 A-4).
    console.log('[Admin] Disbursement succeeded for', orderId);
  } catch (e) {
    console.error('[Admin] Disbursement error for', orderId, e);
    return { success: false, error: 'PAYMENT_ERROR' };
  }

  // 성공 → disbursed 플래그 기록
  // 릴레이 에코 수신 시 upsertOrder의 updatedAt >= 비교에서 드롭되지 않도록
  // 현재 로컬 상태보다 반드시 큰 타임스탬프를 사용한다.
  const freshOrder = getOrder(orderId);
  const baseOrder = freshOrder ?? order;
  const updatedOrder: Order = {
    ...baseOrder,
    disbursed: true,
    updatedAt: Math.max(Math.floor(Date.now() / 1000), baseOrder.updatedAt + 1),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'marked as disbursed');
  } catch (e) {
    // 결제는 성공했지만 발행 실패 — 로그에 남김 (재시도 시 ALREADY_DISBURSED 아닌 상태)
    console.error('[Admin] Disbursement publish failed for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED_AFTER_PAYMENT' };
  }

  return { success: true };
}

/**
 * 분쟁 판정: Sponsor 승리 (remitted → sponsor_wins).
 *
 * 1. FSM 검증
 * 2. Hold invoice settle (아직 accepted 상태인 경우)
 * 3. kind 30402 발행 (state: sponsor_wins)
 * 4. Sponsor에게 BTC 자동 송금 (fire-and-forget)
 */
export async function resolveDisputeSponsorWins(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'sponsor_wins')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → sponsor_wins` };
  }

  // Hold invoice settle (프리이미지가 있고 아직 accepted 상태인 경우)
  const preimage = getPreimage(orderId);
  if (preimage && lnAdapterRef) {
    const entry = getEscrowEntry(orderId);
    if (entry) {
      try {
        const status = await lnAdapterRef.lookupHoldInvoice(entry.paymentHash);
        if (status === 'accepted') {
          await lnAdapterRef.settleInvoice(preimage);
          console.log('[Admin] Hold invoice settled for sponsor_wins:', orderId);
        } else if (status === 'settled') {
          console.log('[Admin] Hold invoice already settled (safety net) for:', orderId);
        } else if (status === 'cancelled') {
          // BTC 이미 환불됨 — sponsor_wins 판정이지만 BTC 정산 불가
          console.error('[Admin] Hold invoice cancelled, cannot settle for sponsor_wins:', orderId);
          return { success: false, error: 'INVOICE_ALREADY_CANCELLED' };
        }
      } catch (e) {
        console.error('[Admin] Hold invoice settle failed for sponsor_wins:', orderId, e);
        return { success: false, error: 'SETTLE_FAILED' };
      }
    }
  } else {
    console.warn('[Admin] Cannot settle: missing', !preimage ? 'preimage' : 'lnAdapter', 'for', orderId);
  }

  const updatedOrder: Order = {
    ...order,
    state: 'sponsor_wins',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'resolved: sponsor_wins');
  } catch (e) {
    console.error('[Admin] Failed to publish sponsor_wins for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  // Sponsor에게 BTC 자동 송금 (fire-and-forget)
  void disburseSponsor(orderId).then(result => {
    if (!result.success) {
      console.warn('[Admin] Auto-disbursement failed for sponsor_wins:', orderId, result.error);
    }
  });

  // 스폰서 보증금 환불 (sponsor_wins = 스폰서 정당, fire-and-forget)
  void handleDepositOnTransition(updatedOrder, 'sponsor_wins', lnAdapterRef).catch(err =>
    console.warn('[Admin] Sponsor deposit lifecycle failed on sponsor_wins:', orderId, err),
  );

  return { success: true };
}

/**
 * 분쟁 판정: Customer 승리 (remitted → customer_wins).
 *
 * 1. FSM 검증
 * 2. Hold invoice cancel (아직 accepted 상태인 경우) → BTC 자동 환불
 *    이미 settled인 경우 → 경고 (별도 LN 결제 환불 필요)
 * 3. kind 30402 발행 (state: customer_wins)
 */
export async function resolveDisputeCustomerWins(
  orderId: string,
): Promise<{ success: boolean; error?: string; warning?: string }> {
  const order = getOrder(orderId);
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, 'customer_wins')) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → customer_wins` };
  }

  let warning: string | undefined;

  // Hold invoice cancel (아직 accepted 상태인 경우 → BTC 자동 환불)
  const entry = getEscrowEntry(orderId);
  if (entry && lnAdapterRef) {
    try {
      const status = await lnAdapterRef.lookupHoldInvoice(entry.paymentHash);
      if (status === 'accepted') {
        await lnAdapterRef.cancelInvoice(entry.paymentHash);
        console.log('[Admin] Hold invoice cancelled for customer_wins:', orderId);
      } else if (status === 'settled') {
        // Safety net이 이미 settle함 → BTC가 Admin에게 확정됨
        // 별도 LN 결제로 Customer에게 환불 필요 (수동 처리)
        warning = 'INVOICE_ALREADY_SETTLED';
        console.warn(
          '[Admin] Hold invoice already settled for customer_wins:',
          orderId,
          '— manual LN refund to customer required',
        );
      } else if (status === 'cancelled') {
        console.log('[Admin] Hold invoice already cancelled (CLTV timeout) for:', orderId);
      }
    } catch (e) {
      console.error('[Admin] Hold invoice cancel failed for customer_wins:', orderId, e);
      return { success: false, error: 'CANCEL_FAILED' };
    }
  } else {
    console.warn('[Admin] Cannot cancel: missing', !entry ? 'escrowEntry' : 'lnAdapter', 'for', orderId);
  }

  const updatedOrder: Order = {
    ...order,
    state: 'customer_wins',
    status: 'sold',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', orderId, 'resolved: customer_wins');
  } catch (e) {
    console.error('[Admin] Failed to publish customer_wins for', orderId, e);
    return { success: false, error: 'PUBLISH_FAILED' };
  }

  // 스폰서 보증금 몰수 (customer_wins = 스폰서 트롤링 판정, fire-and-forget)
  void handleDepositOnTransition(updatedOrder, 'customer_wins', lnAdapterRef).catch(err =>
    console.warn('[Admin] Sponsor deposit lifecycle failed on customer_wins:', orderId, err),
  );

  return { success: true, warning };
}

// ============================================================
// Action Handlers (Inbound Request)
// ============================================================

/**
 * order-request 수신 시 자동으로 오더를 생성하고 kind 30402를 발행한다.
 * 이미 존재하는 orderId면 중복 생성하지 않는다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
async function handleOrderRequest(request: OrderRequest): Promise<void> {
  const existing = getOrder(request.orderId);
  if (existing) return;

  // 이미 보증금 대기 중인 요청이면 중복 처리 방지
  if (getPendingDeposit(request.orderId)) return;

  const depositPercent = getCustomerDepositPercent();

  // ── 보증금 분기: depositPercent > 0이고 LN 어댑터 + 시세 데이터가 있으면 보증금 요구 ──
  if (depositPercent > 0 && lnAdapterRef && priceTrackerRef) {
    const btcPrice = priceTrackerRef.getSnapshot().price;
    if (btcPrice && btcPrice > 0) {
      const depositSats = Math.round((request.price / btcPrice) * 1e8 * depositPercent / 100);
      if (depositSats > 0) {
        try {
          const now = Math.floor(Date.now() / 1000);
          const expiry = request.expiration - now;
          if (expiry <= 0) return; // 이미 만료

          const DEPOSIT_CLTV_MARGIN = 24 * 60 * 60; // 24시간
          const cltvExpiry = Math.ceil((expiry + DEPOSIT_CLTV_MARGIN) / 600);

          // deposit:orderId 키로 hold invoice 생성 → escrow-store에 자동 저장
          const result = await lnAdapterRef.createHoldInvoice(
            `deposit:${request.orderId}`, depositSats, expiry, cltvExpiry,
          );

          // pending-deposit-store에 저장
          savePendingDeposit({
            orderId: request.orderId,
            customerPubkey: request.pubkey,
            type: 'customer',
            price: request.price,
            expiration: request.expiration,
            depositPaymentHash: result.paymentHash,
            depositBolt11: result.bolt11,
            createdAt: now,
          });

          // Customer에게 deposit-required 알림 발행
          await publishDepositRequired(
            request.orderId, request.pubkey, result.bolt11, request.expiration,
          );
          console.log('[Admin] Deposit required for', request.orderId, `(${depositSats} sats, ${depositPercent}%)`);
          return; // 오더는 보증금 결제 후 생성
        } catch (e) {
          console.warn('[Admin] Deposit creation failed, falling back to direct order:', request.orderId, e);
          // 보증금 생성 실패 → 기존 플로우로 폴백
        }
      }
    }
  }

  // ── 기존 플로우: 오더 즉시 발행 ──
  await createOrder(request);
}

/**
 * order-request로부터 오더를 생성하고 kind 30402를 발행한다.
 * @returns 발행 성공 여부 (호출측에서 후속 처리 분기에 사용)
 */
export async function createOrder(request: OrderRequest, depositPaymentHash?: string): Promise<boolean> {
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
    ...(depositPaymentHash ? { depositPaymentHash } : {}),
    raw: {},
  };

  try {
    await publishOrder(newOrder);
    console.log('[Admin] Auto-created order', request.orderId, 'from order-request');
  } catch (e) {
    console.error('[Admin] Failed to publish order for', request.orderId, e);
    return false;
  }

  // 오더 생성 시점부터 IDB에 이관하여 히스토리 + 채팅을 즉시 활성화 (fire-and-forget)
  idbMigrateOrderWithRequests(newOrder, [request]).catch((err: unknown) =>
    console.warn('[Admin] IndexedDB migration failed for', request.orderId, err),
  );

  return true;
}

/**
 * payment-confirm 수신 시 오더를 paid로 전이하고 kind 30402를 발행한다.
 * escrowed 또는 remitted 상태에서 전이 가능 (Customer의 자동 파싱으로 입금 감지).
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
/** @testing-only */
export async function handlePaymentConfirm(request: Request): Promise<void> {
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

  // 스폰서 보증금 환불 (paid = 정상 완료, fire-and-forget)
  void handleDepositOnTransition(updatedOrder, 'paid', lnAdapterRef).catch(err =>
    console.warn('[Admin] Deposit lifecycle failed on paid for', request.orderId, err),
  );

  // Hold invoice settle (프리이미지 제출 → BTC 정산)
  const preimage = getPreimage(request.orderId);
  if (preimage && lnAdapterRef) {
    try {
      await lnAdapterRef.settleInvoice(preimage);
      console.log('[Admin] Hold invoice settled for', request.orderId);

      // Settle 성공 → Sponsor에게 자동 송금 (fire-and-forget)
      void disburseSponsor(request.orderId).then(result => {
        if (!result.success) {
          console.warn('[Admin] Auto-disbursement failed for', request.orderId, result.error);
        }
      });
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
/** @testing-only */
export async function handleCancelRequest(request: Request): Promise<void> {
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
    return;
  }

  // 보증금 cancel/settle
  void handleDepositOnTransition(order, 'cancelled', lnAdapterRef).catch(e =>
    console.warn('[Admin] Deposit lifecycle failed on cancel for', request.orderId, e),
  );
}

/**
 * account-info 수신 시 로그만 남긴다 (상태 전이 없음).
 * Customer가 Sponsor에게 NIP-44 암호화 계좌 정보를 전달한 것으로,
 * Admin은 분쟁 시 commitment 태그로 검증할 수 있다.
 */
function handleAccountInfo(request: Request): void {
  console.log('[Admin] account-info received for', request.orderId, 'from', request.pubkey);
}

/**
 * dispute-message 수신 시 NIP-44 복호화 후 IDB에 자동 저장한다.
 * 디테일 페이지 미진입 상태에서도 분쟁 메시지를 영구 보존하기 위함.
 * 리액티브 스토어는 갱신하지 않음 (on-demand 구독이 담당).
 */
async function handleDisputeMessage(request: Request): Promise<void> {
  const signer = getSigner();
  if (!signer) return;
  const event = request.raw as { id: string; pubkey: string; content: string; tags: string[][]; created_at: number };
  await processDisputeEvent(event, request.orderId, (_content, senderPubkey, recipientPubkey) => {
    const remotePubkey = senderPubkey === APP_PUBKEY ? recipientPubkey : senderPubkey;
    return signer.nip44Decrypt(remotePubkey, event.content);
  });
}

/**
 * claim 수신 시 오더를 requested → claimed로 전이하고 kind 30402를 발행한다.
 * - 오더가 없거나 전이 불가면 무시 (선착순: 이미 claimed면 후속 클레임 거부)
 * - 인보이스가 없거나 디코딩 실패면 무시
 * - 인보이스 금액이 현재 시세 대비 0.95~1.05 범위 밖이면 무시
 * - sponsorPubkey를 기록하여 이후 유동성 검증 등에 사용
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
/** @testing-only */
export async function handleClaim(request: ClaimRequest): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) {
    console.warn('[Admin] Claim for unknown order:', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'claimed')) {
    console.warn('[Admin] Cannot claim order', request.orderId, '- current state:', order.state);
    return;
  }

  // 자기 주문 자기가 클레임 금지.
  // 고객앱과 후원자앱이 한 앱으로 합쳐지면서 한 키가 양쪽 역할을 모두 하게 됐다.
  // 막지 않으면 자기 주문을 자기가 받아 에스크로 유동성과 라우팅 수수료만
  // 태울 수 있고, 무엇보다 그 오더는 customerPubkey === sponsorPubkey가 되어
  // "내가 어느 역할로 참여했는가"를 유도할 수 없게 된다(내역 화면의 전제).
  // UI도 거르지만 진짜 방어는 여기다 — kind 1111은 누구나 서명해 쏠 수 있다.
  if (request.pubkey === order.customerPubkey) {
    console.warn('[Admin] Self-claim rejected for', request.orderId);
    return;
  }

  // ── 인보이스 검증 ──
  const decoded = request.invoice?.decoded;
  if (!decoded) {
    console.warn('[Admin] Claim without valid invoice, ignoring:', request.orderId);
    return;
  }

  // ── 가격 범위 검증 ──
  const btcPrice = priceTrackerRef?.getSnapshot().price;
  if (!btcPrice || btcPrice <= 0) {
    console.warn('[Admin] No price feed available, rejecting claim:', request.orderId);
    return;
  }
  if (!isInvoiceAmountValid(order.price, btcPrice, decoded.amountSat)) {
    const expectedSat = Math.round((order.price / btcPrice) * 1e8);
    console.warn(
      '[Admin] Claim price out of range, ignoring: %s (expected ~%d sat, got %d sat)',
      request.orderId, expectedSat, decoded.amountSat,
    );
    // 가격 오류 알림 (best-effort, 실패해도 무시)
    void publishClaimPriceError(request.orderId, request.pubkey, expectedSat).catch(() => {});
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
    return;
  }

  // ── 후원자 보증금 (pre-verification gate) ──
  const sponsorDepositPercent = getSponsorDepositPercent();
  if (sponsorDepositPercent > 0 && lnAdapterRef) {
    try {
      const depositSats = Math.max(1, Math.round(decoded.amountSat * sponsorDepositPercent / 100));
      const now = Math.floor(Date.now() / 1000);
      const expiry = Math.max(300, order.expiration - now);
      const DEPOSIT_CLTV_MARGIN = 24 * 60 * 60; // 24시간
      const cltvExpiry = Math.ceil((expiry + DEPOSIT_CLTV_MARGIN) / 600);

      const result = await lnAdapterRef.createHoldInvoice(
        `deposit:sponsor:${request.orderId}`, depositSats, expiry, cltvExpiry,
      );

      savePendingDeposit({
        orderId: request.orderId,
        customerPubkey: order.customerPubkey,
        type: 'sponsor',
        sponsorPubkey: request.pubkey,
        price: order.price,
        expiration: order.expiration,
        depositPaymentHash: result.paymentHash,
        depositBolt11: result.bolt11,
        createdAt: now,
      });

      // Sponsor에게 deposit-required 알림 발행
      await publishDepositRequired(
        request.orderId, request.pubkey, result.bolt11, order.expiration,
      );

      console.log('[Admin] Sponsor deposit required for', request.orderId, depositSats, 'sats');
    } catch (e) {
      console.error('[Admin] Sponsor deposit creation failed for', request.orderId, e);
    }
  }
}

/**
 * remit-request 수신 시 오더를 escrowed → remitted로 전이하고 kind 30402를 발행한다.
 * Sponsor가 원화 송금 완료를 통보한 것으로, sponsorPubkey 검증 후 전이한다.
 * 로컬 스토어는 릴레이 에코 수신 시 onOrder 콜백에서 갱신된다.
 */
async function handleRemitRequest(request: Request): Promise<void> {
  const order = getOrder(request.orderId);
  if (!order) return;

  if (order.sponsorPubkey !== request.pubkey) {
    console.warn('[Admin] remit-request pubkey mismatch for', request.orderId);
    return;
  }

  if (!canTransition(order.state, 'remitted')) {
    console.warn('[Admin] Cannot transition to remitted for', request.orderId, '- current state:', order.state);
    return;
  }

  const updatedOrder: Order = {
    ...order,
    state: 'remitted',
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[Admin] Order', request.orderId, 'remitted (remit-request from sponsor)');
  } catch (e) {
    console.error('[Admin] Failed to publish remitted order for', request.orderId, e);
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

async function syncRequestToIdb(request: Request): Promise<void> {
  try {
    const existing = await idbGetOrder(request.orderId);
    if (existing) await idbUpsertRequest(request);
  } catch (err) {
    console.warn('[Admin] IndexedDB request sync failed for', request.orderId, err);
  }
}
