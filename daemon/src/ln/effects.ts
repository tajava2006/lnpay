/**
 * 라이트닝 효과 실행기 — 노드를 부르는 곳은 여기와 `../hold`뿐이다
 *
 * 전부 **멱등**하다. 실행 도중이나 기록 직전에 죽으면 재시작 뒤 처음부터 다시 돈다:
 *
 * | 효과 | 멱등하게 만드는 법 |
 * |---|---|
 * | `ln.close` | 인보이스마다 먼저 조회: 이미 settled/cancelled면 그 결과를 적는다 (`hold.settleOrCancel`) |
 * | `ln.payout` | 먼저 결제를 추적: 이미 나갔으면 끝, 진행 중이면 기다린다 |
 * | `ln.order.publish` · `ln.detail` | 발행하는 순간의 DB로 만든다(주소형 이벤트라 최신 한 장만 남는다) |
 *
 * 지정 거래는 공개 오더 대신 **수신자별 암호문 스냅샷**(`DESIGNATED_ORDER_KIND`)으로 낸다 — 고객 · 지정 후원자 · 운영자에게만
 * 보인다(docs/LN-TRACK.md §7). 이것도 주소형이라 다시 내면 같은 자리를 덮는다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import {
  ADMIN_STATE_KIND, adminOrderDTag, nip44Encrypt, type AdminLnInvoice, type AdminLnOrderDetail,
} from '@sajwo-tracker/shared/core';
import {
  CLOSE_RULES, LN_PAYOUT_INVOICE_EXPIRED, LN_PAYOUT_MANUAL, isManualPayout, isPayoutAmountExact, lnOrderTags, lnRetention,
  type LnCloseReason,
} from '@sajwo-tracker/shared/ln';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import type { EffectExecutor } from '../effects';
import { isLiveHold } from '../hold';
import type { RelayTransport } from '../nostr/transport';
import { readBolt11 } from './bolt11';
import type { LnContext } from './context';
import {
  LN_HOLD_PURPOSES, abandonClose, finishClose, requestPayout, sponsorDepositRequired, type LnHoldPurpose, type OrderPayload,
  type ProbePayload,
} from './flow';
import { sendInvoiceRejected } from './messages';
import { notifyPayoutInvoiceExpired } from './notify';
import { getOrder, payoutExpiredAtKey, updateOrder, type LnOrderRow } from './store';
import { alertSkippedRecipients, orderEvents, publishAll, type OrderEvents } from '../orders/publish';

/** 지급 한 번에 기다리는 시간 */
const PAY_TIMEOUT_SEC = 60;

/** 결제가 진행 중이면 이만큼 뒤에 다시 본다 */
const IN_FLIGHT_RECHECK_MS = 30_000;

/** 운영자 상세의 보존 — 종결 뒤에도 분쟁 기록으로 한동안 */
const DETAIL_RETENTION_SEC = 30 * 24 * 60 * 60;

type Final = 'settled' | 'cancelled';

// ── 닫기 ────────────────────────────────────────────────────

/**
 * 사유(`CLOSE_RULES`)대로 에스크로·보증금을 정리한 뒤 종결 상태로 간다. 인보이스마다 조회부터 하므로
 * 몇 번을 다시 돌아도 같은 결과로 수렴한다.
 *
 * 지급 사유(`paid`·`sponsor_wins`)인데 에스크로를 받을 수 없으면(HTLC가 이미 취소됨) **포기하고 사람에게
 * 넘긴다** — 받지 않은 돈을 지급하는 경로를 만들지 않는다.
 */
