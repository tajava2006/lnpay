/**
 * 보증금 hold invoice 생명주기 관리
 *
 * 오더 상태 전이 시 보증금 hold invoice를 자동으로 cancel/settle한다.
 *
 * - escrowed 전이: cancel (환불) — 실결제가 담보 역할 인수
 * - cancelled 전이:
 *   - sponsorPubkey 없음: cancel (환불) — Sponsor 관여 전
 *   - sponsorPubkey 있음: settle (몰수) — Sponsor 시간 낭비 페널티
 */

import type { Order, OrderState } from '@sajwo-tracker/shared';
import type { LightningAdapter } from './lightning';
import { getEscrowEntry, getPreimage } from './escrow-store';
import { publishDepositStatus } from './nostr/publish';

/**
 * 오더 상태 전이 시 보증금 hold invoice를 처리한다.
 * depositPaymentHash가 없는 오더(보증금 없음)에서는 아무 동작 없이 반환.
 */
export async function handleDepositOnTransition(
  order: Order,
  newState: OrderState,
  lnAdapter: LightningAdapter | null,
): Promise<void> {
  if (!order.depositPaymentHash || !lnAdapter) return;

  const depositKey = `deposit:${order.orderId}`;
  const entry = getEscrowEntry(depositKey);
  if (!entry) return;

  try {
    const status = await lnAdapter.lookupHoldInvoice(entry.paymentHash);
    if (status !== 'accepted') {
      // 이미 settled/cancelled — 추가 처리 불필요
      return;
    }

    if (newState === 'escrowed') {
      // 실결제 완료 → 보증금 환불
      await lnAdapter.cancelInvoice(entry.paymentHash);
      void publishDepositStatus(order.orderId, order.customerPubkey, 'cancelled');
      console.log('[Deposit] Cancelled (refund) on escrowed:', order.orderId);
    } else if (newState === 'cancelled') {
      if (order.sponsorPubkey) {
        // Sponsor가 클레임한 상태에서 취소 → 보증금 몰수
        const preimage = getPreimage(depositKey);
        if (preimage) {
          await lnAdapter.settleInvoice(preimage);
          void publishDepositStatus(order.orderId, order.customerPubkey, 'settled');
          console.log('[Deposit] Settled (forfeit) on cancelled:', order.orderId);
        }
      } else {
        // Sponsor 관여 전 취소 → 보증금 환불
        await lnAdapter.cancelInvoice(entry.paymentHash);
        void publishDepositStatus(order.orderId, order.customerPubkey, 'cancelled');
        console.log('[Deposit] Cancelled (refund) on cancelled:', order.orderId);
      }
    }
  } catch (err) {
    console.error('[Deposit] Lifecycle failed for', order.orderId, err);
  }
}
