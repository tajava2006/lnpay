/**
 * 라이트닝 거래의 동작들 — 요청 핸들러·워처·운영자 명령이 같은 함수를 부른다.
 *
 * 전부 **트랜잭션 안에서, 네트워크 없이** 돈다. 돈이 움직이는 일은 효과 의도로만 쌓는다(DM-002).
 * 효과의 결과를 전제로 한 전이(`verified`·종결 상태·`disbursed`)는 효과의 `onDone`이나 홀드 인보이스
 * 후속 처리(`createLnHoldHooks`)가 여기 함수를 불러서 한다(DM-003).
 *
 * 인보이스 한 장의 일생(만들기·관찰·정리)은 `../hold`가 맡는다 — 온체인 보증금과 같은 기계다.
 */
import {
  CLOSE_RULES, canTransition, computeEscrowSat, computePayoutSat, expiryReasonFor, type LnCloseReason,
} from '@sajwo-tracker/shared/ln';
import { isTerminalState } from '@sajwo-tracker/shared/core';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { loadSettings } from '../admin/settings';
import { isLiveHold, type HoldHooks, type HoldPurpose, type HoldRow } from '../hold';
import type { LnContext } from './context';
import { sendDepositRequired, sendDepositStatus } from './messages';
import { notifyDepositRequired, notifyLnTransition } from './notify';
import {
  deleteDraft, getDraft, getOrder, insertOrder, requestDetail, requestProjection, updateOrder, type LnDraftRow,
  type LnOrderRow,
} from './store';
import {
  CUSTOMER_DEPOSIT_MARGIN_SEC, CUSTOMER_DEPOSIT_PAY_SEC, DEADLINE_GRACE_SEC, ESCROW_HOLD_MARGIN_SEC,
  MIN_CLAIM_LEAD_SEC, MIN_ESCROW_PAY_WINDOW_SEC, SPONSOR_DEPOSIT_MARGIN_SEC, SPONSOR_DEPOSIT_PAY_SEC,
  cltvBlocksFor, escrowPayBy,
} from './timing';

export const LN_CLOSE_EFFECT = 'ln.close';
export const LN_PAYOUT_EFFECT = 'ln.payout';
export const LN_PROBE_EFFECT = 'ln.probe';

export interface OrderPayload { orderId: string }
export interface ProbePayload { orderId: string; bolt11: string }

/** 라이트닝 트랙의 홀드 목적 */
export const LN_HOLD_PURPOSES = ['ln-escrow', 'ln-customer-deposit', 'ln-sponsor-deposit'] as const satisfies readonly HoldPurpose[];
export type LnHoldPurpose = typeof LN_HOLD_PURPOSES[number];

/** 결제 기한까지 이보다 짧게 남으면 보증금 인보이스를 새로 만들지 않는다 */
const MIN_DEPOSIT_PAY_WINDOW_SEC = 5 * 60;

/** 라이트닝 홀드 인보이스를 계획한다 — CLTV는 `holdUntil`까지 */
function planLnHold(
  ctx: LnContext,
  p: { purpose: LnHoldPurpose; orderId: string; party: string; amountSat: number; payBy: number; holdUntil: number },
): HoldRow {
  return ctx.holds.plan({ ...p, cltvBlocks: cltvBlocksFor(p.holdUntil - nowSec(ctx)) });
}

// ── 홀드 인보이스 후속 처리 ─────────────────────────────────

/**
 * 라이트닝 목적의 홀드 인보이스가 바뀌었을 때 거래를 움직인다. 전부 `../hold`가 트랜잭션 안에서 부른다.
 */