export function createCloseExecutor(ctx: LnContext): EffectExecutor<OrderPayload> {
  return {
    async run({ orderId }) {
      const order = getOrder(ctx, orderId);
      if (!order?.pending_close) return { status: 'done', result: { finals: {} } };
      const rule = CLOSE_RULES[order.pending_close as LnCloseReason];
      const finals: Record<string, Final> = {};

      const holds = ctx.holds;
      const escrow = order.escrow_hash ? holds.get(order.escrow_hash) : undefined;
      if (rule.escrow === 'settle') {
        if (!escrow) return { status: 'dead', error: '에스크로가 없다' };
        const lookup = await ctx.node.lookupInvoice(escrow.payment_hash);
        if (lookup?.state !== 'accepted' && lookup?.state !== 'settled') {
          return { status: 'dead', error: `에스크로를 받을 수 없다 (${lookup?.state ?? '노드에 없음'})` };
        }
        finals[escrow.payment_hash] = await holds.settleOrCancel(escrow, 'settle', lookup);
      } else if (escrow) {
        finals[escrow.payment_hash] = await holds.settleOrCancel(escrow, 'cancel', await ctx.node.lookupInvoice(escrow.payment_hash));
      }

      for (const inv of holds.of(orderId, LN_HOLD_PURPOSES)) {
        if (inv.purpose === 'ln-escrow') {
          // 지금 에스크로가 아닌 옛 시도(승인 되돌림)가 살아 있으면 돌려준다
          if (inv.payment_hash !== order.escrow_hash && isLiveHold(inv)) {
            finals[inv.payment_hash] = await holds.settleOrCancel(inv, 'cancel', await ctx.node.lookupInvoice(inv.payment_hash));
          }
          continue;
        }
        if (!isLiveHold(inv)) continue;
        const disposition = inv.purpose === 'ln-customer-deposit' ? rule.customerDeposit
          : inv.party === order.sponsor ? rule.sponsorDeposit
          : 'refund'; // 클레임했다 풀린 옛 후원자 — 잘못이 가려진 적 없다
        const want = disposition === 'forfeit' ? 'settle' : 'cancel';
        finals[inv.payment_hash] = await holds.settleOrCancel(inv, want, await ctx.node.lookupInvoice(inv.payment_hash));
      }
      return { status: 'done', result: { finals } };
    },
    onDone({ orderId }, result) {
      finishClose(ctx, orderId, (result as { finals: Record<string, Final> }).finals);
    },
    onDead({ orderId }, error) {
      abandonClose(ctx, orderId, error);
    },
  };
}

// ── 지급 ────────────────────────────────────────────────────

/**
 * 후원자에게 지급. 실패하면 백오프로 계속 다시 한다 — 오래 실패하면 워처가 경보를 올린다.
 * 인보이스가 만료됐으면 후원자에게 재제출을 요청하고 멈춘다(재제출이 이 효과를 다시 쌓는다).
 */
