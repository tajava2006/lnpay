/**
 * 라이트닝 요청 핸들러 — 유저가 보낸 kind 1111 (PLAN-DAEMON §4.1 ②)
 *
 * **트랜잭션 안에서, 네트워크 없이** 판단한다(디스패처가 트랜잭션을 연다). 받지 않는 요청은
 * `ignored:<사유>`로 닫혀 inbox에 남는다 — "왜 안 됐지"를 나중에 DB에서 본다.
 *
 * 보낸 사람 확인이 첫 줄이다. kind 1111은 누구나 서명해 쏠 수 있다 — 남의 오더에 지급처를 꽂거나,
 * 남의 거래를 취소하거나, 남 대신 입금 확인을 누르는 걸 여기서 막는다.
 */
import {
  REQUEST_ACTIONS, extractOrderId, isTerminalState, nip44Decrypt,
} from '@sajwo-tracker/shared/core';
import { canTransition } from '@sajwo-tracker/shared/ln';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { loadSettings } from '../admin/settings';
import { tagValue, type Handler, type HandlerResult, type InboxEvent } from '../dispatch';
import { isOrderId } from '../orders/id';
import { PUSH_WELCOME } from './notify-messages';
import { isPushSubscriptionPayload, queuePush, saveSubscription } from '../push/send';
import { readBolt11 } from './bolt11';
import type { LnContext } from './context';
import {
  LN_PROBE_EFFECT, beginClose, planCustomerDeposit, planSponsorDeposit, requestPayout, type ProbePayload,
} from './flow';
import { sendInvoiceRejected } from './messages';
import { notifyAccountArrived, notifyLnTransition } from './notify';
import { deleteDraft, getDraft, getOrder, insertOrder, updateOrder, type LnOrderRow } from './store';
import {
  DEADLINE_GRACE_SEC, INVOICE_ESCROW_MIN_BLOCKS, MAX_DEADLINE_LEAD_SEC, MIN_CLAIM_LEAD_SEC,
  MIN_SPONSOR_INVOICE_LIFETIME_SEC,
} from './timing';

/** 지급 직전에 재제출하는 인보이스는 바로 쓰이므로 짧아도 된다 */
const MIN_REPLACEMENT_LIFETIME_SEC = 10 * 60;

/** 너무 큰 금액은 입력 사고다 (원) */
const MAX_PRICE_KRW = 100_000_000;

const HEX64 = /^[0-9a-f]{64}$/;

const ignored = (reason: string): HandlerResult => ({ outcome: 'ignored', reason });
const ok: HandlerResult = { outcome: 'ok' };

/** 마지막으로 본 블록 높이 — 워처가 틱마다 적는다. 핸들러는 노드를 부르지 않으므로 이걸 본다 */
export function knownHeight(ctx: Pick<LnContext, 'db'>): number | undefined {
  const h = Number(ctx.db.kvGet('ln.height') ?? 0);
  return h > 0 ? h : undefined;
}

type OrderHandler = (ctx: LnContext, event: InboxEvent, order: LnOrderRow) => HandlerResult;

/** 오더가 있어야 하는 요청의 공통 앞부분 */
function withOrder(ctx: LnContext, handler: OrderHandler): Handler {
  return event => {
    const orderId = extractOrderId(event.tags);
    if (!orderId) return ignored('no-order');
    const order = getOrder(ctx, orderId);
    if (!order) return ignored('unknown-order');
    return handler(ctx, event, order);
  };
}

// ── 의뢰 ────────────────────────────────────────────────────