export function createLnHoldHooks(ctx: LnContext): HoldHooks {
  return {
    created(inv) {
      switch (inv.purpose) {
        case 'ln-customer-deposit':
          if (getDraft(ctx, inv.order_id)) {
            sendDepositRequired(ctx, inv.order_id, inv.party, inv.bolt11, inv.pay_by, inv.payment_hash);
            notifyDepositRequired(ctx, inv.party, inv.order_id, 'customer', inv.payment_hash);
          } else {
            ctx.holds.dispose(inv.payment_hash, 'cancel');
          }
          return;
        case 'ln-sponsor-deposit': {
          const order = getOrder(ctx, inv.order_id);
          if (order && order.state === 'claimed' && order.sponsor === inv.party && !order.pending_close) {
            sendDepositRequired(ctx, inv.order_id, inv.party, inv.bolt11, inv.pay_by, inv.payment_hash);
            notifyDepositRequired(ctx, inv.party, inv.order_id, 'sponsor', inv.payment_hash);
            // 공개 오더의 "보증금 대기"를 다시 싣는다 — 클레임 뒤에 비율을 올렸으면 클레임 때는 없었다
            requestProjection(ctx, order.order_id);
          } else {
            ctx.holds.dispose(inv.payment_hash, 'cancel');
          }
          return;
        }
        case 'ln-escrow': {
          const order = getOrder(ctx, inv.order_id);
          if (order && order.state === 'claimed' && order.escrow_hash === inv.payment_hash && !order.pending_close) {
            const verified = updateOrder(ctx, order.order_id, { state: 'verified', escrow_bolt11: inv.bolt11 });
            notifyLnTransition(ctx, verified);
          } else {
            ctx.holds.dispose(inv.payment_hash, 'cancel');
          }
          return;
        }
      }
    },

    // 결제 기한 안에 노드가 인보이스를 못 만들었다(노드가 오래 꺼져 있었다)
    createFailed(inv) {
      const order = getOrder(ctx, inv.order_id);
      switch (inv.purpose) {
        case 'ln-customer-deposit':
          deleteDraft(ctx, inv.order_id);
          return;
        case 'ln-sponsor-deposit':
          // 후원자 탓이 아니다 — 클레임을 풀어 다른 후원자(또는 같은 후원자)가 다시 잡게
          if (order?.state === 'claimed' && order.sponsor === inv.party && !order.pending_close) revertClaim(ctx, order);
          return;
        case 'ln-escrow':
          // 승인을 되돌린다 — 자동 승인이 켜져 있으면 다음 틱에 다시 시도한다
          if (order?.state === 'claimed' && order.escrow_hash === inv.payment_hash) {
            updateOrder(ctx, order.order_id, { escrow_hash: null, payout_sat: null });
          }
          return;
      }
    },

    accepted(inv) {
      if (inv.purpose === 'ln-customer-deposit') onCustomerDepositAccepted(ctx, inv);
      else if (inv.purpose === 'ln-sponsor-deposit') onSponsorDepositAccepted(ctx, inv);
      else onEscrowAccepted(ctx, inv);
    },

    // 노드가 스스로 취소했다 — 결제 기한 만료, 또는 HTLC 만기 직전의 자동 취소
    nodeCancelled(before) {
      const order = getOrder(ctx, before.order_id);
      if (before.purpose === 'ln-customer-deposit') {
        if (getDraft(ctx, before.order_id)) deleteDraft(ctx, before.order_id);
        sendDepositStatus(ctx, before.order_id, before.party, 'cancelled', before.payment_hash);
        return;
      }
      if (before.purpose === 'ln-sponsor-deposit') {
        sendDepositStatus(ctx, before.order_id, before.party, 'cancelled', before.payment_hash);
        if (order?.state === 'claimed' && order.sponsor === before.party && !order.sponsor_deposit_hash && !order.pending_close) {
          revertClaim(ctx, order);
        }
        return;
      }
      // 에스크로
      if (!order || order.escrow_hash !== before.payment_hash || order.pending_close) return;
      if (order.state === 'verified') {
        beginClose(ctx, order, 'cancel:unpaid-escrow');
        return;
      }
      if (before.status === 'accepted') {
        // 잡혀 있던 에스크로를 노드가 만기로 돌려줬다 — 여기까지 오면 안 된다(기한·선제 settle이 먼저)
        raiseAlert(ctx, {
          dedup: `ln:${order.order_id}:escrow-timed-out`, level: 'anomaly', track: 'ln', orderId: order.order_id,
          message: `에스크로 HTLC가 만기로 고객에게 돌아갔다(${order.state}) — 후원자 송금 여부를 확인해야 한다`,
        });
        const reason = expiryReasonFor(order.state, order.sponsor !== null);
        if (reason) beginClose(ctx, order, reason);
      }
    },

    /** 정리가 끝났다 — 보증금이면 당사자에게 알린다(유저가 본 적 없는 건 알릴 게 없다) */
    disposed(before, final, via) {
      if (before.purpose !== 'ln-escrow') {
        if (before.status === 'open' || before.status === 'accepted') {
          sendDepositStatus(ctx, before.order_id, before.party, final, before.payment_hash);
        }
        return;
      }
      const order = getOrder(ctx, before.order_id);
      if (final === 'settled' && order && !order.escrow_settled) updateOrder(ctx, order.order_id, { escrow_settled: 1 });
      // 에스크로를 따로 settle하는 건 선제 settle(§7 L-3)뿐이다 — 판정은 아직이라 사람이 봐야 한다
      if (via !== 'settle') return;
      const orderId = before.order_id;
      raiseAlert(ctx, final === 'settled'
        ? {
            dedup: `ln:${orderId}:safety-settled`, level: 'warn', track: 'ln', orderId,
            message: '에스크로 만기가 가까워 먼저 정산했다 — 분쟁 판정이 필요하다',
          }
        : {
            dedup: `ln:${orderId}:safety-settle-missed`, level: 'anomaly', track: 'ln', orderId,
            message: '선제 정산 전에 에스크로가 취소됐다 — 고객에게 환불됐다. 후원자 송금 여부를 확인해야 한다',
          });
    },

    changed(orderId) {
      if (getOrder(ctx, orderId)) requestDetail(ctx, orderId);
    },

    // 닫기 효과가 돌고 있으면 그쪽이 이 오더의 인보이스 결과를 적는다
    busy(inv) {
      return ctx.db.get(
        `SELECT 1 FROM effects WHERE status = 'pending' AND dedup = ?`, `ln.close:${inv.order_id}`,
      ) !== undefined;
    },
  };
}