export function createPayoutExecutor(ctx: LnContext): EffectExecutor<OrderPayload> {
  return {
    async run({ orderId }) {
      const order = getOrder(ctx, orderId);
      if (!order || order.disbursed) return { status: 'done', result: { outcome: 'skip' } };
      if (order.state !== 'paid' && order.state !== 'sponsor_wins') return { status: 'done', result: { outcome: 'skip' } };
      if (!order.sponsor_invoice || !order.payout_sat) return { status: 'dead', error: '지급처가 없다 — FSM 불변조건 위반' };

      const info = readBolt11(order.sponsor_invoice);
      if (!info) return { status: 'dead', error: '지급처 인보이스를 읽을 수 없다' };
      // 제출 때 봤지만 한 번 더 — 틀린 금액으로 나가면 되돌릴 수 없다
      if (!isPayoutAmountExact(order.payout_sat, info.amountSat)) {
        return { status: 'dead', error: `금액 불일치 ${info.amountSat} ≠ ${order.payout_sat}` };
      }

      const tracked = await ctx.node.trackPayment(info.paymentHash);
      if (tracked === 'succeeded') return { status: 'done', result: { outcome: 'paid' } };
      if (tracked === 'in-flight') return { status: 'retry', error: '결제 진행 중', delayMs: IN_FLIGHT_RECHECK_MS };
      // 운영자가 자동 지급을 멈췄다(`ln.manual-payout`). 바로 위에서 지금 인보이스가 성공도 진행 중도 아님을 봤다 — 여기서
      // 멈추면 데몬은 이 거래에 다시 결제하지 않으므로 운영자가 직접 결제해도 두 번 나가지 않는다. 기다리는 동안 명령이
      // 들어왔을 수 있어 새로 읽는다
      if (isManualPayout(getOrder(ctx, orderId)?.payout_error)) {
        return { status: 'done', result: { outcome: 'manual', bolt11: order.sponsor_invoice } };
      }
      if (info.expiresAt <= nowSec(ctx) + 30) {
        return { status: 'done', result: { outcome: 'expired', bolt11: order.sponsor_invoice } };
      }

      const feeLimitSat = Math.max(10, Math.ceil(order.payout_sat * 0.01));
      const paid = await ctx.node.payInvoice(order.sponsor_invoice, feeLimitSat, PAY_TIMEOUT_SEC);
      if (paid.status === 'succeeded') return { status: 'done', result: { outcome: 'paid' } };
      if (paid.status === 'in-flight') return { status: 'retry', error: '결제 진행 중', delayMs: IN_FLIGHT_RECHECK_MS };
      return { status: 'retry', error: paid.failureReason ?? '결제 실패' };
    },
    onDone({ orderId }, result) {
      const r = result as { outcome: 'paid' | 'expired' | 'manual' | 'skip'; bolt11?: string };
      const order = getOrder(ctx, orderId);
      if (!order || r.outcome === 'skip') return;
      if (r.outcome === 'paid') {
        updateOrder(ctx, orderId, { disbursed: 1, payout_error: null });
        ctx.log.info('지급 완료', { orderId });
        return;
      }
      // 아래 판정(멈춤 확인·만료)은 **방금 추적한 그 인보이스**에 대한 것이다. 그 사이 지급처가 바뀌었으면 판정을 버리고
      // 지금 인보이스로 다시 돌린다 — 지금은 요청·명령이 지급과 같은 틱에 겹치지 않아(`runtime.ts` tick: 디스패치 → 효과)
      // 일어나지 않지만, 그 순서에 기대지 않는다. 성공(위)은 어느 인보이스였든 돈이 나간 것이라 그대로 적는다
      if (order.sponsor_invoice !== r.bolt11) {
        requestPayout(ctx, orderId);
        return;
      }
      if (r.outcome === 'manual') {
        if (order.payout_error !== LN_PAYOUT_MANUAL) updateOrder(ctx, orderId, { payout_error: LN_PAYOUT_MANUAL });
        ctx.log.info('자동 지급 멈춤 확인 — 운영자 직접 처리', { orderId });
        return;
      }
      // 만료를 보는 사이 운영자가 멈추라고 했다 — 표시를 덮지 말고 한 번 더 돌려 멈춤을 확인시킨다
      if (isManualPayout(order.payout_error)) {
        requestPayout(ctx, orderId);
        return;
      }
      // 같은 인보이스로는 한 번만 — 운영자가 "다시"를 눌러도 또 만료로 끝난다. 재제출이 `payout_error`를 비운다
      if (order.payout_error === LN_PAYOUT_INVOICE_EXPIRED) return;
      updateOrder(ctx, orderId, { payout_error: LN_PAYOUT_INVOICE_EXPIRED });
      // 멈춘 시각 — 후원자가 오래 안 내면 워처가 사람을 부른다(`PAYOUT_INVOICE_WAIT_ALERT_SEC`)
      ctx.db.kvSet(payoutExpiredAtKey(orderId), String(nowSec(ctx)));
      if (order.sponsor) {
        sendInvoiceRejected(ctx, orderId, order.sponsor, 'EXPIRED_BEFORE_PAYOUT', order.payout_sat ?? 0, r.bolt11 ?? '');
        // 앱 안 통지만으론 모른다 — 후원자는 "거래 완료" 푸시를 받고 앱을 닫았다
        notifyPayoutInvoiceExpired(ctx, order, (r.bolt11 && readBolt11(r.bolt11)?.paymentHash) || (r.bolt11 ?? ''));
      }
    },
    onRetry({ orderId }, error) {
      const order = getOrder(ctx, orderId);
      // 멈춤 표시는 덮지 않는다 — 덮으면 다음 차례가 멈춤을 모르고 다시 결제한다
      if (!order || isManualPayout(order.payout_error)) return;
      if (order.payout_error !== error && error !== '결제 진행 중') updateOrder(ctx, orderId, { payout_error: error });
    },
    onDead({ orderId }, error) {
      const order = getOrder(ctx, orderId);
      if (!order) return;
      updateOrder(ctx, orderId, { payout_error: error });
      // 다시 하지 않는 실패(지급처 없음·금액 불일치 — 불변조건 위반)다. 효과 막힘 경보(`admin/stuck.ts`)는 대기 중인
      // 효과만 보므로 여기서 부르지 않으면 아무도 모른다
      raiseAlert(ctx, {
        dedup: `ln:${orderId}:payout-dead:${error}`, level: 'anomaly', track: 'ln', orderId,
        message: `후원자 지급을 포기했다: ${error} — 직접 확인하고 지급해야 한다`,
      });
    },
  };
}

