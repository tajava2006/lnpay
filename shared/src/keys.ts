import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { STORAGE_KEYS } from './constants';
import type { StorageAdapter, NostrKeypair } from './types';

/**
 * 유저의 Nostr 키페어를 가져오거나, 없으면 새로 생성한다.
 * 최초 1회만 생성되며, 이후 영구저장소에서 불러온다.
 */
export async function ensureKeypair(storage: StorageAdapter): Promise<NostrKeypair> {
  const existing = await storage.get<NostrKeypair>(STORAGE_KEYS.KEYPAIR);

  if (existing?.secretKey && existing?.publicKey) {
    return existing;
  }

  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  const keypair: NostrKeypair = {
    secretKey: Array.from(sk),
    publicKey: pk,
  };

  await storage.set(STORAGE_KEYS.KEYPAIR, keypair);
  console.log('[Nostr] New keypair generated, pubkey:', pk);

  return keypair;
}

/** 서명용 secret key (Uint8Array) 반환 */
export async function getSecretKey(storage: StorageAdapter): Promise<Uint8Array> {
  const keypair = await ensureKeypair(storage);
  return new Uint8Array(keypair.secretKey);
}

/** 유저의 public key (hex string) 반환 */
export async function getUserPubkey(storage: StorageAdapter): Promise<string> {
  const keypair = await ensureKeypair(storage);
  return keypair.publicKey;
}
