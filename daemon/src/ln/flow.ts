/**
 * 라이트닝 거래의 동작들 — 요청 핸들러·워처·운영자 명령이 같은 함수를 부른다.
 *
 * 전부 **트랜잭션 안에서, 네트워크 없이** 돈다. 돈이 움직이는 일은 효과 의도로만 쌓는다(DM-002).
 * 효과의 결과를 전제로 한 전이(`verified`·종결 상태·`disbursed`)는 효과의 `onDone`이 여기 함수를
 * 불러서 한다(DM-003).
 *
 * ── 인보이스 한 장의 일생
 *
 * ```
 * planHold ─ creating ─(ln.hold.create)→ open ─(워처: 결제됨)→ accepted ─(ln.hold.dispose|ln.close)→ settled/cancelled
 *                 └──────────────────────────(기한 넘김·주문 닫힘)──────────────→ cancelled
 * ```
 */
import {
  CLOSE_RULES, canTransition, computeEscrowSat, computePayoutSat, type LnCloseReason,
} from '@sajwo-tracker/shared/ln';
import { isTerminalState } from '@sajwo-tracker/shared/core';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { loadSettings } from '../admin/settings';
import { derivePreimage, paymentHashOf, preimageScope } from '../derive';
import type { LnContext } from './context';
import { sendDepositRequired, sendDepositStatus } from './messages';
import { notifyLnTransition } from './notify';
import {
  currentInvoice, deleteDraft, getDraft, getInvoice, getOrder, insertOrder, invoicesOf, nextAttempt,
  setInvoice, updateOrder, type LnDraftRow, type LnInvoicePurpose, type LnInvoiceRow, type LnOrderRow,
} from './store';
import {
  CUSTOMER_DEPOSIT_MARGIN_SEC, CUSTOMER_DEPOSIT_PAY_SEC, DEADLINE_GRACE_SEC, ESCROW_HOLD_MARGIN_SEC,
  MIN_CLAIM_LEAD_SEC, MIN_ESCROW_PAY_WINDOW_SEC, SPONSOR_DEPOSIT_MARGIN_SEC, SPONSOR_DEPOSIT_PAY_SEC,
  cltvBlocksFor, escrowPayBy,
} from './timing';

export const LN_HOLD_CREATE_EFFECT = 'ln.hold.create';
export const LN_HOLD_DISPOSE_EFFECT = 'ln.hold.dispose';
export const LN_CLOSE_EFFECT = 'ln.close';
export const LN_PAYOUT_EFFECT = 'ln.payout';
export const LN_PROBE_EFFECT = 'ln.probe';

export interface HoldCreatePayload { paymentHash: string }
export interface HoldDisposePayload { paymentHash: string; action: 'settle' | 'cancel' }
export interface OrderPayload { orderId: string }
export interface ProbePayload { orderId: string; bolt11: string }

/** 결제 기한까지 이보다 짧게 남으면 보증금 인보이스를 새로 만들지 않는다 */
const MIN_DEPOSIT_PAY_WINDOW_SEC = 5 * 60;

// ── 프리이미지 ──────────────────────────────────────────────

function scopeOf(purpose: LnInvoicePurpose, orderId: string, party: string): string {
  // 후원자 보증금만 사람을 넣는다 — 한 주문에 클레임했다 풀린 후원자가 여럿일 수 있다
  return preimageScope(purpose, orderId, purpose === 'ln-sponsor-deposit' ? party : undefined);
}

/** 시드에서 다시 만든다(DM-005). 해시가 안 맞으면 파생 규칙이 틀어진 것 — 던진다 */
export function preimageOf(ctx: LnContext, inv: LnInvoiceRow): string {
  const preimage = derivePreimage(ctx.seed, scopeOf(inv.purpose, inv.order_id, inv.party), inv.attempt);
  if (paymentHashOf(preimage) !== inv.payment_hash) {
    throw new Error(`프리이미지가 해시와 맞지 않는다: ${inv.payment_hash}`);
  }
  return Buffer.from(preimage).toString('hex');
}

// ── 인보이스 ────────────────────────────────────────────────

/**
 * 홀드 인보이스를 **계획**한다 — 해시가 시드에서 미리 정해지므로 행을 먼저 쓰고, 노드 호출은 효과가 한다.
 *
 * @param holdUntil HTLC가 살아 있어야 하는 시각 (CLTV가 여기서 나온다)
 */
