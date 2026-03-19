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
  getReadRelays,
  type ChatMessage,
  type DisputeMessagePayload,
  storage,
} from '@sajwo-tracker/shared';
import { getSigner } from './nip46';

/**
 * 특정 오더의 dispute-message를 실시간 구독한다.
 *
 * Admin NIP-44 복호화:
 * - 상대방 발신: signer.nip44Decrypt(event.pubkey, ciphertext)
 * - 자기 발신 에코: signer.nip44Decrypt(recipientPubkey, ciphertext)
 *   (NIP-44 conversation key는 대칭이므로 원래 수신자 pubkey 사용)
 */
export async function subscribeChatMessages(
  orderId: string,
  onMessage: (msg: ChatMessage) => void,
): Promise<() => void> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const relays = await getReadRelays(storage);
  const aCoord = `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`;

  const pool = new SimplePool();
  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_EVENT_KIND],
      '#a': [aCoord],
      '#p': [APP_PUBKEY],
      '#t': [CLIENT_TAG],
    },
    {
      onevent: (event: Event) => {
        const action = event.tags.find(t => t[0] === 'action')?.[1];
        if (action !== REQUEST_ACTIONS.DISPUTE_MESSAGE) return;
        void handleEvent(event);
      },
    },
  );

  async function handleEvent(event: Event): Promise<void> {
    const recipientPubkey = event.tags.find(t => t[0] === 'p' && t[1] !== event.pubkey)?.[1];
    if (!recipientPubkey) return;

    let plaintext: string;
    try {
      // NIP-44 conversation key는 대칭 — 복호화 시 상대방 pubkey 필요
      const remotePubkey = event.pubkey === APP_PUBKEY
        ? recipientPubkey  // 자기 발신 에코: 원래 수신자 pubkey
        : event.pubkey;    // 상대방 발신: 발신자 pubkey
      plaintext = await signer!.nip44Decrypt(remotePubkey, event.content);
    } catch (e) {
      console.warn('[Admin] Chat decrypt failed for event', event.id, e);
      return;
    }

    let payload: DisputeMessagePayload;
    try {
      payload = JSON.parse(plaintext) as DisputeMessagePayload;
    } catch {
      console.warn('[Admin] Chat JSON parse failed for event', event.id);
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
  }

  console.log('[Admin] Chat subscribed for order', orderId);

  return () => {
    sub.close();
    pool.destroy();
  };
}
