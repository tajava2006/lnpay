import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { STORAGE_KEYS } from './constants';
import type { NostrKeypair } from '../shared/types';

/**
 * 유저의 Nostr 키페어를 가져오거나, 없으면 새로 생성한다.
 * 설치 후 최초 1회만 생성되며, 이후 chrome.storage.local에서 불러온다.
 */
export async function ensureKeypair(): Promise<NostrKeypair> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.KEYPAIR);
  const existing = result[STORAGE_KEYS.KEYPAIR] as NostrKeypair | undefined;

  if (existing?.secretKey && existing?.publicKey) {
    return existing;
  }

  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  const keypair: NostrKeypair = {
    secretKey: Array.from(sk),
    publicKey: pk,
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.KEYPAIR]: keypair });
  console.log('[Nostr] New keypair generated, pubkey:', pk);

  return keypair;
}

/** 서명용 secret key (Uint8Array) 반환 */
export async function getSecretKey(): Promise<Uint8Array> {
  const keypair = await ensureKeypair();
  return new Uint8Array(keypair.secretKey);
}

/** 유저의 public key (hex string) 반환 */
export async function getUserPubkey(): Promise<string> {
  const keypair = await ensureKeypair();
  return keypair.publicKey;
}
