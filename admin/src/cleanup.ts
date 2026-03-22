/**
 * localStorage 만료 삭제 스케줄러
 *
 * 만료된 오더와 연관 요청을 주기적으로 삭제한다.
 * 상태 무관 — expiration 기준으로만 판단한다.
 *
 * 만료된 pending deposit도 정리하고, 보증금 hold invoice를 cancel한다.
 */
import type { LightningAdapter } from './lightning';
import { purgeExpired } from './order-store';
import { purgeByOrderIds } from './request-store';
import { purgeByOrderIds as purgeEscrowByOrderIds } from './escrow-store';
import { purgeExpiredDeposits } from './pending-deposit-store';
import { handleDepositOnTransition } from './deposit-lifecycle';
import { getOrder } from './order-store';

const CLEANUP_INTERVAL = 60_000; // 60초
let timer: ReturnType<typeof setInterval> | null = null;
let lnAdapterRef: LightningAdapter | null = null;

function runCleanup(): void {
  const expiredOrderIds = purgeExpired();
  if (expiredOrderIds.length > 0) {
    purgeByOrderIds(expiredOrderIds);

    // deposit:orderId 키도 함께 삭제
    const depositKeys = expiredOrderIds.map(id => `deposit:${id}`);
    purgeEscrowByOrderIds([...expiredOrderIds, ...depositKeys]);

    // 만료 오더의 보증금 cancel/settle (best-effort)
    for (const orderId of expiredOrderIds) {
      const order = getOrder(orderId);
      if (order?.depositPaymentHash) {
        void handleDepositOnTransition(order, 'cancelled', lnAdapterRef).catch(err =>
          console.warn('[Cleanup] Deposit lifecycle failed for', orderId, err),
        );
      }
    }

    console.log('[Cleanup] Purged', expiredOrderIds.length, 'expired orders + related requests + escrow entries');
  }

  // 만료된 pending deposit 정리 (오더 미생성 상태로 만료된 보증금)
  const expiredDeposits = purgeExpiredDeposits();
  if (expiredDeposits.length > 0) {
    // deposit preimage 삭제
    const depositEscrowKeys = expiredDeposits.map(d => `deposit:${d.orderId}`);
    purgeEscrowByOrderIds(depositEscrowKeys);

    // 보증금 hold invoice cancel (best-effort, 오더 미생성이므로 무조건 환불)
    if (lnAdapterRef) {
      for (const deposit of expiredDeposits) {
        void lnAdapterRef.cancelInvoice(deposit.depositPaymentHash).catch(err =>
          console.warn('[Cleanup] Expired deposit cancel failed for', deposit.orderId, err),
        );
      }
    }

    console.log('[Cleanup] Purged', expiredDeposits.length, 'expired pending deposits');
  }
}

export function startCleanup(lnAdapter?: LightningAdapter | null): void {
  if (timer) return;
  lnAdapterRef = lnAdapter ?? null;
  runCleanup(); // 즉시 1회 실행
  timer = setInterval(runCleanup, CLEANUP_INTERVAL);
}

export function stopCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lnAdapterRef = null;
}
