/**
 * 알림 발송 지점
 *
 * 상태 전이는 service.ts와 invoice-watcher.ts 두 군데서 일어난다. 각 전이마다
 * notify()를 흩뿌리면 새 전이를 추가할 때 알림을 빠뜨리기 쉽다. 그래서 "전이 후 상태
 * → 누구에게 무엇을"의 표를 여기 한 장으로 두고, 두 파일은 발행 성공 직후
 * notifyTransition(updatedOrder) 한 줄만 부른다.
 *
 * 모두 fire-and-forget이다. 알림 실패가 거래 진행을 막아선 안 된다.
 */
import type { Order } from '@sajwo-tracker/shared';
import { notify } from './notify';
import { NOTIFY } from './notify-messages';

/**
 * 전이된 오더 상태에 맞는 알림을 보낸다.
 * 알림이 필요 없는 상태(requested, claimed)는 아무것도 하지 않는다.
 */
export function notifyTransition(order: Order): void {
  const { customerPubkey, sponsorPubkey } = order;

  switch (order.state) {
    // 고객 차례 — 결제해야 거래가 시작된다
    case 'verified':
      void notify(customerPubkey, NOTIFY.customerShouldPay());
      break;

    // 고객 차례 — 계좌를 보내야 후원자가 송금할 수 있다
    case 'escrowed':
      void notify(customerPubkey, NOTIFY.customerShouldSendAccount());
      break;

    // 고객 차례 — 후원자가 이미 보내놓고 기다린다. 가장 급한 알림
    case 'remitted':
      void notify(customerPubkey, NOTIFY.customerShouldConfirm());
      break;

    // 정상 종료 — 행동은 필요 없지만 결과는 알아야 한다
    case 'paid':
      void notify(customerPubkey, NOTIFY.customerCompleted());
      if (sponsorPubkey) void notify(sponsorPubkey, NOTIFY.sponsorCompleted());
      break;

    case 'cancelled':
      void notify(customerPubkey, NOTIFY.cancelled());
      if (sponsorPubkey) void notify(sponsorPubkey, NOTIFY.cancelled());
      break;

    // 분쟁 판정 — 양쪽에 결과를 알린다
    case 'sponsor_wins':
      void notify(customerPubkey, NOTIFY.disputeResolved(false));
      if (sponsorPubkey) void notify(sponsorPubkey, NOTIFY.disputeResolved(true));
      break;

    case 'customer_wins':
      void notify(customerPubkey, NOTIFY.disputeResolved(true));
      if (sponsorPubkey) void notify(sponsorPubkey, NOTIFY.disputeResolved(false));
      break;
  }
}

/**
 * 계좌 정보 도착 알림.
 *
 * 이건 상태 전이가 아니라서 위 표에 들어가지 않는다 — escrowed 안에서 "고객이
 * 계좌를 보냈는가"만 바뀌기 때문이다. 하지만 후원자가 원화를 보낼 수 있게 되는
 * 순간이 정확히 여기라, 후원자에게는 이게 유일하게 필요한 알림이다.
 */
export function notifyAccountInfoArrived(order: Order): void {
  if (!order.sponsorPubkey) return;
  void notify(order.sponsorPubkey, NOTIFY.sponsorShouldRemit());
}