// ── 의뢰 (고객 보증금) ──────────────────────────────────────

/**
 * 고객 보증금 인보이스를 계획한다. 시세가 없으면 false — 워처가 다음 틱에 다시 부른다.
 * 기한이 너무 가까워 낼 틈이 없으면 의뢰를 버린다.
 */
export function planCustomerDeposit(ctx: LnContext, draft: LnDraftRow, pct: number): boolean {
  const btc = ctx.price();
  if (!btc) return false;
  const now = nowSec(ctx);
  const payBy = Math.min(now + CUSTOMER_DEPOSIT_PAY_SEC, draft.deadline - MIN_CLAIM_LEAD_SEC);
  if (payBy - now < MIN_DEPOSIT_PAY_WINDOW_SEC) {
    deleteDraft(ctx, draft.order_id);
    return true;
  }
  const amountSat = Math.max(1, Math.round((draft.price / btc) * 1e8 * pct / 100));
  planLnHold(ctx, {
    purpose: 'ln-customer-deposit', orderId: draft.order_id, party: draft.customer, amountSat,
    payBy, holdUntil: draft.deadline + CUSTOMER_DEPOSIT_MARGIN_SEC,
  });
  return true;
}

/** 고객 보증금이 들어왔다 → 오더가 생긴다 */
function onCustomerDepositAccepted(ctx: LnContext, inv: HoldRow): void {
  const draft = getDraft(ctx, inv.order_id);
  if (!draft || draft.customer !== inv.party || getOrder(ctx, inv.order_id)) {
    // 의뢰가 이미 버려졌다(기한 넘김 직전 결제) — 돌려준다
    ctx.holds.dispose(inv.payment_hash, 'cancel');
    return;
  }
  deleteDraft(ctx, draft.order_id);
  insertOrder(ctx, {
    orderId: draft.order_id, customer: draft.customer, price: draft.price, deadline: draft.deadline,
    customerDepositHash: inv.payment_hash,
  });
  sendDepositStatus(ctx, inv.order_id, inv.party, 'accepted', inv.payment_hash);
}

// ── 클레임 (후원자 보증금) ──────────────────────────────────

/** 후원자 보증금 인보이스를 계획한다. 시세가 없으면 false */
export function planSponsorDeposit(ctx: LnContext, order: LnOrderRow, pct: number): boolean {
  if (!order.sponsor) return false;
  const btc = ctx.price();
  const basis = btc ? computePayoutSat(order.price, btc) : null;
  if (!basis) return false;
  const now = nowSec(ctx);
  planLnHold(ctx, {
    purpose: 'ln-sponsor-deposit', orderId: order.order_id, party: order.sponsor,
    amountSat: Math.max(1, Math.round(basis * pct / 100)),
    payBy: now + SPONSOR_DEPOSIT_PAY_SEC,
    holdUntil: order.deadline + SPONSOR_DEPOSIT_MARGIN_SEC,
  });
  return true;
}