function orderRequest(ctx: LnContext, event: InboxEvent): HandlerResult {
  const orderId = extractOrderId(event.tags);
  if (!isOrderId(orderId)) return ignored('bad-order-id');
  const price = Number(tagValue(event, 'price'));
  if (!Number.isInteger(price) || price <= 0 || price > MAX_PRICE_KRW) return ignored('bad-price');

  // 새 유저 앱은 `deadline`을 따로 싣는다. 옛 앱은 `expiration`이 곧 쿠팡 기한이었다(DM-009)
  const deadline = Number(tagValue(event, 'deadline') ?? tagValue(event, 'expiration'));
  if (!Number.isInteger(deadline)) return ignored('bad-deadline');
  const now = nowSec(ctx);
  if (deadline - now < MIN_CLAIM_LEAD_SEC) return ignored('deadline-too-close');
  if (deadline - now > MAX_DEADLINE_LEAD_SEC) return ignored('deadline-too-far');

  if (getOrder(ctx, orderId) || getDraft(ctx, orderId)) return ignored('duplicate');

  const pct = loadSettings(ctx.db).ln.customerDepositPct;
  if (pct === 0) {
    insertOrder(ctx, { orderId, customer: event.pubkey, price, deadline });
    return ok;
  }
  ctx.db.run(
    'INSERT INTO ln_drafts (order_id, customer, price, deadline, created_at) VALUES (?, ?, ?, ?, ?)',
    orderId, event.pubkey, price, deadline, now,
  );
  // 시세가 없으면 워처가 다음 틱에 다시 시도한다
  planCustomerDeposit(ctx, getDraft(ctx, orderId)!, pct);
  return ok;
}

// ── 클레임 ──────────────────────────────────────────────────

const claim: OrderHandler = (ctx, event, order) => {
  if (order.pending_close) return ignored('closing');
  if (!canTransition(order.state, 'claimed')) return ignored('bad-state');
  // 자기 주문 자기 클레임 — 한 앱·한 키라 UI도 막지만 진짜 방어는 여기다(내역의 역할 유도가 깨진다)
  if (event.pubkey === order.customer) return ignored('self-claim');
  // 기한이 코앞이면 결제·인보이스·계좌·송금이 들어갈 틈이 없다 — 받아봐야 후원자 시간만 쓴다
  if (order.deadline - nowSec(ctx) < MIN_CLAIM_LEAD_SEC) return ignored('deadline-too-close');

  const claimed = updateOrder(ctx, order.order_id, { state: 'claimed', sponsor: event.pubkey, claimed_at: nowSec(ctx) });
  const pct = loadSettings(ctx.db).ln.sponsorDepositPct;
  if (pct > 0) planSponsorDeposit(ctx, claimed, pct); // 시세가 없으면 워처가 다시
  return ok;
};

// ── 후원자 인보이스 (L-5: 지급 전까지 재제출) ───────────────

