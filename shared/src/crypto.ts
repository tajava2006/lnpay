/**
 * NIP-44 암호화/복호화 + SHA-256 해시 유틸리티
 *
 * Customer/Sponsor가 자체 개인키로 직접 NIP-44를 사용한다.
 * (Admin은 NIP-46 BunkerSigner 경유이므로 이 유틸리티 사용 불가)
 */
import { v2 } from 'nostr-tools/nip44';

/** NIP-44 암호화 (발신자 개인키 + 수신자 공개키) */
export function nip44Encrypt(
  plaintext: string,
  senderPrivkey: Uint8Array,
  recipientPubkey: string,
): string {
  const conversationKey = v2.utils.getConversationKey(senderPrivkey, recipientPubkey);
  return v2.encrypt(plaintext, conversationKey);
}

/** NIP-44 복호화 (수신자 개인키 + 발신자 공개키) */
export function nip44Decrypt(
  ciphertext: string,
  receiverPrivkey: Uint8Array,
  senderPubkey: string,
): string {
  const conversationKey = v2.utils.getConversationKey(receiverPrivkey, senderPubkey);
  return v2.decrypt(ciphertext, conversationKey);
}

/** SHA-256 해시 (commitment용) — hex 반환 */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
