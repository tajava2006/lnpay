/**
 * 온체인 알림 발송 (PLAN-ONCHAIN-TRACK §6.2 · §7.5)
 *
 * 문구는 `notify-messages.ts`의 표가 진실이고, 여기서는 **누구에게 보낼지**만 한다.
 * 라이트닝의 `notify-triggers.ts`와 같은 모양 — 전이 직후 한 줄만 부르면 된다.
 *
 * 전부 fire-and-forget이다. **알림 실패가 거래 진행을 막아선 안 된다.**
 */
import { NOSTR_DM_NOTIFICATIONS } from '@sajwo-tracker/shared';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
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
  if (!notices) return;
  if (notices.customer) deliver(order.customerPubkey, notices.customer, order.orderId);
  if (notices.sponsor) deliver(order.sponsorPubkey, notices.sponsor, order.orderId);
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

/** 환불 서명이 필요하다 — 안 오면 고객 자금이 잠긴 채로 남는다 */
export function notifyOnchainRefundSignature(order: OnchainOrder): void {
  deliver(order.customerPubkey, ONCHAIN_TIMER_NOTICES.refundSignatureNeeded(), order.orderId);
}