const sponsorInvoice: OrderHandler = (ctx, event, order) => {
  if (event.pubkey !== order.sponsor) return ignored('not-sponsor');
  if (order.pending_close) return ignored('closing');
  const bolt11 = tagValue(event, 'bolt11')?.trim();
  if (!bolt11) return ignored('no-bolt11');

  const payoutPending = (order.state === 'paid' || order.state === 'sponsor_wins') && !order.disbursed;
  const accepts = order.state === 'escrowed' || order.state === 'invoiced' || order.state === 'remitted' || payoutPending;
  if (!accepts) return ignored('bad-state');
  if (order.sponsor_invoice === bolt11) return ignored('same-invoice');

  const payout = order.payout_sat ?? 0;
  const reject = (reason: Parameters<typeof sendInvoiceRejected>[3]) => {
    sendInvoiceRejected(ctx, order.order_id, event.pubkey, reason, payout, event.id);
    return ignored(`rejected:${reason}`);
  };

  const info = readBolt11(bolt11);
  if (!info) return reject('DECODE_FAILED');
  // 우리 인보이스(에스크로·보증금)를 지급처로 내밀면 우리 돈으로 우리 홀드를 채우게 된다
  if (ctx.holds.isOurs(info.paymentHash)) return ignored('our-invoice');
  // 범위가 아니라 **정확 일치** — 금액을 정한 게 우리다
  if (info.amountSat !== payout) return reject('AMOUNT_MISMATCH');
  const now = nowSec(ctx);
  const minLife = payoutPending ? MIN_REPLACEMENT_LIFETIME_SEC : MIN_SPONSOR_INVOICE_LIFETIME_SEC;
  if (info.expiresAt - now < minLife) return reject('EXPIRES_TOO_SOON');

  // 에스크로가 곧 죽는데 계좌 관문을 열면 후원자가 죽은 에스크로를 보고 원화를 보낸다
  if (order.state === 'escrowed' || order.state === 'invoiced') {
    const escrow = order.escrow_hash ? ctx.holds.get(order.escrow_hash) : undefined;
    const height = knownHeight(ctx);
    if (escrow?.htlc_expiry_height && height && escrow.htlc_expiry_height - height < INVOICE_ESCROW_MIN_BLOCKS) {
      return reject('ESCROW_ENDING_SOON');
    }
  }

  if (order.state === 'escrowed') {
    const invoiced = updateOrder(ctx, order.order_id, { state: 'invoiced', sponsor_invoice: bolt11 });
    notifyLnTransition(ctx, invoiced);
  } else {
    updateOrder(ctx, order.order_id, { sponsor_invoice: bolt11, payout_error: null });
    if (payoutPending) requestPayout(ctx, order.order_id);
  }

  // 유동성 프로빙 — 막지 않고 알려만 준다. 원화 이체 전에 "정말 받을 수 있는가"를 후원자에게
  if (!payoutPending) {
    ctx.effects.enqueue<ProbePayload>(LN_PROBE_EFFECT, { orderId: order.order_id, bolt11 }, { dedup: `ln.probe:${info.paymentHash}` });
  }
  return ok;
};

// ── 계좌 전달 (고객 → 후원자, 우리는 커밋먼트만 본다) ───────

const accountInfo: OrderHandler = (ctx, event, order) => {
  if (event.pubkey !== order.customer) return ignored('not-customer');
  // 계좌 관문은 invoiced부터다(I-009) — 그 전에 온 건 받지 않는다
  if (order.state !== 'invoiced' && order.state !== 'remitted') return ignored('bad-state');
  const commitment = tagValue(event, 'commitment');
  if (!commitment || !HEX64.test(commitment)) return ignored('no-commitment');
  if (order.account_commitment === commitment) return ignored('same-account');

  const updated = updateOrder(ctx, order.order_id, {
    account_sent_at: order.account_sent_at ?? nowSec(ctx), account_commitment: commitment,
  });
  notifyAccountArrived(ctx, updated, commitment);
  return ok;
};

// ── 송금 완료 · 입금 확인 · 취소 ────────────────────────────

/** 종결된 거래에 당사자 요청이 늦게 왔다 — 기한 안에 누른 거라면 사람이 봐야 한다 */
function lateArrival(ctx: LnContext, event: InboxEvent, order: LnOrderRow, what: string): HandlerResult {
  if (isTerminalState(order.state) && event.created_at <= order.updated_at) {
    raiseAlert(ctx, {
      dedup: `ln:${order.order_id}:late:${event.id}`, level: 'anomaly', track: 'ln', orderId: order.order_id,
      message: `${what}이(가) 종결(${order.state}) 뒤에 도착했다 — 원화가 오갔는지 확인해야 한다`,
    });
  }
  return ignored('bad-state');
}

const remitRequest: OrderHandler = (ctx, event, order) => {
  if (event.pubkey !== order.sponsor) return ignored('not-sponsor');
  if (order.pending_close) return ignored('closing');
  if (order.state !== 'invoiced') return lateArrival(ctx, event, order, '송금 완료');
  // 유예까지만 — 그 뒤에 누른 건 가상계좌가 닫힌 뒤의 송금이다
  if (event.created_at > order.deadline + DEADLINE_GRACE_SEC) return ignored('after-deadline');

  const remitted = updateOrder(ctx, order.order_id, { state: 'remitted', remitted_at: nowSec(ctx) });
  notifyLnTransition(ctx, remitted);
  return ok;
};

