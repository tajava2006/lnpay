/**
 * 상대방 채팅 보내기 · 운영자 부르기 (유저 → 상대 / 유저 → 데몬) — 두 트랙·두 역할 공용 (docs/PLAN-PEER-CHAT.md §8)
 *
 * 분쟁 채팅(`dispute-message.ts`)처럼 서명까지만 하고 발행은 호출부(`shared/chat-send`)가 돌린다 — 서명을 먼저 해야
 * 낙관적으로 넣은 메시지와 릴레이 에코가 같은 eventId로 겹쳐 사라진다.
 */
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, derivePeerChatKey, getReadRelays, getSecretKey, nowSec, peerChatKeyHex, peerMessageTemplate, storage,
  trackTagOf, type DisputeMessagePayload, type PreparedChatMessage, type TrackName,
} from '@sajwo-tracker/shared';
import { prepareDisputeMessage } from './dispute-message';

/** 상대방 채팅이 무엇을 알아야 하나 — 어느 거래의 누구와 */
export interface PeerChatTarget {
  track: TrackName;
  orderId: string;
  peerPubkey: string;
}

async function publish(signed: Event): Promise<boolean> {
  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    return results.some(r => r.status === 'fulfilled');
  } finally {
    pool.destroy();
  }
}

export async function preparePeerMessage(target: PeerChatTarget, text: string): Promise<PreparedChatMessage> {
  const sk = await getSecretKey(storage);
  const myPubkey = getPublicKey(sk);
  const key = await derivePeerChatKey(sk, target.peerPubkey, target.track, target.orderId);
  const createdAt = nowSec();
  const signed = finalizeEvent(peerMessageTemplate({
    appPubkey: APP_PUBKEY, trackTag: trackTagOf(target.track), orderId: target.orderId, myPubkey,
    peerPubkey: target.peerPubkey, key, text, createdAt,
  }), sk);
  return {
    message: {
      eventId: signed.id, orderId: target.orderId, senderPubkey: myPubkey, recipientPubkey: target.peerPubkey,
      payload: { type: 'text', content: text }, createdAt, channel: 'peer',
    },
    publish: () => publish(signed),
  };
}

/**
 * 운영자 부르기 — 사유와 **이 거래의 상대방 대화 키**를 운영자 채팅으로 보낸다. 운영자는 그 키로 두 사람 대화를 읽기만
 * 한다(개인키도, 다른 거래 대화도, 계좌 정보도 안 열린다 — `shared/peer-chat.ts`). 상대가 아직 없으면 키 없이 부른다.
 */
export async function prepareOperatorCall(
  args: { track: TrackName; orderId: string; peerPubkey: string | null },
  reason: string,
): Promise<PreparedChatMessage> {
  const payload: DisputeMessagePayload = { type: 'call', reason };
  if (args.peerPubkey) {
    const sk = await getSecretKey(storage);
    payload.peerChatKey = peerChatKeyHex(await derivePeerChatKey(sk, args.peerPubkey, args.track, args.orderId));
  }
  return prepareDisputeMessage(args.orderId, payload, trackTagOf(args.track));
}
