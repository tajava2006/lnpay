/**
 * 만료 삭제 스케줄러
 *
 * localStorage: 만료된 오더와 연관 요청을 주기적으로 삭제한다.
 * 상태 무관 — expiration 기준으로만 판단한다. 보존할 것은 IDB에 있다.
 *
 * IndexedDB: **방치된 채 만료된 오더만** 지운다. Admin의 IDB 게이트를 없애면서
 * (다기기 운영을 막고 있었다) 대신 들어온 장치다. 게이트는 "언제 들어오나"를
 * 막는 도구인데 스팸은 이미 그 문을 통과하고 있었고, GC는 "뭐가 남아있나"를
 * 보므로 실제 쓰레기 — 오더북에 올라왔다가 아무도 손대지 않고 기한이 지난 건 —
 * 를 정확히 집는다.
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
import { idbFindAbandonedOrders, idbDeleteOrders } from '@sajwo-tracker/shared';

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

  void runIdbGc();
}

/**
 * 방치된 채 만료된 오더를 IDB에서 지운다.
 *
 * 한 번이라도 클레임된 오더는 남긴다 — 상태가 requested로 되돌아왔더라도
 * (revertClaim) 후원자가 붙었던 기록이고 보증금이 걸렸을 수 있다.
 * 판정은 idbFindAbandonedOrders가 한다.
 */
async function runIdbGc(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const abandoned = await idbFindAbandonedOrders(now);
    if (abandoned.length === 0) return;

    await idbDeleteOrders(abandoned.map(o => o.orderId));
    console.log(
      '[Cleanup] IDB에서 방치된 만료 의뢰', abandoned.length, '건 삭제:',
      abandoned.map(o => o.orderId).join(', '),
    );
  } catch (err) {
    console.warn('[Cleanup] IDB GC 실패:', err);
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