// ── 프로빙 (알려만 준다) ────────────────────────────────────

export function createProbeExecutor(ctx: LnContext): EffectExecutor<ProbePayload> {
  return {
    maxAttempts: 3,
    async run({ bolt11 }) {
      return { status: 'done', result: { reach: await ctx.node.probe(bolt11) } };
    },
    onDone({ orderId, bolt11 }, result) {
      const reach = (result as { reach: string }).reach;
      const order = getOrder(ctx, orderId);
      if (reach !== 'unreachable' || !order?.sponsor || order.sponsor_invoice !== bolt11) return;
      sendInvoiceRejected(ctx, orderId, order.sponsor, 'LIQUIDITY_WARNING', order.payout_sat ?? 0, bolt11);
    },
  };
}

// ── 공개 오더 ───────────────────────────────────────

/**
 * 클레임은 됐는데 후원자 보증금을 아직 안 냈다 — 양쪽 화면이 "후원자 찾는 중 · 보증금 대기"로 그린다.
 * 살아 있는 보증금 인보이스가 있거나, 설정이 보증금을 요구하면(시세가 없어 아직 못 만들었을 때) 대기다.
 */
function sponsorDepositPending(ctx: LnContext, order: LnOrderRow): boolean {
  if (order.state !== 'claimed' || !order.sponsor || order.sponsor_deposit_hash) return false;
  const dep = ctx.holds.current('ln-sponsor-deposit', order.order_id, order.sponsor);
  if (dep && isLiveHold(dep)) return true;
  return sponsorDepositRequired(ctx, order);
}

/** 오더 이벤트 — 공개 거래는 한 장, 지정 거래는 수신자마다 한 장(`../orders/publish`) */
export function buildOrderEvents(ctx: LnContext, order: LnOrderRow, createdAt: number): OrderEvents {
  const retainUntil = lnRetention(order.state, order.deadline, createdAt);
  const tags = lnOrderTags({
    orderId: order.order_id,
    state: order.state,
    customerPubkey: order.customer,
    ...(order.sponsor ? { sponsorPubkey: order.sponsor } : {}),
    price: order.price,
    deadline: order.deadline,
    // verified 이후에만 싣는다 — claimed에서 만드는 중인 에스크로를 고객이 먼저 보지 않게
    ...(order.escrow_bolt11 ? { bolt11: order.escrow_bolt11 } : {}),
    ...(order.payout_sat && order.escrow_bolt11 ? { payoutSat: order.payout_sat } : {}),
    ...(order.sponsor_invoice ? { sponsorInvoice: order.sponsor_invoice } : {}),
    ...(order.disbursed ? { disbursed: true } : {}),
    ...(order.customer_deposit_hash ? { depositPaymentHash: order.customer_deposit_hash } : {}),
    ...(order.sponsor_deposit_hash ? { sponsorDepositPaymentHash: order.sponsor_deposit_hash } : {}),
    ...(sponsorDepositPending(ctx, order) ? { sponsorDepositPending: true } : {}),
    ...(order.close_reason ? { closeReason: order.close_reason } : {}),
    ...(order.invoice_deadline ? { invoiceDeadline: order.invoice_deadline } : {}),
    ...(order.designated_sponsor ? { designatedSponsor: order.designated_sponsor } : {}),
  }, ctx.tags.ln, retainUntil, ctx.appUrl);
  return orderEvents(ctx, {
    orderId: order.order_id, customer: order.customer, designatedSponsor: order.designated_sponsor,
    trackTag: ctx.tags.ln, tags, retainUntil, createdAt,
  });
}

export function createOrderPublishExecutor(ctx: LnContext, transport: RelayTransport): EffectExecutor<OrderPayload> {
  return {
    async run({ orderId }) {
      const order = getOrder(ctx, orderId);
      if (!order) return { status: 'done', result: {} };
      // 주소형은 created_at이 같으면 id가 작은 쪽이 남는다 — 단조 증가시킨다
      const createdAt = Math.max(nowSec(ctx), order.published_at + 1);
      if (lnRetention(order.state, order.deadline, createdAt) <= createdAt) {
        // 기한이 지난 의뢰 — 릴레이가 받지 않는다. 곧 워처가 닫고 종결을 다시 낸다
        return { status: 'done', result: {} };
      }
      const { events, skipped } = buildOrderEvents(ctx, order, createdAt);
      const error = await publishAll(transport, events);
      if (error) return { status: 'retry', error };
      return { status: 'done', result: { createdAt, skipped } };
    },
    onDone({ orderId }, result) {
      const { createdAt, skipped } = result as { createdAt?: number; skipped?: string[] };
      if (createdAt) ctx.db.run('UPDATE ln_orders SET published_at = ? WHERE order_id = ?', createdAt, orderId);
      if (skipped) alertSkippedRecipients(ctx, 'ln', orderId, skipped);
    },
  };
}

