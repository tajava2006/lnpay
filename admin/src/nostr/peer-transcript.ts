/**
 * 공개된 두 사람 대화 읽기 — 당사자가 운영자를 부르며 넘긴 거래별 대화 키로 (docs/PLAN-PEER-CHAT.md §9)
 *
 * 릴레이에서 **원본 이벤트를 직접** 받는다 — 부른 쪽이 골라 낸 사본이 아니라서 메시지를 빼거나 고칠 수 없다. 당사자 두
 * 명이 쓴 것만(`authors`), 서명이 맞는 것만 받고, 이 키로 풀리는 것만 그린다. 못 푸는 건 숨기지 않고 센다 — 증거 화면이
 * 조용히 줄어들면 안 된다.
 *
 * **읽기만 한다.** 키를 알아도 운영자는 대화에 쓸 수 없다(유저 앱이 당사자 서명만 연다). 어드민이 명령만 보낸다는 원칙과도
 * 어긋나지 않는다 — 상태를 바꾸지 않는다.
 */
import type { Event } from 'nostr-tools/core';
import { verifyEvent } from 'nostr-tools/pure';
import {
  APP_PUBKEY, MESSAGE_KIND, REQUEST_ACTIONS, createSubscriptionPool, getReadRelays, openPeerMessage, orderRef,
  peerChatKeyFromHex, storage, trackTagOf, type TrackName,
} from '@sajwo-tracker/shared';

export interface TranscriptMessage {
  id: string;
  from: string;
  text: string;
  createdAt: number;
}

export async function subscribePeerTranscript(
  args: { track: TrackName; orderId: string; customer: string; sponsor: string; keyHex: string },
  on: { message: (m: TranscriptMessage) => void; unreadable: (eventId: string) => void },
): Promise<() => void> {
  const relays = await getReadRelays(storage);
  const key = peerChatKeyFromHex(args.keyHex);
  const trackTag = trackTagOf(args.track);
  const parties = { customer: args.customer, sponsor: args.sponsor };

  const pool = createSubscriptionPool();
  const sub = pool.subscribeMany(
    relays,
    { kinds: [MESSAGE_KIND], '#a': [orderRef(APP_PUBKEY, args.orderId)], '#t': [trackTag], authors: [args.customer, args.sponsor] },
    {
      onevent: (event: Event) => {
        if (event.tags.find(t => t[0] === 'action')?.[1] !== REQUEST_ACTIONS.PEER_MESSAGE) return;
        const opened = verifyEvent(event) ? openPeerMessage(event, { orderId: args.orderId, trackTag, parties, key }) : null;
        if (!opened) {
          on.unreadable(event.id);
          return;
        }
        on.message({ id: event.id, from: event.pubkey, text: opened.text, createdAt: event.created_at });
      },
    },
  );
  return () => {
    sub.close();
    pool.destroy();
  };
}
