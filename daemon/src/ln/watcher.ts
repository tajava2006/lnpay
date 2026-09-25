/**
 * 라이트닝 워처 — 틱마다 시계와 블록 높이를 본다 (PLAN-DAEMON §4.6)
 *
 * 인보이스 관찰(결제됨·노드가 취소함)은 `../hold`가 먼저 돌고 후속 처리를 `createLnHoldHooks`로 부른다.
 * 여기는 **시계**만 본다 — 한 트랜잭션에서 시각·블록 높이로 판단한다: 결제 기한, 쿠팡 기한(+유예),
 * 에스크로 만기, 자동 승인.
 *
 * 재시작하면 지난 기한을 한꺼번에 처리한다. 판단이 전부 "지금" 기준이라 처리 순서가 결과를 바꾸지 않는다.
 * 다만 **꺼져 있던 동안 쌓인 요청**(기한 안에 누른 송금 완료 등)을 먼저 받아야 하므로, 뜨고 나서
 * 잠깐(`CATCHUP_WARMUP_SEC`)은 기한 만료로 닫지 않는다.
 */
import { expiryReasonFor, type LnCloseReason } from '@sajwo-tracker/shared/ln';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { loadSettings } from '../admin/settings';
import type { LnContext } from './context';
import {
  approve, approveBlocker, beginClose, planCustomerDeposit, planSponsorDeposit, revertClaim, sponsorDepositOf,
} from './flow';
import { allDrafts, deleteDraft, insertOrder, ordersInStates, type LnOrderRow } from './store';
import {
  CATCHUP_WARMUP_SEC, CUSTOMER_DEPOSIT_PAY_SEC, DEADLINE_GRACE_SEC, ESCROW_END_BLOCKS, PAY_BY_SKEW_SEC,
  REMITTED_ALERT_SEC, SAFETY_SETTLE_BLOCKS,
} from './timing';

export class LnWatcher {
  constructor(private readonly ctx: LnContext) {}

  async poll(): Promise<void> {
    const { ctx } = this;
    let height: number | undefined;
    try {
      height = await ctx.node.blockHeight();
      ctx.db.kvSet('ln.height', String(height));
    } catch (e) {
      ctx.log.warn('블록 높이 조회 실패', { error: e instanceof Error ? e.message : String(e) });
    }
    ctx.db.tx(() => this.clock(height));
  }

  /** 시각·블록 높이로 판단한다 */
  clock(height: number | undefined): void {
    const { ctx } = this;
    const now = nowSec(ctx);
    const settings = loadSettings(ctx.db).ln;
    const warmedUp = now - ctx.startedAt >= CATCHUP_WARMUP_SEC;

    // ── 보증금을 기다리는 의뢰
    for (const draft of allDrafts(ctx)) {
      const dep = ctx.holds.current('ln-customer-deposit', draft.order_id, draft.customer);
      if (!dep) {
        if (now - draft.created_at > CUSTOMER_DEPOSIT_PAY_SEC) deleteDraft(ctx, draft.order_id);
        else if (settings.customerDepositPct > 0) planCustomerDeposit(ctx, draft, settings.customerDepositPct);
        else {
          // 시세를 기다리는 사이 운영자가 보증금을 껐다 — 보증금 없이 올린다
          deleteDraft(ctx, draft.order_id);
          insertOrder(ctx, { orderId: draft.order_id, customer: draft.customer, price: draft.price, deadline: draft.deadline });
        }
        continue;
      }
      if (dep.status === 'open' && now > dep.pay_by + PAY_BY_SKEW_SEC) {
        deleteDraft(ctx, draft.order_id);
        ctx.holds.dispose(dep.payment_hash, 'cancel');
      }
    }

    // ── 클레임: 후원자 보증금, 자동 승인
    for (const order of ordersInStates(ctx, ['claimed'])) {
      if (order.pending_close) continue;
      if (settings.sponsorDepositPct > 0 && !order.sponsor_deposit_hash) {
        const dep = sponsorDepositOf(ctx, order);
        if (!dep) {
          planSponsorDeposit(ctx, order, settings.sponsorDepositPct);
          continue;
        }
        if (dep.status === 'open' && now > dep.pay_by + PAY_BY_SKEW_SEC) {
          // 15분 안에 안 냈다 — 공짜 점유를 풀어 다른 후원자가 잡게
          revertClaim(ctx, order);
          continue;
        }
      }
      if (settings.autoApprove && approveBlocker(ctx, order) === null) approve(ctx, order);
    }

    // ── 에스크로 미납
    for (const order of ordersInStates(ctx, ['verified'])) {
      if (order.pending_close || !order.escrow_hash) continue;
      const escrow = ctx.holds.get(order.escrow_hash);
      if (escrow?.status === 'open' && now > escrow.pay_by + PAY_BY_SKEW_SEC) beginClose(ctx, order, 'cancel:unpaid-escrow');
    }

    // ── 쿠팡 기한 (L-2) · 에스크로 만기
    for (const order of ordersInStates(ctx, ['requested', 'claimed', 'verified', 'escrowed', 'invoiced'])) {
      if (order.pending_close) continue;
      const reason = expiryReasonFor(order.state, order.sponsor !== null, order.account_sent_at !== null);
      if (!reason) continue;
      if (warmedUp && now > this.closeAt(order)) {
        beginClose(ctx, order, reason);
        continue;
      }
      if (this.escrowEnding(order, height, ESCROW_END_BLOCKS)) this.closeForEscrowEnd(order, reason);
    }

    // ── 송금 완료 뒤: 선제 settle, 오래 멈춤
    for (const order of ordersInStates(ctx, ['remitted'])) {
      if (order.pending_close) continue;
      const escrow = order.escrow_hash ? ctx.holds.get(order.escrow_hash) : undefined;
      if (escrow?.status === 'accepted' && this.escrowEnding(order, height, SAFETY_SETTLE_BLOCKS)) {
        // 비대칭 손실 원칙 — 후원자는 이미 원화를 보냈다고 했다. HTLC가 죽기 전에 받아 둔다
        ctx.holds.dispose(escrow.payment_hash, 'settle');
      }
      if (order.remitted_at && now - order.remitted_at > REMITTED_ALERT_SEC) {
        raiseAlert(ctx, {
          dedup: `ln:${order.order_id}:remitted-stale`, level: 'warn', track: 'ln', orderId: order.order_id,
          message: '송금 완료 뒤 고객 확인이 오래 없다 — 분쟁 판정이 필요할 수 있다',
        });
      }
    }
  }

  /** 기한 만료로 닫는 시각 — 원화가 오갈 수 있는 상태만 유예를 준다 */
  private closeAt(order: LnOrderRow): number {
    return order.state === 'escrowed' || order.state === 'invoiced'
      ? order.deadline + DEADLINE_GRACE_SEC
      : order.deadline;
  }

  private escrowEnding(order: LnOrderRow, height: number | undefined, blocks: number): boolean {
    if (!height || !order.escrow_hash) return false;
    const escrow = this.ctx.holds.get(order.escrow_hash);
    return !!escrow?.htlc_expiry_height && escrow.htlc_expiry_height - height <= blocks;
  }

  private closeForEscrowEnd(order: LnOrderRow, reason: LnCloseReason): void {
    raiseAlert(this.ctx, {
      dedup: `ln:${order.order_id}:escrow-ending`, level: 'warn', track: 'ln', orderId: order.order_id,
      message: `기한 전에 에스크로 만기가 가까워 닫는다(${order.state}) — 블록이 예상보다 빨랐다`,
    });
    beginClose(this.ctx, order, reason);
  }
}