function onSponsorDepositAccepted(ctx: LnContext, inv: HoldRow): void {
  const order = getOrder(ctx, inv.order_id);
  if (!order || order.state !== 'claimed' || order.sponsor !== inv.party || order.pending_close) {
    // 그 사이 클레임이 풀렸다 — 돌려준다
    ctx.holds.dispose(inv.payment_hash, 'cancel');
    return;
  }
  updateOrder(ctx, order.order_id, { sponsor_deposit_hash: inv.payment_hash });
  sendDepositStatus(ctx, inv.order_id, inv.party, 'accepted', inv.payment_hash);
}

/**
 * 클레임을 푼다 (`claimed → requested`). 후원자 보증금과 만들던 에스크로는 돌려준다 — 푸는 사유가
 * 후원자 탓이어도(보증금 미납) 낸 게 없으니 돌려줄 것도 없고, 운영자가 푸는 건 몰수 판단이 아니다.
 */
export function revertClaim(ctx: LnContext, order: LnOrderRow): LnOrderRow {
  for (const inv of ctx.holds.of(order.order_id, LN_HOLD_PURPOSES)) {
    if (!isLiveHold(inv)) continue;
    if (inv.purpose === 'ln-escrow' || (inv.purpose === 'ln-sponsor-deposit' && inv.party === order.sponsor)) {
      ctx.holds.dispose(inv.payment_hash, 'cancel');
    }
  }
  return updateOrder(ctx, order.order_id, {
    state: 'requested', sponsor: null, claimed_at: null, payout_sat: null, escrow_hash: null,
    sponsor_deposit_hash: null,
  });
}

// ── 승인 ────────────────────────────────────────────────────

export type ApproveError =
  | 'not-claimed' | 'closing' | 'in-progress' | 'deposit-unpaid' | 'too-late' | 'no-price';

/** 지금 승인할 수 있는가 (시세 빼고) */
export function approveBlocker(ctx: LnContext, order: LnOrderRow): ApproveError | null {
  if (order.state !== 'claimed' || !order.sponsor) return 'not-claimed';
  if (order.pending_close) return 'closing';
  if (order.escrow_hash) return 'in-progress';
  if (loadSettings(ctx.db).ln.sponsorDepositPct > 0 && !order.sponsor_deposit_hash) return 'deposit-unpaid';
  const now = nowSec(ctx);
  if (escrowPayBy(order.deadline, now) - now < MIN_ESCROW_PAY_WINDOW_SEC) return 'too-late';
  return null;
}

/**
 * 클레임을 승인한다 — **금액이 정해지는 유일한 지점**이다. 후원자가 받을 payout을 지금 시세로 정하고
 * 고객이 낼 에스크로를 거기서 파생한다. 상태는 에스크로 인보이스가 실제로 생긴 뒤 `verified`가 된다.
 */
export function approve(ctx: LnContext, order: LnOrderRow): ApproveError | null {
  const blocker = approveBlocker(ctx, order);
  if (blocker) return blocker;
  const btc = ctx.price();
  const payoutSat = btc ? computePayoutSat(order.price, btc) : null;
  if (!payoutSat) return 'no-price';

  const now = nowSec(ctx);
  const payBy = escrowPayBy(order.deadline, now);
  // HTLC는 기한 + 유예까지 거래가 이어질 수 있게, 그 뒤로 분쟁 여유를 더 산다(L-3)
  const holdUntil = Math.max(payBy, order.deadline + DEADLINE_GRACE_SEC) + ESCROW_HOLD_MARGIN_SEC;
  const inv = planLnHold(ctx, {
    purpose: 'ln-escrow', orderId: order.order_id, party: order.customer,
    amountSat: computeEscrowSat(payoutSat), payBy, holdUntil,
  });
  updateOrder(ctx, order.order_id, { payout_sat: payoutSat, escrow_hash: inv.payment_hash });
  ctx.log.info('승인 — 에스크로 인보이스 생성 중', { orderId: order.order_id, payoutSat });
  return null;
}

/** 에스크로가 잡혔다 (`verified → escrowed`). 고객 보증금은 여기서 돌려준다 — 실결제가 담보를 대신한다 */
function onEscrowAccepted(ctx: LnContext, inv: HoldRow): void {
  const order = getOrder(ctx, inv.order_id);
  if (!order || order.escrow_hash !== inv.payment_hash) {
    ctx.holds.dispose(inv.payment_hash, 'cancel');
    return;
  }
  if (order.pending_close || isTerminalState(order.state)) return; // 닫는 효과가 처리한다
  if (order.state !== 'verified') return;

  const escrowed = updateOrder(ctx, order.order_id, { state: 'escrowed' });
  notifyLnTransition(ctx, escrowed);
  if (order.customer_deposit_hash) {
    const dep = ctx.holds.get(order.customer_deposit_hash);
    if (dep && (dep.status === 'open' || dep.status === 'accepted')) ctx.holds.dispose(dep.payment_hash, 'cancel');
  }
}

