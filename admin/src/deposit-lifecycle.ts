/**
 * 보증금 hold invoice 생명주기 관리
 *
 * 오더 상태 전이 시 보증금 hold invoice를 자동으로 cancel/settle한다.
 *
 * ── 고객 보증금 (depositPaymentHash) ──
 * - escrowed 전이: cancel (환불) — 실결제가 담보 역할 인수
 * - cancelled 전이:
 *   - sponsorPubkey 있음: settle (몰수) — Sponsor 시간 낭비 페널티
 *   - sponsorPubkey 없음: cancel (환불) — Sponsor 관여 전
 *
 * ── 후원자 보증금 (sponsorDepositPaymentHash) ──
 * - paid, sponsor_wins 전이: cancel (환불) — 정상 완료 또는 스폰서 승리
 * - customer_wins 전이: settle (몰수) — 스폰서 트롤링 판정
 * - 그 외 (verified, escrowed, cancelled 등): 어드민 수동 판단
 */

import type { Order, OrderState } from '@sajwo-tracker/shared';
import type { LightningAdapter } from './lightning';
import { getEscrowEntry, getPreimage } from './escrow-store';
import { publishDepositStatus } from './nostr/publish';

/**
 * 오더 상태 전이 시 보증금 hold invoice를 처리한다.
 */
export async function handleDepositOnTransition(
  order: Order,
  newState: OrderState,
  lnAdapter: LightningAdapter | null,
): Promise<void> {
  if (!lnAdapter) return;

  // 고객 보증금 처리
  if (order.depositPaymentHash) {
    await handleCustomerDeposit(order, newState, lnAdapter);
  }

  // 후원자 보증금 처리
  if (order.sponsorDepositPaymentHash) {
    await handleSponsorDeposit(order, newState, lnAdapter);
  }
}

async function handleCustomerDeposit(
  order: Order,
  newState: OrderState,
  lnAdapter: LightningAdapter,
): Promise<void> {
  const depositKey = `deposit:${order.orderId}`;
  const entry = getEscrowEntry(depositKey);
  if (!entry) return;

  try {
    const status = await lnAdapter.lookupHoldInvoice(entry.paymentHash);
    if (status !== 'accepted') return;

    if (newState === 'escrowed') {
      await lnAdapter.cancelInvoice(entry.paymentHash);
      void publishDepositStatus(order.orderId, order.customerPubkey, 'cancelled');
      console.log('[Deposit] Customer deposit cancelled (refund) on escrowed:', order.orderId);
    } else if (newState === 'cancelled') {
      if (order.sponsorPubkey) {
        const preimage = getPreimage(depositKey);
        if (preimage) {
          await lnAdapter.settleInvoice(preimage);
          void publishDepositStatus(order.orderId, order.customerPubkey, 'settled');
          console.log('[Deposit] Customer deposit settled (forfeit) on cancelled:', order.orderId);
        }
      } else {
        await lnAdapter.cancelInvoice(entry.paymentHash);
        void publishDepositStatus(order.orderId, order.customerPubkey, 'cancelled');
        console.log('[Deposit] Customer deposit cancelled (refund) on cancelled:', order.orderId);
      }
    }
  } catch (err) {
    console.error('[Deposit] Customer deposit lifecycle failed for', order.orderId, err);
  }
}

async function handleSponsorDeposit(
  order: Order,
  newState: OrderState,
  lnAdapter: LightningAdapter,
): Promise<void> {
  const depositKey = `deposit:sponsor:${order.orderId}`;
  const entry = getEscrowEntry(depositKey);
  if (!entry) return;

  try {
    const status = await lnAdapter.lookupHoldInvoice(entry.paymentHash);
    if (status !== 'accepted') return;

    if (newState === 'paid' || newState === 'sponsor_wins') {
      // 정상 완료 또는 스폰서 승리 → 보증금 환불
      await lnAdapter.cancelInvoice(entry.paymentHash);
      if (order.sponsorPubkey) {
        void publishDepositStatus(order.orderId, order.sponsorPubkey, 'cancelled');
      }
      console.log('[Deposit] Sponsor deposit cancelled (refund) on', newState + ':', order.orderId);
    } else if (newState === 'customer_wins') {
      // 고객 승리 (스폰서 트롤링 판정) → 보증금 몰수
      const preimage = getPreimage(depositKey);
      if (preimage) {
        await lnAdapter.settleInvoice(preimage);
        if (order.sponsorPubkey) {
          void publishDepositStatus(order.orderId, order.sponsorPubkey, 'settled');
        }
        console.log('[Deposit] Sponsor deposit settled (forfeit) on customer_wins:', order.orderId);
      }
    }
    // verified, escrowed, cancelled 등: 어드민 수동 판단 (OrderDetail에서 settle/cancel)
  } catch (err) {
    console.error('[Deposit] Sponsor deposit lifecycle failed for', order.orderId, err);
  }
}
