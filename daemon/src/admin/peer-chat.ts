/**
 * 상대방 채팅 → 받는 사람에게 웹 푸시 (docs/PLAN-PEER-CHAT.md §6.1)
 *
 * 상대방 채팅은 두 당사자만 읽는 암호문이다(`shared/peer-chat.ts`) — 데몬은 **열지 못하고 열려고 하지도 않는다**. 보낸
 * 쪽이 `p`에 APP을 달아 주는 건 "상대에게 알려 달라"는 뜻뿐이다. 유저 앱은 거래 화면을 연 동안만 채팅을 받으므로,
 * 이게 없으면 상대가 말을 걸어도 다음에 앱을 열 때까지 모른다.
 *
 * **당사자가 보낸 것만** 울린다 — `p=APP`은 누구나 달 수 있다. 받는 사람은 그 거래의 반대쪽 한 명뿐이다.
 *
 * 조용한 창은 RoboSats와 같은 규칙이다(그쪽 `CHAT_NOTIFICATION_TIMEGAP`): 대화의 **첫 메시지는 늘** 울리고, 그 뒤로는
 * 직전 메시지(어느 쪽이 보냈든)에서 `PEER_PUSH_QUIET_SEC` 넘게 조용했을 때만 울린다. 말이 오가는 중이면 둘 다 앱에
 * 있으니 울릴 필요가 없고, 한참 뒤에 온 말은 놓치면 안 된다. 시각은 데몬이 받은 때다(`created_at`은 보낸 쪽이 정한다).
 *
 * 운영자 DM은 없다 — 운영자는 이 대화에 없다(부를 때만 온다).
 */
import { extractOrderId, type TrackName } from '@sajwo-tracker/shared/core';
import type { HandlerResult, InboxEvent } from '../dispatch';
import { tagValue } from '../dispatch';
import { NOTIFY, asPush } from '../ln/notify-messages';
import { roleIn } from '../orders/directory';
import { queuePush } from '../push/send';
import { nowSec, type AdminContext } from './context';

/** 상대방 채팅 푸시의 조용한 창 (D6) */
export const PEER_PUSH_QUIET_SEC = 5 * 60;

/**
 * 상대방 채팅 알림 태그 — 거래 알림(태그 = 오더 id)·운영자 채팅 알림(`chat:<오더>`)과 따로 둔다. 같은 태그면 아직 안 본
 * "결제하세요"나 운영자 질문을 덮어 지운다. 상대방 채팅끼리는 최신 것으로 대체된다.
 */
export const peerPushTag = (orderId: string): string => `peer:${orderId}`;

export function createPeerPinger(ctx: AdminContext): (event: InboxEvent) => HandlerResult {
  return event => {
    const t = tagValue(event, 't');
    const track: TrackName | null = t === ctx.tags.ln ? 'ln' : t === ctx.tags.onchain ? 'onchain' : null;
    if (!track) return { outcome: 'ignored', reason: 'no-track' };
    const orderId = extractOrderId(event.tags);
    if (!orderId) return { outcome: 'ignored', reason: 'no-order' };

    const parties = ctx.directory.lookup(track, orderId);
    if (!parties) return { outcome: 'ignored', reason: 'unknown-order' };
    const role = roleIn(parties, event.pubkey);
    if (!role) return { outcome: 'ignored', reason: 'not-a-party' };
    const to = role === 'customer' ? parties.sponsor : parties.customer;
    if (!to) return { outcome: 'ignored', reason: 'no-counterparty' };

    const key = `peer.last:${track}:${orderId}`;
    const now = nowSec(ctx);
    const last = ctx.db.kvGet(key);
    ctx.db.kvSet(key, String(now));
    if (last !== undefined && now - Number(last) < PEER_PUSH_QUIET_SEC) return { outcome: 'ok' };

    // 받는 사람 자리의 탭으로 — 파는 사람(customer)은 팔기, 사는 사람은 사기
    const notice = NOTIFY.peerMessage(role === 'customer' ? 'fulfill' : 'request', track);
    queuePush(ctx, { pubkey: to, message: { ...asPush(notice, orderId), tag: peerPushTag(orderId) } });
    return { outcome: 'ok' };
  };
}