const paymentConfirm: OrderHandler = (ctx, event, order) => {
  if (event.pubkey !== order.customer) return ignored('not-customer');
  if (order.pending_close) return ignored('closing');
  if (order.state !== 'invoiced' && order.state !== 'remitted') return lateArrival(ctx, event, order, '입금 확인');
  // settle이 성공해야 paid가 된다(DM-003) — 여기선 닫기를 시작만 한다
  beginClose(ctx, order, 'paid');
  return ok;
};

function cancelRequest(ctx: LnContext, event: InboxEvent): HandlerResult {
  const orderId = extractOrderId(event.tags);
  if (!orderId) return ignored('no-order');

  // 보증금을 내기 전에 접은 의뢰
  const draft = getDraft(ctx, orderId);
  if (draft) {
    if (draft.customer !== event.pubkey) return ignored('not-customer');
    deleteDraft(ctx, orderId);
    const dep = ctx.holds.current('ln-customer-deposit', orderId, draft.customer);
    if (dep) ctx.holds.dispose(dep.payment_hash, 'cancel');
    return ok;
  }

  const order = getOrder(ctx, orderId);
  if (!order) return ignored('unknown-order');
  if (event.pubkey !== order.customer) return ignored('not-customer');
  if (order.pending_close) return ignored('closing');
  if (order.state === 'requested') return beginClose(ctx, order, 'cancel:customer') ? ok : ignored('closing');
  // 후원자를 붙여놓고 접었다 — 후원자 시간 낭비라 고객 보증금은 몰수(CLOSE_RULES)
  if (order.state === 'claimed' || order.state === 'verified') {
    return beginClose(ctx, order, 'cancel:customer-after-claim') ? ok : ignored('closing');
  }
  return ignored('bad-state'); // 에스크로 뒤로는 고객 혼자 못 접는다
}

// ── 웹 푸시 구독 (계정 단위) ────────────────────────────────

function pushSubscription(ctx: LnContext, event: InboxEvent): HandlerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(nip44Decrypt(event.content, ctx.appKey.secretKey, event.pubkey));
  } catch {
    return ignored('undecryptable');
  }
  if (!isPushSubscriptionPayload(parsed)) return ignored('bad-payload');
  // 새 기기일 때만, 그 기기에만 등록 확인 — 다른 기기까지 울리지 않게
  if (saveSubscription(ctx, event.pubkey, parsed)) {
    queuePush(ctx, { pubkey: event.pubkey, message: PUSH_WELCOME, endpoint: parsed.endpoint });
  }
  return ok;
}

/** action → 핸들러. 여기 없는 action(알림용·자기암호화 등)은 라우터가 넘기지 않는다 */
export function createLnHandlers(ctx: LnContext): ReadonlyMap<string, Handler> {
  return new Map<string, Handler>([
    [REQUEST_ACTIONS.ORDER_REQUEST, event => orderRequest(ctx, event)],
    [REQUEST_ACTIONS.CLAIM, withOrder(ctx, claim)],
    [REQUEST_ACTIONS.SPONSOR_INVOICE, withOrder(ctx, sponsorInvoice)],
    [REQUEST_ACTIONS.ACCOUNT_INFO, withOrder(ctx, accountInfo)],
    [REQUEST_ACTIONS.REMIT_REQUEST, withOrder(ctx, remitRequest)],
    [REQUEST_ACTIONS.PAYMENT_CONFIRM, withOrder(ctx, paymentConfirm)],
    [REQUEST_ACTIONS.CANCEL_REQUEST, event => cancelRequest(ctx, event)],
    [REQUEST_ACTIONS.PUSH_SUBSCRIPTION, event => pushSubscription(ctx, event)],
  ]);
}