export function planHold(
  ctx: LnContext,
  p: { purpose: LnInvoicePurpose; orderId: string; party: string; amountSat: number; payBy: number; holdUntil: number },
): LnInvoiceRow {
  const now = nowSec(ctx);
  const attempt = nextAttempt(ctx, p.purpose, p.orderId, p.party);
  const hash = paymentHashOf(derivePreimage(ctx.seed, scopeOf(p.purpose, p.orderId, p.party), attempt));
  ctx.db.run(
    `INSERT INTO ln_invoices (payment_hash, purpose, order_id, party, attempt, amount_sat, bolt11, pay_by,
       cltv_blocks, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 'creating', ?, ?)`,
    hash, p.purpose, p.orderId, p.party, attempt, p.amountSat, p.payBy, cltvBlocksFor(p.holdUntil - now), now, now,
  );
  ctx.effects.enqueue<HoldCreatePayload>(LN_HOLD_CREATE_EFFECT, { paymentHash: hash }, { dedup: `ln.hold:${hash}` });
  return getInvoice(ctx, hash)!;
}

/** 인보이스를 정리한다 — settle(받기) 또는 cancel(돌려주기). 결과는 `afterDisposal`이 받는다 */
export function disposeInvoice(ctx: LnContext, paymentHash: string, action: 'settle' | 'cancel'): void {
  ctx.effects.enqueue<HoldDisposePayload>(LN_HOLD_DISPOSE_EFFECT, { paymentHash, action }, { dedup: `ln.dispose:${paymentHash}` });
}

/** 노드가 인보이스를 만들었다 (`ln.hold.create`의 onDone) */
export function afterHoldCreated(ctx: LnContext, paymentHash: string, result: { bolt11?: string; tooLate?: boolean }): void {
  const inv = getInvoice(ctx, paymentHash);
  if (!inv || inv.status !== 'creating') return; // 그 사이 취소됐다 — 효과가 노드 쪽을 치웠다

  if (result.tooLate || !result.bolt11) {
    setInvoice(ctx, paymentHash, { status: 'cancelled' });
    holdCouldNotBeCreated(ctx, inv);
    return;
  }
  setInvoice(ctx, paymentHash, { status: 'open', bolt11: result.bolt11 });
  const created = getInvoice(ctx, paymentHash)!;

  switch (inv.purpose) {
    case 'ln-customer-deposit': {
      if (getDraft(ctx, inv.order_id)) {
        sendDepositRequired(ctx, inv.order_id, inv.party, created.bolt11, inv.pay_by, paymentHash);
      } else {
        disposeInvoice(ctx, paymentHash, 'cancel');
      }
      return;
    }
    case 'ln-sponsor-deposit': {
      const order = getOrder(ctx, inv.order_id);
      if (order && order.state === 'claimed' && order.sponsor === inv.party && !order.pending_close) {
        sendDepositRequired(ctx, inv.order_id, inv.party, created.bolt11, inv.pay_by, paymentHash);
      } else {
        disposeInvoice(ctx, paymentHash, 'cancel');
      }
      return;
    }
    case 'ln-escrow': {
      const order = getOrder(ctx, inv.order_id);
      if (order && order.state === 'claimed' && order.escrow_hash === paymentHash && !order.pending_close) {
        const verified = updateOrder(ctx, order.order_id, { state: 'verified', escrow_bolt11: created.bolt11 });
        notifyLnTransition(ctx, verified);
      } else {
        disposeInvoice(ctx, paymentHash, 'cancel');
      }
      return;
    }
  }
}

/** 결제 기한 안에 노드가 인보이스를 못 만들었다(노드가 오래 꺼져 있었다) */
function holdCouldNotBeCreated(ctx: LnContext, inv: LnInvoiceRow): void {
  ctx.log.warn('홀드 인보이스를 기한 안에 못 만들었다', { orderId: inv.order_id, purpose: inv.purpose });
  const order = getOrder(ctx, inv.order_id);
  switch (inv.purpose) {
    case 'ln-customer-deposit':
      deleteDraft(ctx, inv.order_id);
      return;
    case 'ln-sponsor-deposit':
      // 후원자 탓이 아니다 — 클레임을 풀어 다른 후원자(또는 같은 후원자)가 다시 잡게
      if (order?.state === 'claimed' && order.sponsor === inv.party && !order.pending_close) {
        revertClaim(ctx, order);
      }
      return;
    case 'ln-escrow':
      // 승인을 되돌린다 — 자동 승인이 켜져 있으면 다음 틱에 다시 시도한다
      if (order?.state === 'claimed' && order.escrow_hash === inv.payment_hash) {
        updateOrder(ctx, order.order_id, { escrow_hash: null, payout_sat: null });
      }
      return;
  }
}

/**
 * 인보이스 정리가 끝났다 (`ln.hold.dispose` 또는 `ln.close`가 부른다). 상태를 적고, 보증금이면 당사자에게
 * 알린다. `wasSeen` = 유저가 이 인보이스를 받은 적이 있다(아직 만들어지기 전에 취소된 건 알릴 것이 없다).
 */
