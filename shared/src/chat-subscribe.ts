/**
 * 분쟁 채팅 on-demand 구독
 *
 * 오더 디테일 페이지 진입 시 생성, 이탈 시 해제.
 * kind 1111 + action='dispute-message' 필터로 해당 오더의 채팅만 수신.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import {
  SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND,
  APP_PUBKEY,
  CLIENT_TAG,
  REQUEST_ACTIONS,
} from './constants';
import { getSecretKey, getUserPubkey } from './keys';
import { getReadRelays } from './relays';
import { nip44Decrypt } from './crypto';
import { storage } from './storage';
import type { ChatMessage, DisputeMessagePayload } from './types';

/**
 * 특정 오더의 dispute-message를 실시간 구독한다.
 *
 * NIP-44 복호화 (고객·후원자 공용):
 * - 자기 참여 메시지만 처리 (발신 or 수신)
 * - ECDH 대칭성으로 항상 APP_PUBKEY를 remote pubkey로 사용
 */
export async function subscribeChatMessages(
  orderId: string,
  onMessage: (msg: ChatMessage) => void,
): Promise<() => void> {
  const [sk, relays, myPubkey] = await Promise.all([
    getSecretKey(storage),
    getReadRelays(storage),
    getUserPubkey(storage),
  ]);

  const aCoord = `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`;

  const pool = new SimplePool();
  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_EVENT_KIND],
      '#a': [aCoord],
      '#p': [myPubkey],
      '#t': [CLIENT_TAG],
    },
    {
      onevent: (event: Event) => {
        const action = event.tags.find(t => t[0] === 'action')?.[1];
        if (action !== REQUEST_ACTIONS.DISPUTE_MESSAGE) return;

        const recipientPubkey = event.tags.find(t => t[0] === 'p' && t[1] !== event.pubkey)?.[1];
        if (!recipientPubkey) return;

        let plaintext: string;
        try {
          // ECDH 대칭성: my_sk * APP_PUBKEY === admin_sk * my_pubkey
          plaintext = nip44Decrypt(event.content, sk, APP_PUBKEY);
        } catch {
          return;
        }

        let payload: DisputeMessagePayload;
        try {
          payload = JSON.parse(plaintext) as DisputeMessagePayload;
        } catch {
          return;
        }

        onMessage({
          eventId: event.id,
          orderId,
          senderPubkey: event.pubkey,
          recipientPubkey,
          payload,
          createdAt: event.created_at,
        });
      },
    },
  );

  return () => {
    sub.close();
    pool.destroy();
  };
}
