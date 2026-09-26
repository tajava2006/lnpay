/**
 * 분쟁 채팅 메시지 (유저 → 데몬) — 두 트랙·두 역할 공용
 *
 * 서명까지만 하고 발행은 호출부가 돌린다(`shared/chat-send`). 서명을 먼저 해야 발행 전에 eventId가 정해져
 * 낙관적으로 넣은 메시지와 릴레이 에코가 중복되지 않는다. 받는 쪽은 언제나 APP(데몬이 운영자에게 중계).
 * 분쟁 증거는 보존해야 하므로 `expiration`을 달지 않는다.
 */
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import {
  APP_PUBKEY, REQUEST_ACTIONS, MESSAGE_KIND, ORDER_KIND, getReadRelays, getSecretKey, nip44Encrypt,
  nowSec, storage, type DisputeMessagePayload, type PreparedChatMessage,
} from '@sajwo-tracker/shared';

export async function prepareDisputeMessage(
  orderId: string,
  payload: DisputeMessagePayload,
  /** 트랙 태그 — `CLIENT_TAG` 또는 `CLIENT_TAG_ONCHAIN` */
  trackTag: string,
): Promise<PreparedChatMessage> {
  const sk = await getSecretKey(storage);
  const myPubkey = getPublicKey(sk);
  const createdAt = nowSec();
  const signed = finalizeEvent({
    kind: MESSAGE_KIND,
    created_at: createdAt,
    tags: [
      ['a', `${ORDER_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE],
      ['t', trackTag],
      ['p', APP_PUBKEY],
      ['p', myPubkey],
    ],
    content: nip44Encrypt(JSON.stringify(payload), sk, APP_PUBKEY),
  }, sk);

  return {
    message: { eventId: signed.id, orderId, senderPubkey: myPubkey, recipientPubkey: APP_PUBKEY, payload, createdAt },
    publish: async () => {
      const relays = await getReadRelays(storage);
      const pool = new SimplePool();
      try {
        const results = await Promise.allSettled(pool.publish(relays, signed));
        return results.some(r => r.status === 'fulfilled');
      } finally {
        pool.destroy();
      }
    },
  };
}
