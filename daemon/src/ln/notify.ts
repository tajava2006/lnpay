/**
 * 전이 → 누구에게 무슨 알림 (웹 푸시)
 *
 * 전이는 DB 변경 한 번에 한 번만 일어나므로 같은 알림이 두 번 울릴 일이 구조적으로 없다 — `notices`는
 * **같은 버전에서 두 번 부르는 실수**만 막는 안전망이다. 키에 버전이 들어가므로, 클레임이 풀렸다 다시
 * 승인되면 "결제하세요"는 다시 간다.
 *
 * 알림은 부가 기능이다 — 효과 대기열로 보내고 실패해도 거래를 막지 않는다.
 */
import { nowSec } from '../admin/context';
import { queuePush } from '../push/send';
import type { LnContext } from './context';
import { NOTIFY, asPush, type Notice } from './notify-messages';
import type { LnOrderRow } from './store';

function deliver(ctx: LnContext, pubkey: string, notice: Notice, orderId: string, key: string): void {
  const r = ctx.db.run('INSERT OR IGNORE INTO notices (key, sent_at) VALUES (?, ?)', key, nowSec(ctx));
  if (r.changes === 0) return;
  queuePush(ctx, { pubkey, message: asPush(notice, orderId) });
}

/** 전이된 오더 상태에 맞는 알림. 알림이 필요 없는 상태(requested, claimed)는 아무것도 안 한다 */
export function notifyLnTransition(ctx: LnContext, order: LnOrderRow): void {
  const { order_id: orderId, customer, sponsor, state, version } = order;
  const key = (role: string) => `ln:${orderId}:v${version}:${state}:${role}`;
  const toCustomer = (n: Notice) => deliver(ctx, customer, n, orderId, key('customer'));
  const toSponsor = (n: Notice) => { if (sponsor) deliver(ctx, sponsor, n, orderId, key('sponsor')); };

  switch (state) {
    // 고객 차례 — 결제해야 거래가 시작된다
    case 'verified':
      toCustomer(NOTIFY.customerShouldPay());
      break;
    // 후원자 차례 — 받을 인보이스. 여기서 고객에게 "계좌를 보내라"고 하면 할 수 없는 일을 시키는 것이다
    case 'escrowed':
      toSponsor(NOTIFY.sponsorShouldRegisterInvoice());
      break;
    // 고객 차례 — 계좌를 보내야 후원자가 송금할 수 있다
    case 'invoiced':
      toCustomer(NOTIFY.customerShouldSendAccount());
      break;
    // 고객 차례 — 후원자가 이미 보내놓고 기다린다. 가장 급하다
    case 'remitted':
      toCustomer(NOTIFY.customerShouldConfirm());
      break;
    case 'paid':
      toCustomer(NOTIFY.customerCompleted());
      toSponsor(NOTIFY.sponsorCompleted());
      break;
    case 'cancelled':
      toCustomer(NOTIFY.cancelled());
      toSponsor(NOTIFY.cancelled());
      break;
    case 'expired':
      toCustomer(NOTIFY.expired());
      toSponsor(NOTIFY.expired());
      break;
    case 'admin_closed':
      toCustomer(NOTIFY.adminClosed());
      toSponsor(NOTIFY.adminClosed());
      break;
    case 'sponsor_wins':
      toCustomer(NOTIFY.disputeResolved(false));
      toSponsor(NOTIFY.disputeResolved(true));
      break;
    case 'customer_wins':
      toCustomer(NOTIFY.disputeResolved(true));
      toSponsor(NOTIFY.disputeResolved(false));
      break;
    case 'requested':
    case 'claimed':
      break;
  }
}

/**
 * 계좌가 도착했다 — 전이가 아니라 위 표에 없지만, 후원자가 원화를 보낼 수 있게 되는 순간이다.
 * 계좌가 바뀌면(커밋먼트가 다르면) 다시 알린다.
 */
export function notifyAccountArrived(ctx: LnContext, order: LnOrderRow, commitment: string): void {
  if (!order.sponsor) return;
  deliver(ctx, order.sponsor, NOTIFY.sponsorShouldRemit(), order.order_id, `ln:${order.order_id}:account:${commitment}`);
}

/**
 * 보증금을 내라 — 전이가 아니라 홀드 인보이스가 생긴 순간이다. 후원자 보증금은 제한 시간이 짧고 안 내면
 * 클레임이 풀린다(2026-09-24 드릴: 알림이 안 와 몰랐다). 인보이스마다 한 번.
 */
export function notifyDepositRequired(
  ctx: LnContext, pubkey: string, orderId: string, role: 'customer' | 'sponsor', paymentHash: string,
): void {
  const notice = role === 'sponsor' ? NOTIFY.sponsorShouldPayDeposit() : NOTIFY.customerShouldPayDeposit();
  deliver(ctx, pubkey, notice, orderId, `ln:${orderId}:deposit:${paymentHash}`);
}
