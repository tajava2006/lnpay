/**
 * 상대방 채팅 그때그때 구독 — 거래 상세 화면에 들어오면 열고 나가면 닫는다(운영자 채팅 `chat-subscribe.ts`와 같은 방식)
 *
 * `#p:[나]`로 받는다 — 상대가 보낸 것과 내 다른 기기가 보낸 것이 같이 온다. 열기는 `openPeerMessage`가 거른다.
 */
import type { Event } from 'nostr-tools/core';
import { createSubscriptionPool } from './relay-pool';
import type { TrackName } from './admin-protocol';
import { APP_PUBKEY, CLIENT_TAG, CLIENT_TAG_ONCHAIN, MESSAGE_KIND, ORDER_KIND } from './constants';
import { getSecretKey, getUserPubkey } from './keys';
import { derivePeerChatKey, openPeerMessage, type PeerChatParties } from './peer-chat';
import { getReadRelays } from './relays';
import { storage } from './storage';
import type { ChatMessage } from './types';

export const trackTagOf = (track: TrackName): string => (track === 'ln' ? CLIENT_TAG : CLIENT_TAG_ONCHAIN);

export async function subscribePeerMessages(
  args: { track: TrackName; orderId: string; parties: PeerChatParties },
  onMessage: (msg: ChatMessage) => void,
): Promise<() => void> {
  const [sk, relays, myPubkey] = await Promise.all([getSecretKey(storage), getReadRelays(storage), getUserPubkey(storage)]);
  const { track, orderId, parties } = args;
  const peerPubkey = myPubkey === parties.customer ? parties.sponsor : parties.customer;
  const key = await derivePeerChatKey(sk, peerPubkey, track, orderId);
  const trackTag = trackTagOf(track);

  const pool = createSubscriptionPool();
  const sub = pool.subscribeMany(
    relays,
    { kinds: [MESSAGE_KIND], '#a': [`${ORDER_KIND}:${APP_PUBKEY}:${orderId}`], '#p': [myPubkey], '#t': [trackTag] },
    {
      onevent: (event: Event) => {
        const opened = openPeerMessage(event, { orderId, trackTag, parties, key });
        if (!opened) return;
        onMessage({
          eventId: event.id,
          orderId,
          senderPubkey: event.pubkey,
          recipientPubkey: event.pubkey === myPubkey ? peerPubkey : myPubkey,
          payload: { type: 'text', content: opened.text },
          createdAt: event.created_at,
          channel: 'peer',
        });
      },
    },
  );

  return () => {
    sub.close();
    pool.destroy();
  };
}
