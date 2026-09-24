/**
 * 라이트닝 워처 — 틱마다 노드와 시계를 본다 (PLAN-DAEMON §4.6)
 *
 * 둘로 나뉜다:
 *
 * 1. **관찰** — 살아 있는 인보이스를 노드에 묻는다(네트워크). 결과는 인보이스 한 장마다 짧은
 *    트랜잭션으로 적는다: 결제됨 → 다음 단계, 노드가 취소함(만료) → 그에 맞는 정리.
 * 2. **시계** — 한 트랜잭션에서 시각·블록 높이로 판단한다: 결제 기한, 쿠팡 기한(+유예), 에스크로 만기,
 *    자동 승인, 오래 걸리는 효과 경보.
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
  approve, approveBlocker, beginClose, disposeInvoice, onCustomerDepositAccepted, onEscrowAccepted,
  onSponsorDepositAccepted, planCustomerDeposit, planSponsorDeposit, revertClaim, sponsorDepositOf,
} from './flow';
import type { HoldLookup } from './lnd';
import { sendDepositStatus } from './messages';
import {
  allDrafts, currentInvoice, deleteDraft, getDraft, getInvoice, getOrder, insertOrder, liveInvoices,
  ordersInStates, setInvoice, type LnInvoiceRow, type LnOrderRow,
} from './store';
import {
  CATCHUP_WARMUP_SEC, CUSTOMER_DEPOSIT_PAY_SEC, DEADLINE_GRACE_SEC, ESCROW_END_BLOCKS, PAY_BY_SKEW_SEC,
  REMITTED_ALERT_SEC, SAFETY_SETTLE_BLOCKS, STUCK_EFFECT_ATTEMPTS,
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
      ctx.log.warn('블록 높이 조회 실패', { error: errorText(e) });
    }

    for (const inv of liveInvoices(ctx)) {
      let lookup: HoldLookup | null;
      try {
        lookup = await ctx.node.lookupInvoice(inv.payment_hash);
      } catch (e) {
        ctx.log.warn('인보이스 조회 실패', { orderId: inv.order_id, error: errorText(e) });
        continue;
      }
      ctx.db.tx(() => this.observe(inv.payment_hash, lookup));
    }

    ctx.db.tx(() => this.clock(height));
  }

  /** 노드가 본 인보이스 상태를 적고, 바뀐 만큼 거래를 움직인다 */
  observe(paymentHash: string, lookup: HoldLookup | null): void {
    const { ctx } = this;
    const inv = getInvoice(ctx, paymentHash);
    if (!inv || (inv.status !== 'open' && inv.status !== 'accepted')) return;
    // 정리 효과가 돌고 있으면 그쪽이 결과를 적는다 — 여기서 같이 적으면 "우리가 안 한 settle"로 오인한다
    if (this.disposing(inv)) return;

    if (!lookup) {
      raiseAlert(ctx, {
        dedup: `ln:invoice-missing:${paymentHash}`, level: 'anomaly', track: 'ln', orderId: inv.order_id,
        message: `노드에 인보이스가 없다(${inv.purpose}) — LND 데이터가 바뀌었는지 확인해야 한다`,
      });
      return;
    }
    if (lookup.htlcExpiryHeight && lookup.htlcExpiryHeight !== inv.htlc_expiry_height) {
      setInvoice(ctx, paymentHash, { htlc_expiry_height: lookup.htlcExpiryHeight });
    }

    if (lookup.state === 'accepted' && inv.status === 'open') {
      setInvoice(ctx, paymentHash, { status: 'accepted' });
      const accepted = getInvoice(ctx, paymentHash)!;
      if (inv.purpose === 'ln-customer-deposit') onCustomerDepositAccepted(ctx, accepted);
      else if (inv.purpose === 'ln-sponsor-deposit') onSponsorDepositAccepted(ctx, accepted);
      else onEscrowAccepted(ctx, accepted);
      return;
    }

    if (lookup.state === 'settled') {
      setInvoice(ctx, paymentHash, { status: 'settled' });
      raiseAlert(ctx, {
        dedup: `ln:unexpected-settle:${paymentHash}`, level: 'anomaly', track: 'ln', orderId: inv.order_id,
        message: `데몬이 하지 않은 settle(${inv.purpose}) — 프리이미지가 밖에 있는지 확인해야 한다`,
      });
      return;
    }

    if (lookup.state === 'cancelled') {
      setInvoice(ctx, paymentHash, { status: 'cancelled' });
      this.nodeCancelled(inv);
    }
  }

  /** 노드가 스스로 취소했다 — 결제 기한 만료, 또는 HTLC 만기 직전의 자동 취소 */
  private nodeCancelled(inv: LnInvoiceRow): void {
    const { ctx } = this;
    const order = getOrder(ctx, inv.order_id);

    if (inv.purpose === 'ln-customer-deposit') {
      if (getDraft(ctx, inv.order_id)) deleteDraft(ctx, inv.order_id);
      sendDepositStatus(ctx, inv.order_id, inv.party, 'cancelled', inv.payment_hash);
      return;
    }
    if (inv.purpose === 'ln-sponsor-deposit') {
      sendDepositStatus(ctx, inv.order_id, inv.party, 'cancelled', inv.payment_hash);
      if (order?.state === 'claimed' && order.sponsor === inv.party && !order.sponsor_deposit_hash && !order.pending_close) {
        revertClaim(ctx, order);
      }
      return;
    }

    // 에스크로
    if (!order || order.escrow_hash !== inv.payment_hash || order.pending_close) return;
    if (order.state === 'verified') {
      beginClose(ctx, order, 'cancel:unpaid-escrow');
      return;
    }
    if (inv.status === 'accepted') {
      // 잡혀 있던 에스크로를 노드가 만기로 돌려줬다 — 여기까지 오면 안 된다(기한·선제 settle이 먼저)
      raiseAlert(ctx, {
        dedup: `ln:${order.order_id}:escrow-timed-out`, level: 'anomaly', track: 'ln', orderId: order.order_id,
        message: `에스크로 HTLC가 만기로 고객에게 돌아갔다(${order.state}) — 후원자 송금 여부를 확인해야 한다`,
      });
      const reason = expiryReasonFor(order.state, order.sponsor !== null);
      if (reason) beginClose(ctx, order, reason);
    }
  }

  private disposing(inv: LnInvoiceRow): boolean {
    return this.ctx.db.get(
      `SELECT 1 FROM effects WHERE status = 'pending' AND dedup IN (?, ?)`,
      `ln.dispose:${inv.payment_hash}`, `ln.close:${inv.order_id}`,
    ) !== undefined;
  }

  /** 시각·블록 높이로 판단한다 */
  clock(height: number | undefined): void {
    const { ctx } = this;
    const now = nowSec(ctx);
    const settings = loadSettings(ctx.db).ln;
    const warmedUp = now - ctx.startedAt >= CATCHUP_WARMUP_SEC;

    // ── 보증금을 기다리는 의뢰
    for (const draft of allDrafts(ctx)) {
      const dep = currentInvoice(ctx, 'ln-customer-deposit', draft.order_id, draft.customer);
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
        disposeInvoice(ctx, dep.payment_hash, 'cancel');
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
      const escrow = getInvoice(ctx, order.escrow_hash);
      if (escrow?.status === 'open' && now > escrow.pay_by + PAY_BY_SKEW_SEC) beginClose(ctx, order, 'cancel:unpaid-escrow');
    }

    // ── 쿠팡 기한 (L-2) · 에스크로 만기
    for (const order of ordersInStates(ctx, ['requested', 'claimed', 'verified', 'escrowed', 'invoiced'])) {
      if (order.pending_close) continue;
      const reason = expiryReasonFor(order.state, order.sponsor !== null);
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
      const escrow = order.escrow_hash ? getInvoice(ctx, order.escrow_hash) : undefined;
      if (escrow?.status === 'accepted' && this.escrowEnding(order, height, SAFETY_SETTLE_BLOCKS)) {
        // 비대칭 손실 원칙 — 후원자는 이미 원화를 보냈다고 했다. HTLC가 죽기 전에 받아 둔다
        disposeInvoice(ctx, escrow.payment_hash, 'settle');
      }
      if (order.remitted_at && now - order.remitted_at > REMITTED_ALERT_SEC) {
        raiseAlert(ctx, {
          dedup: `ln:${order.order_id}:remitted-stale`, level: 'warn', track: 'ln', orderId: order.order_id,
          message: '송금 완료 뒤 고객 확인이 오래 없다 — 분쟁 판정이 필요할 수 있다',
        });
      }
    }

    this.stuckEffects();
  }

  /** 기한 만료로 닫는 시각 — 원화가 오갈 수 있는 상태만 유예를 준다 */
  private closeAt(order: LnOrderRow): number {
    return order.state === 'escrowed' || order.state === 'invoiced'
      ? order.deadline + DEADLINE_GRACE_SEC
      : order.deadline;
  }

  private escrowEnding(order: LnOrderRow, height: number | undefined, blocks: number): boolean {
    if (!height || !order.escrow_hash) return false;
    const escrow = getInvoice(this.ctx, order.escrow_hash);
    return !!escrow?.htlc_expiry_height && escrow.htlc_expiry_height - height <= blocks;
  }

  private closeForEscrowEnd(order: LnOrderRow, reason: LnCloseReason): void {
    raiseAlert(this.ctx, {
      dedup: `ln:${order.order_id}:escrow-ending`, level: 'warn', track: 'ln', orderId: order.order_id,
      message: `기한 전에 에스크로 만기가 가까워 닫는다(${order.state}) — 블록이 예상보다 빨랐다`,
    });
    beginClose(this.ctx, order, reason);
  }

  /** 오래 실패하는 효과 — 지급·settle이 막혔다(L-4). 효과마다 한 번 */
  private stuckEffects(): void {
    const { ctx } = this;
    const stuck = ctx.db.all<{ id: number; kind: string; attempts: number; last_error: string | null; payload: string }>(
      `SELECT id, kind, attempts, last_error, payload FROM effects
       WHERE status = 'pending' AND attempts >= ? AND kind LIKE 'ln.%'`,
      STUCK_EFFECT_ATTEMPTS,
    );
    for (const e of stuck) {
      const orderId = orderIdOfPayload(ctx, e.payload);
      raiseAlert(ctx, {
        dedup: `effect:${e.id}:stuck`, level: 'anomaly', track: 'ln', ...(orderId ? { orderId } : {}),
        message: `${e.kind}이(가) ${e.attempts}번 실패했다: ${e.last_error ?? '?'}`,
      });
    }
  }
}

function orderIdOfPayload(ctx: LnContext, payload: string): string | undefined {
  try {
    const p = JSON.parse(payload) as { orderId?: unknown; paymentHash?: unknown };
    if (typeof p.orderId === 'string') return p.orderId;
    if (typeof p.paymentHash === 'string') return getInvoice(ctx, p.paymentHash)?.order_id;
  } catch {
    // 모양이 다른 payload — 오더 없이 알린다
  }
  return undefined;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
