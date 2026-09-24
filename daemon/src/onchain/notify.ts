/**
 * 온체인 알림 발송 (PLAN-ONCHAIN-TRACK §6.2 · §7.5)
 *
 * 문구는 `notify-messages.ts`의 표가 진실이고, 여기서는 **누구에게 보낼지**만 한다.
 * 라이트닝(`../ln/notify.ts`)과 같은 모양 — 같은 버전에서 두 번 부르는 실수만 `notices`가 막는다.
 *
 * 운영자는 경보(`raiseAlert` — 상태에 실리고 NIP-17 DM으로 간다)로 부른다. 프론트 시절엔 어드민에게 가는
 * 알림이 하나도 없어서 "분쟁 진입 즉시 어드민 호출"(§7.3 ③)이 실제로는 없었다(리뷰 #8).
 */
import { awaitingSignerFor, type OnchainOrder } from '@sajwo-tracker/shared/onchain';
import { raiseAlert } from '../admin/alerts';
import { nowSec } from '../admin/context';
import { asPush, type Notice } from '../ln/notify-messages';
import { queuePush } from '../push/send';
import type { OcContext } from './context';
import { ONCHAIN_TIMER_NOTICES, ONCHAIN_TRANSITION_NOTICES } from './notify-messages';

function deliver(ctx: OcContext, pubkey: string | undefined, notice: Notice, orderId: string, key: string): void {
  if (!pubkey) return;
  const r = ctx.db.run('INSERT OR IGNORE INTO notices (key, sent_at) VALUES (?, ?)', key, nowSec(ctx));
  if (r.changes === 0) return;
  queuePush(ctx, { pubkey, message: asPush(notice, orderId) });
}

/** 상태에 **진입했을 때** 보낸다. 알림이 없는 상태는 표에 `null`로 명시돼 있다 */
export function notifyOcTransition(ctx: OcContext, order: OnchainOrder, version: number): void {
  const notices = ONCHAIN_TRANSITION_NOTICES[order.state];
  const key = (role: string) => `oc:${order.orderId}:v${version}:${order.state}:${role}`;
  if (notices?.customer) deliver(ctx, order.customerPubkey, notices.customer, order.orderId, key('customer'));
  if (notices?.sponsor) deliver(ctx, order.sponsorPubkey, notices.sponsor, order.orderId, key('sponsor'));
  // 침묵 공격은 어드민이 와야만 깨진다(§7.3 ③) — 분쟁은 **즉시** 운영자를 부른다
  if (order.state === 'disputed') {
    raiseAlert(ctx, {
      dedup: `oc:${order.orderId}:disputed:${order.disputedAt ?? version}`, level: 'warn', track: 'onchain',
      orderId: order.orderId, message: '분쟁이 열렸습니다. 판정이 필요합니다.',
    });
  }
}

/** 분쟁 판정이 났다 — 이긴 쪽에게 서명을, 진 쪽에게 결과를 */
export function notifyOcRuling(ctx: OcContext, order: OnchainOrder): void {
  if (!order.settlementKind) return;
  const winnerIsSponsor = awaitingSignerFor(order.settlementKind) === 'sponsor';
  const winner = winnerIsSponsor ? order.sponsorPubkey : order.customerPubkey;
  const loser = winnerIsSponsor ? order.customerPubkey : order.sponsorPubkey;
  const key = `oc:${order.orderId}:ruling:${order.settlementKind}`;
  deliver(ctx, winner, ONCHAIN_TIMER_NOTICES.rulingSignatureNeeded(), order.orderId, `${key}:winner`);
  deliver(ctx, loser, ONCHAIN_TIMER_NOTICES.rulingDecided(), order.orderId, `${key}:loser`);
}

/** 계좌 도착 — 상태가 안 바뀌는데 **후원자가 원화를 보낼 수 있게 되는 순간**이다 */
export function notifyOcAccountArrived(ctx: OcContext, order: OnchainOrder): void {
  deliver(ctx, order.sponsorPubkey, ONCHAIN_TIMER_NOTICES.accountInfoArrived(), order.orderId,
    `oc:${order.orderId}:account:${order.accountSentAt ?? 0}`);
}

/**
 * cosign 마감 2시간 전 유예 경고 (§7.5) — **송금 주장 한 번에 한 번.** 프론트 시절엔 워처가 30초마다 내서
 * 고객에게 240번 울렸다(리뷰 #8).
 */
export function notifyOcDisputeSoon(ctx: OcContext, order: OnchainOrder): void {
  deliver(ctx, order.customerPubkey, ONCHAIN_TIMER_NOTICES.disputeSoon(), order.orderId,
    `oc:${order.orderId}:dispute-soon:${order.remittedAt ?? 0}`);
}
