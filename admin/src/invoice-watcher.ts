/**
 * Hold invoice 결제 감시 백그라운드 프로세스
 *
 * 1. verified 오더: hold invoice 상태를 조회하여 자동 전이
 *    - open: 스킵 (아직 미결제)
 *    - accepted: verified → escrowed (HTLC 잠김, BTC 에스크로)
 *    - settled: 경고 로그 (Admin 제어 외 settle은 비정상)
 *    - cancelled: verified → cancelled (인보이스 만료/취소)
 *
 * 2. remitted 오더: 만료 임박 시 자동 settle + 만료 감지
 *    - accepted + 만료 10분 이내: 선제 settle (비대칭 손실 원칙)
 *    - cancelled: customer_wins 전이 (BTC 자동 환불됨, 안전망 실패)
 *    - settled: 스킵 (이미 settle됨, Admin 판정 대기)
 */
import type { LightningAdapter } from './lightning';
import type { Order, OrderState } from '@sajwo-tracker/shared';
import { getSnapshot } from './order-store';
import { getSnapshot as getRequestSnapshot } from './request-store';
import { getEscrowEntry } from './escrow-store';
import { canTransition } from './state-machine';
import { publishOrder } from './nostr/publish';
import { idbMigrateOrder } from './idb-store';

const POLL_INTERVAL = 15_000; // 15초
const SETTLE_SAFETY_MARGIN = 10 * 60; // 10분

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'paid', 'cancelled', 'sponsor_wins', 'customer_wins',
]);

let adapter: LightningAdapter | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

export function startInvoiceWatcher(lnAdapter: LightningAdapter): void {
  adapter = lnAdapter;
  if (timer) return;
  void poll();
  timer = setInterval(() => void poll(), POLL_INTERVAL);
}

export function stopInvoiceWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  adapter = null;
}

async function poll(): Promise<void> {
  if (polling || !adapter) return;
  polling = true;

  try {
    const orders = Object.values(getSnapshot());

    // Phase 1: verified 오더 — hold invoice 결제 감지
    const verified = orders.filter(o => o.state === 'verified');

    for (const order of verified) {
      const entry = getEscrowEntry(order.orderId);
      if (!entry) continue;

      try {
        const status = await adapter!.lookupHoldInvoice(entry.paymentHash);

        if (status === 'accepted') {
          await transitionOrder(order, 'escrowed');
        } else if (status === 'cancelled') {
          await transitionOrder(order, 'cancelled');
        } else if (status === 'settled') {
          console.error(
            '[InvoiceWatcher] UNEXPECTED: invoice already settled for',
            order.orderId,
          );
        }
      } catch (err) {
        console.warn('[InvoiceWatcher] lookup failed for', order.orderId, err);
      }
    }

    // Phase 2: remitted 오더 — 만료 임박 자동 settle + 만료 감지
    const remitted = orders.filter(o => o.state === 'remitted');

    for (const order of remitted) {
      await handleRemittedOrder(order);
    }
  } finally {
    polling = false;
  }
}

/**
 * remitted 오더의 hold invoice를 감시한다.
 * - accepted + 만료 10분 이내: 선제 settle (비대칭 손실 원칙)
 * - cancelled: customer_wins 전이 (안전망 실패, BTC 자동 환불됨)
 * - settled: 스킵 (이미 settle됨, Admin 판정 대기)
 */
async function handleRemittedOrder(order: Order): Promise<void> {
  const entry = getEscrowEntry(order.orderId);
  if (!entry) return;

  try {
    const status = await adapter!.lookupHoldInvoice(entry.paymentHash);
    const now = Math.floor(Date.now() / 1000);
    const timeToExpiry = order.expiration - now;

    if (status === 'accepted' && timeToExpiry <= SETTLE_SAFETY_MARGIN) {
      // 만료 임박: 선제 settle (비대칭 손실 원칙)
      try {
        await adapter!.settleInvoice(entry.preimage);
        console.log(
          '[InvoiceWatcher] SAFETY-NET: Auto-settled remitted order',
          order.orderId,
          `(${timeToExpiry}s to expiry)`,
        );
      } catch (err) {
        console.error(
          '[InvoiceWatcher] Failed to auto-settle remitted order',
          order.orderId,
          err,
        );
      }
    }
    // settled → 이미 settle됨 (수동 또는 자동). Admin 판정 대기.
    // accepted + time > margin → 아직 여유 있음. 스킵.
    // cancelled → CLTV 만료, BTC 자동 환불. Admin이 IndexedDB에서 확인 후 수동 판정.
  } catch (err) {
    console.warn('[InvoiceWatcher] remitted order lookup failed for', order.orderId, err);
  }
}

async function transitionOrder(
  order: Order,
  to: OrderState,
): Promise<void> {
  if (!canTransition(order.state, to)) return;

  const updatedOrder: Order = {
    ...order,
    state: to,
    ...(TERMINAL_STATES.has(to) ? { status: 'sold' as const } : {}),
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[InvoiceWatcher] Order', order.orderId, `${order.state} → ${to}`);
  } catch (err) {
    console.error('[InvoiceWatcher] Failed to publish', to, 'for', order.orderId, err);
    return;
  }

  // escrowed 진입 시 IndexedDB에 오더 + 연관 requests 이관 (fire-and-forget)
  if (to === 'escrowed') {
    const allRequests = Object.values(getRequestSnapshot());
    const related = allRequests.filter(r => r.orderId === order.orderId);
    idbMigrateOrder(updatedOrder, related).catch(err =>
      console.warn('[InvoiceWatcher] IndexedDB migration failed for', order.orderId, err),
    );
  }
}
