/**
 * dispute-message 이벤트 받기 — NIP-44 복호화 → ChatMessage → IDB 저장
 *
 * 복호화는 부르는 쪽이 넣는다(유저 앱은 자기 키로).
 */
import { extractOrderId } from './order-ref';
import { idbUpsertMessage } from './idb';
import type { ChatMessage, DisputeMessagePayload } from './types';

export { extractOrderId };

/** dispute-message 이벤트의 최소 필드 */
export interface DisputeEvent {
  id: string;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at: number;
}

/**
 * dispute-message 이벤트를 복호화하여 ChatMessage로 변환하고 IDB에 저장한다.
 *
 * @param decrypt NIP-44 복호화 함수. (content, senderPubkey, recipientPubkey)를 받는다.
 */
export async function processDisputeEvent(
  event: DisputeEvent,
  orderId: string,
  decrypt: (content: string, senderPubkey: string, recipientPubkey: string) => Promise<string> | string,
): Promise<void> {
  const recipientPubkey = event.tags.find(t => t[0] === 'p' && t[1] !== event.pubkey)?.[1];
  if (!recipientPubkey) return;

  let plaintext: string;
  try {
    plaintext = await decrypt(event.content, event.pubkey, recipientPubkey);
  } catch {
    return;
  }

  let payload: DisputeMessagePayload;
  try {
    payload = JSON.parse(plaintext) as DisputeMessagePayload;
  } catch {
    return;
  }

  const msg: ChatMessage = {
    eventId: event.id,
    orderId,
    senderPubkey: event.pubkey,
    recipientPubkey,
    payload,
    createdAt: event.created_at,
  };

  void idbUpsertMessage(msg).catch(err =>
    console.warn('[IDB] message auto-save failed for', msg.eventId, err),
  );
}
