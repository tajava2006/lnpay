/**
 * 온체인 알림 발송 (PLAN-ONCHAIN-TRACK §6.2 · §7.5)
 *
 * 문구는 `notify-messages.ts`의 표가 진실이고, 여기서는 **누구에게 보낼지**만 한다.
 * 라이트닝의 `notify-triggers.ts`와 같은 모양 — 전이 직후 한 줄만 부르면 된다.
 *
 * 전부 fire-and-forget이다. **알림 실패가 거래 진행을 막아선 안 된다.**
 */
import { NOSTR_DM_NOTIFICATIONS } from '@sajwo-tracker/shared';
import { awaitingSignerFor, type OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { getOnchainOperatorPubkey } from './config';
import { sendPush } from '../web-push/send';
import { notify } from '../nostr/notify';
import { asDirectMessage, asPush, type Notice } from '../nostr/notify-messages';
import { ONCHAIN_TIMER_NOTICES, ONCHAIN_TRANSITION_NOTICES } from './notify-messages';

function deliver(pubkey: string | undefined, notice: Notice, orderId: string): void {
  if (!pubkey) return;
  void sendPush(pubkey, asPush(notice, orderId));
  if (NOSTR_DM_NOTIFICATIONS) void notify(pubkey, asDirectMessage(notice));
}

/** 상태에 **진입했을 때** 보낸다. 알림이 없는 상태는 표에 `null`로 명시돼 있다 */
export function notifyOnchainTransition(order: OnchainOrder): void {
  const notices = ONCHAIN_TRANSITION_NOTICES[order.state];
  if (notices?.customer) deliver(order.customerPubkey, notices.customer, order.orderId);
  if (notices?.sponsor) deliver(order.sponsorPubkey, notices.sponsor, order.orderId);
  // 침묵 공격은 어드민이 와야만 깨진다(§7.3 ③) — 분쟁은 **즉시** 운영자를 부른다.
  if (order.state === 'disputed') notifyOnchainOperator(order, '분쟁이 열렸습니다. 판정이 필요합니다.');
}

/** 분쟁 판정이 났다 — 이긴 쪽에게 서명을, 진 쪽에게 결과를 */
export function notifyOnchainRuling(order: OnchainOrder): void {
  if (!order.settlementKind) return;
  const winnerIsSponsor = awaitingSignerFor(order.settlementKind) === 'sponsor';
  const winner = winnerIsSponsor ? order.sponsorPubkey : order.customerPubkey;
  const loser = winnerIsSponsor ? order.customerPubkey : order.sponsorPubkey;
  deliver(winner, ONCHAIN_TIMER_NOTICES.rulingSignatureNeeded(), order.orderId);
  deliver(loser, ONCHAIN_TIMER_NOTICES.rulingDecided(), order.orderId);
}

/**
 * 운영자를 부른다 — 설정한 nostr pubkey로 NIP-17 DM, 탭이 열려 있으면 브라우저 알림.
 *
 * 전에는 어드민에게 가는 알림이 **하나도** 없었다(리뷰 #8). 경보는 탭을 열어야 보였고,
 * §7.3이 방어의 일부로 적은 "분쟁 진입 즉시 어드민 호출"이 실제로는 없었다.
 * 부르는 쪽이 **새 경보일 때만** 부른다(30초마다 울리지 않게).
 */
export function notifyOnchainOperator(order: OnchainOrder, message: string): void {
  const text = `[온체인 ${order.orderId}] ${message}`;
  const operator = getOnchainOperatorPubkey();
  if (operator) void notify(operator, text);
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('페어바이 어드민', { body: text });
    }
  } catch {
    // 알림은 부가 기능이다 — 실패가 거래 진행을 막으면 안 된다.
  }
}

/**
 * 계좌 도착 — 상태가 안 바뀌는데 **후원자가 원화를 보낼 수 있게 되는 순간**이다.
 * 그래서 전이표가 아니라 따로 부른다.
 */
export function notifyOnchainAccountArrived(order: OnchainOrder): void {
  deliver(order.sponsorPubkey, ONCHAIN_TIMER_NOTICES.accountInfoArrived(), order.orderId);
}

/** cosign 마감 2시간 전 유예 경고 (§7.5) */
export function notifyOnchainDisputeSoon(order: OnchainOrder): void {
  deliver(order.customerPubkey, ONCHAIN_TIMER_NOTICES.disputeSoon(), order.orderId);
}


