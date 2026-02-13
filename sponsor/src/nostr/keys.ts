import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { STORAGE_KEYS } from './constants';

export interface NostrKeypair {
  secretKey: number[];
  publicKey: string;
}

/**
 * 유저의 Nostr 키페어를 가져오거나, 없으면 새로 생성한다.
 * 최초 접속 시 1회 생성되며, 이후 localStorage에서 불러온다.
 */
export function ensureKeypair(): NostrKeypair {
  const stored = localStorage.getItem(STORAGE_KEYS.KEYPAIR);

  if (stored) {
    try {
      const parsed = JSON.parse(stored) as NostrKeypair;
      if (parsed.secretKey && parsed.publicKey) {
        return parsed;
      }
    } catch {
      // 파싱 실패 시 새로 생성
    }
  }

  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  const keypair: NostrKeypair = {
    secretKey: Array.from(sk),
    publicKey: pk,
  };

  localStorage.setItem(STORAGE_KEYS.KEYPAIR, JSON.stringify(keypair));
  console.log('[Nostr] New keypair generated, pubkey:', pk);

  return keypair;
}

/** 서명용 secret key (Uint8Array) 반환 */
export function getSecretKey(): Uint8Array {
  const keypair = ensureKeypair();
  return new Uint8Array(keypair.secretKey);
}

/** 유저의 public key (hex string) 반환 */
export function getUserPubkey(): string {
  const keypair = ensureKeypair();
  return keypair.publicKey;
}