// ── 운영자 상세 (운영자별) ───────────────────────────

const PURPOSE_NAME: Record<LnHoldPurpose, AdminLnInvoice['purpose']> = {
  'ln-escrow': 'escrow',
  'ln-customer-deposit': 'customer-deposit',
  'ln-sponsor-deposit': 'sponsor-deposit',
};

export function buildLnDetail(ctx: LnContext, order: LnOrderRow, blockHeight?: number): AdminLnOrderDetail {
  return {
    v: 1,
    orderId: order.order_id,
    version: order.version,
    state: order.state,
    customer: order.customer,
    ...(order.sponsor ? { sponsor: order.sponsor } : {}),
    price: order.price,
    deadline: order.deadline,
    ...(order.payout_sat ? { payoutSat: order.payout_sat } : {}),
    escrowSettled: order.escrow_settled === 1,
    ...(order.sponsor_invoice ? { sponsorInvoice: order.sponsor_invoice } : {}),
    disbursed: order.disbursed === 1,
    ...(order.payout_error ? { payoutError: order.payout_error } : {}),
    ...(order.pending_close ? { pendingClose: order.pending_close } : {}),
    ...(order.close_reason ? { closeReason: order.close_reason } : {}),
    ...(order.claimed_at ? { claimedAt: order.claimed_at } : {}),
    ...(order.account_sent_at ? { accountSentAt: order.account_sent_at } : {}),
    ...(order.invoice_deadline ? { invoiceDeadline: order.invoice_deadline } : {}),
    ...(order.designated_sponsor ? { designatedSponsor: order.designated_sponsor } : {}),
    ...(order.account_commitment ? { accountCommitment: order.account_commitment } : {}),
    ...(order.remitted_at ? { remittedAt: order.remitted_at } : {}),
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    invoices: ctx.holds.of(order.order_id, LN_HOLD_PURPOSES).map(inv => ({
      purpose: PURPOSE_NAME[inv.purpose as LnHoldPurpose],
      party: inv.party,
      amountSat: inv.amount_sat,
      status: inv.status,
      payBy: inv.pay_by,
      ...(inv.htlc_expiry_height ? { htlcExpiryHeight: inv.htlc_expiry_height } : {}),
      paymentHash: inv.payment_hash,
    })),
    ...(blockHeight ? { blockHeight } : {}),
  };
}

export function createDetailExecutor(
  ctx: LnContext, transport: RelayTransport, blockHeight: () => number | undefined,
): EffectExecutor<OrderPayload> {
  return {
    async run({ orderId }) {
      const order = getOrder(ctx, orderId);
      if (!order) return { status: 'done', result: {} };
      const last = Number(ctx.db.kvGet(`ln.detail.at:${orderId}`) ?? 0);
      const createdAt = Math.max(nowSec(ctx), last + 1);
      const content = JSON.stringify(buildLnDetail(ctx, order, blockHeight()));
      for (const operator of ctx.operators) {
        const event = finalizeEvent({
          kind: ADMIN_STATE_KIND,
          created_at: createdAt,
          tags: [
            ['d', adminOrderDTag(ctx.tags.admin, 'ln', orderId, operator)],
            ['p', operator],
            ['t', ctx.tags.admin],
            ['expiration', String(createdAt + DETAIL_RETENTION_SEC)],
          ],
          content: nip44Encrypt(content, ctx.appKey.secretKey, operator),
        }, ctx.appKey.secretKey);
        const report = await transport.publish(event);
        if (report.accepted.length === 0) {
          return { status: 'retry', error: report.rejected.map(r => r.reason).join('; ') || '릴레이 없음' };
        }
      }
      return { status: 'done', result: { createdAt } };
    },
    onDone({ orderId }, result) {
      const createdAt = (result as { createdAt?: number }).createdAt;
      if (createdAt) ctx.db.kvSet(`ln.detail.at:${orderId}`, String(createdAt));
    },
  };
}