// ── 닫기 ────────────────────────────────────────────────────

/**
 * 거래를 닫기 시작한다. **사유가 곧 처리다**(`CLOSE_RULES`) — 에스크로·보증금을 정리하는 효과를 쌓고,
 * 종결 상태는 그 효과가 끝난 뒤에 발행된다(DM-003: settle 성공 → `paid`).
 *
 * 이미 닫는 중이거나 끝났으면 false. 닫는 동안 오는 요청은 전부 무시된다(`pending_close`).
 */
export function beginClose(ctx: LnContext, order: LnOrderRow, reason: LnCloseReason): boolean {
  if (order.pending_close || isTerminalState(order.state)) return false;
  if (!canTransition(order.state, CLOSE_RULES[reason].terminal)) {
    throw new Error(`닫을 수 없는 전이: ${order.state} → ${CLOSE_RULES[reason].terminal} (${reason})`);
  }
  updateOrder(ctx, order.order_id, { pending_close: reason });
  ctx.effects.enqueue<OrderPayload>(LN_CLOSE_EFFECT, { orderId: order.order_id }, { dedup: `ln.close:${order.order_id}` });
  ctx.log.info('닫기 시작', { orderId: order.order_id, reason });
  return true;
}

/** `ln.close`의 결과를 적는다 — 인보이스 상태, 종결 전이, 알림, 지급 */
export function finishClose(ctx: LnContext, orderId: string, finals: Record<string, 'settled' | 'cancelled'>): void {
  const order = getOrder(ctx, orderId);
  if (!order || !order.pending_close) return;
  const reason = order.pending_close as LnCloseReason;
  const rule = CLOSE_RULES[reason];

  for (const [hash, final] of Object.entries(finals)) ctx.holds.recordDisposal(hash, final, 'batch');

  const escrowFinal = order.escrow_hash ? finals[order.escrow_hash] : undefined;
  if (rule.escrow === 'cancel' && escrowFinal === 'settled') {
    // 선제 settle 뒤 고객 승 등 — BTC는 우리에게 있다. 고객 환불은 손으로 (§7 L-7)
    raiseAlert(ctx, {
      dedup: `ln:${orderId}:refund-manually`, level: 'anomaly', track: 'ln', orderId,
      message: '에스크로가 이미 정산돼 있어 자동 환불이 안 된다 — 고객에게 손으로 환불해야 한다',
    });
  }

  const closed = updateOrder(ctx, orderId, { state: rule.terminal, close_reason: reason, pending_close: null });
  notifyLnTransition(ctx, closed);
  ctx.log.info('닫힘', { orderId, reason, state: rule.terminal });
  if (rule.terminal === 'paid' || rule.terminal === 'sponsor_wins') requestPayout(ctx, orderId);
}

/** 닫기를 포기했다(에스크로를 받을 수 없는데 지급 사유) — 사람에게 넘긴다 */
export function abandonClose(ctx: LnContext, orderId: string, error: string): void {
  const order = getOrder(ctx, orderId);
  if (!order?.pending_close) return;
  raiseAlert(ctx, {
    dedup: `ln:${orderId}:close-failed:${order.version}`, level: 'anomaly', track: 'ln', orderId,
    message: `거래를 닫지 못했다(${order.pending_close}): ${error} — 판정·강제 종결로 직접 끝내야 한다`,
  });
  updateOrder(ctx, orderId, { pending_close: null });
}

// ── 지급 ────────────────────────────────────────────────────

export function requestPayout(ctx: LnContext, orderId: string): void {
  const dedup = `ln.payout:${orderId}`;
  if (!ctx.effects.enqueue<OrderPayload>(LN_PAYOUT_EFFECT, { orderId }, { dedup })) ctx.effects.expedite(dedup);
}

/** 이 사람의 지금 보증금 인보이스 (있으면) */
export function sponsorDepositOf(ctx: LnContext, order: LnOrderRow): HoldRow | undefined {
  return order.sponsor ? ctx.holds.current('ln-sponsor-deposit', order.order_id, order.sponsor) : undefined;
}