export function afterDisposal(ctx: LnContext, inv: LnInvoiceRow, final: 'settled' | 'cancelled'): void {
  if (inv.status === final) return;
  const wasSeen = inv.status === 'open' || inv.status === 'accepted';
  setInvoice(ctx, inv.payment_hash, { status: final });

  if (inv.purpose === 'ln-escrow') {
    if (final === 'settled') {
      const order = getOrder(ctx, inv.order_id);
      if (order && !order.escrow_settled) updateOrder(ctx, order.order_id, { escrow_settled: 1 });
    }
    return;
  }
  if (wasSeen) sendDepositStatus(ctx, inv.order_id, inv.party, final, inv.payment_hash);
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
  planHold(ctx, {
    purpose: 'ln-customer-deposit', orderId: draft.order_id, party: draft.customer, amountSat,
    payBy, holdUntil: draft.deadline + CUSTOMER_DEPOSIT_MARGIN_SEC,
  });
  return true;
}

/** 고객 보증금이 들어왔다 → 오더가 생긴다 */
export function onCustomerDepositAccepted(ctx: LnContext, inv: LnInvoiceRow): void {
  const draft = getDraft(ctx, inv.order_id);
  if (!draft || draft.customer !== inv.party || getOrder(ctx, inv.order_id)) {
    // 의뢰가 이미 버려졌다(기한 넘김 직전 결제) — 돌려준다
    disposeInvoice(ctx, inv.payment_hash, 'cancel');
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
  planHold(ctx, {
    purpose: 'ln-sponsor-deposit', orderId: order.order_id, party: order.sponsor,
    amountSat: Math.max(1, Math.round(basis * pct / 100)),
    payBy: now + SPONSOR_DEPOSIT_PAY_SEC,
    holdUntil: order.deadline + SPONSOR_DEPOSIT_MARGIN_SEC,
  });
  return true;
}

export function onSponsorDepositAccepted(ctx: LnContext, inv: LnInvoiceRow): void {
  const order = getOrder(ctx, inv.order_id);
  if (!order || order.state !== 'claimed' || order.sponsor !== inv.party || order.pending_close) {
    // 그 사이 클레임이 풀렸다 — 돌려준다
    disposeInvoice(ctx, inv.payment_hash, 'cancel');
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
  for (const inv of invoicesOf(ctx, order.order_id)) {
    const live = inv.status === 'creating' || inv.status === 'open' || inv.status === 'accepted';
    if (!live) continue;
    if (inv.purpose === 'ln-escrow' || (inv.purpose === 'ln-sponsor-deposit' && inv.party === order.sponsor)) {
      disposeInvoice(ctx, inv.payment_hash, 'cancel');
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
  const inv = planHold(ctx, {
    purpose: 'ln-escrow', orderId: order.order_id, party: order.customer,
    amountSat: computeEscrowSat(payoutSat), payBy, holdUntil,
  });
  updateOrder(ctx, order.order_id, { payout_sat: payoutSat, escrow_hash: inv.payment_hash });
  ctx.log.info('승인 — 에스크로 인보이스 생성 중', { orderId: order.order_id, payoutSat });
  return null;
}

/** 에스크로가 잡혔다 (`verified → escrowed`). 고객 보증금은 여기서 돌려준다 — 실결제가 담보를 대신한다 */
export function onEscrowAccepted(ctx: LnContext, inv: LnInvoiceRow): void {
  const order = getOrder(ctx, inv.order_id);
  if (!order || order.escrow_hash !== inv.payment_hash) {
    disposeInvoice(ctx, inv.payment_hash, 'cancel');
    return;
  }
  if (order.pending_close || isTerminalState(order.state)) return; // 닫는 효과가 처리한다
  if (order.state !== 'verified') return;

  const escrowed = updateOrder(ctx, order.order_id, { state: 'escrowed' });
  notifyLnTransition(ctx, escrowed);
  if (order.customer_deposit_hash) {
    const dep = getInvoice(ctx, order.customer_deposit_hash);
    if (dep && (dep.status === 'open' || dep.status === 'accepted')) disposeInvoice(ctx, dep.payment_hash, 'cancel');
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

  for (const [hash, final] of Object.entries(finals)) {
    const inv = getInvoice(ctx, hash);
    if (inv) afterDisposal(ctx, inv, final);
  }

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
export function sponsorDepositOf(ctx: LnContext, order: LnOrderRow): LnInvoiceRow | undefined {
  return order.sponsor ? currentInvoice(ctx, 'ln-sponsor-deposit', order.order_id, order.sponsor) : undefined;
}
