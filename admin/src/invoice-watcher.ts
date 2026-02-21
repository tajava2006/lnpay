/**
 * Hold invoice 결제 감시 백그라운드 프로세스
 *
 * verified 상태의 오더를 주기적으로 순회하며
 * hold invoice 상태를 LN 노드에 조회하여 자동 전이한다.
 *
 * - open: 스킵 (아직 미결제)
 * - accepted: verified → escrowed (HTLC 잠김, BTC 에스크로)
 * - settled: 경고 로그 (Admin 제어 외 settle은 비정상)
 * - cancelled: verified → cancelled (인보이스 만료/취소)
 */
import type { LightningAdapter } from './lightning';
import type { Order } from '@sajwo-tracker/shared';
import { getSnapshot } from './order-store';
import { getEscrowEntry } from './escrow-store';
import { canTransition } from './state-machine';
import { publishOrder } from './nostr/publish';

const POLL_INTERVAL = 15_000; // 15초

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
  } finally {
    polling = false;
  }
}

async function transitionOrder(
  order: Order,
  to: 'escrowed' | 'cancelled',
): Promise<void> {
  if (!canTransition(order.state, to)) return;

  const updatedOrder: Order = {
    ...order,
    state: to,
    ...(to === 'cancelled' ? { status: 'sold' as const } : {}),
    updatedAt: Math.floor(Date.now() / 1000),
  };

  try {
    await publishOrder(updatedOrder);
    console.log('[InvoiceWatcher] Order', order.orderId, `${order.state} → ${to}`);
  } catch (err) {
    console.error('[InvoiceWatcher] Failed to publish', to, 'for', order.orderId, err);
  }
}
