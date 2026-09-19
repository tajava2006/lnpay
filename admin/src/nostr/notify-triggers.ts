/**
 * 알림 발송 지점
 *
 * 상태 전이는 service.ts와 invoice-watcher.ts 두 군데서 일어난다. 각 전이마다
 * 발송을 흩뿌리면 새 전이를 추가할 때 알림을 빠뜨리기 쉽다. 그래서 "전이 후 상태
 * → 누구에게 무엇을"의 표를 여기 한 장으로 두고, 두 파일은 발행 성공 직후
 * notifyTransition(updatedOrder) 한 줄만 부른다.
 *
 * ── 두 통로를 같이 쏜다
 *
 * Web Push가 1순위다 — 설치도 계정도 없이 브라우저 "허용" 한 번이면 되고,
 * 안드로이드는 브라우저를 닫아도 온다. NIP-17은 그게 안 되는 경우(구독을 안 했거나
 * 브라우저 데이터가 날아갔거나)를 받쳐준다. 둘 다 받으면 같은 알림이 두 번 뜨는데,
 * 못 받는 것보다 낫고 유저가 한쪽을 끄면 정리된다.
 *
 * 모두 fire-and-forget이다. 알림 실패가 거래 진행을 막아선 안 된다.
 */
import { NOSTR_DM_NOTIFICATIONS, type Order } from '@sajwo-tracker/shared';
import { notify } from './notify';
import { sendPush } from '../web-push/send';
import { NOTIFY, asDirectMessage, asPush, type Notice } from './notify-messages';

/** 한 사람에게 알림을 보낸다. */
function deliver(pubkey: string, notice: Notice, orderId: string): void {
  void sendPush(pubkey, asPush(notice, orderId));
  // NIP-17은 현재 꺼져 있다 — 안내를 감춘 뒤로는 아무도 안 여는 gift wrap이
  // 릴레이에 쌓이기만 한다. 되살릴 땐 NOSTR_DM_NOTIFICATIONS만 켜면 된다.
  if (NOSTR_DM_NOTIFICATIONS) void notify(pubkey, asDirectMessage(notice));
}

/**
 * 전이된 오더 상태에 맞는 알림을 보낸다.
 * 알림이 필요 없는 상태(requested, claimed)는 아무것도 하지 않는다.
 */
export function notifyTransition(order: Order): void {
  const { customerPubkey, sponsorPubkey, orderId } = order;
  const toCustomer = (n: Notice) => deliver(customerPubkey, n, orderId);
  const toSponsor = (n: Notice) => { if (sponsorPubkey) deliver(sponsorPubkey, n, orderId); };

  switch (order.state) {
    // 고객 차례 — 결제해야 거래가 시작된다
    case 'verified':
      toCustomer(NOTIFY.customerShouldPay());
      break;

    // 후원자 차례 — 받을 인보이스를 등록해야 거래가 진행된다.
    // 여기서 고객에게 "계좌를 보내라"고 하면 **할 수 없는 일을 시키는 것**이다
    // (계좌 발행은 invoiced부터 열린다).
    case 'escrowed':
      toSponsor(NOTIFY.sponsorShouldRegisterInvoice());
      break;

    // 고객 차례 — 계좌를 보내야 후원자가 송금할 수 있다
    case 'invoiced':
      toCustomer(NOTIFY.customerShouldSendAccount());
      break;

    // 고객 차례 — 후원자가 이미 보내놓고 기다린다. 가장 급한 알림
    case 'remitted':
      toCustomer(NOTIFY.customerShouldConfirm());
      break;

    // 정상 종료 — 행동은 필요 없지만 결과는 알아야 한다
    case 'paid':
      toCustomer(NOTIFY.customerCompleted());
      toSponsor(NOTIFY.sponsorCompleted());
      break;

    case 'cancelled':
      toCustomer(NOTIFY.cancelled());
      toSponsor(NOTIFY.cancelled());
      break;

    // 어드민이 끊었다 — 양쪽 다 왜 끝났는지 알아야 한다.
    case 'admin_closed':
      toCustomer(NOTIFY.adminClosed());
      toSponsor(NOTIFY.adminClosed());
      break;

    // 분쟁 판정 — 양쪽에 결과를 알린다
    case 'sponsor_wins':
      toCustomer(NOTIFY.disputeResolved(false));
      toSponsor(NOTIFY.disputeResolved(true));
      break;

    case 'customer_wins':
      toCustomer(NOTIFY.disputeResolved(true));
      toSponsor(NOTIFY.disputeResolved(false));
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
  deliver(order.sponsorPubkey, NOTIFY.sponsorShouldRemit(), order.orderId);
}
