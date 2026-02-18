/**
 * NIP-78 LN 노드 설정 암호화 저장/복원
 *
 * kind 30078 (Arbitrary Custom App Data) addressable event에
 * NIP-44로 암호화된 LN 설정을 저장하고 구독으로 불러온다.
 *
 * d-tag = CLIENT_TAG (dev/prod 격리)
 * author = APP_PUBKEY
 * content = nip44Encrypt(APP_PUBKEY, JSON.stringify(LnConfig))
 */
import { SimplePool } from 'nostr-tools/pool';
import type { Event, EventTemplate } from 'nostr-tools/core';
import { APP_PUBKEY, CLIENT_TAG, getWriteRelays } from '@sajwo-tracker/shared';
import { getSigner } from './nip46';
import { storage } from './storage';

const APP_DATA_KIND = 30078;

export interface LnConfig {
  backend: 'lnd' | 'cln';
  baseUrl: string;
  credential: string;
}

/**
 * LN 설정을 NIP-44로 암호화하여 쓰기 릴레이에 NIP-78 이벤트로 발행한다.
 */
export async function publishLnConfig(config: LnConfig): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const plaintext = JSON.stringify(config);
  const ciphertext = await signer.nip44Encrypt(APP_PUBKEY, plaintext);

  const template: EventTemplate = {
    kind: APP_DATA_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', CLIENT_TAG]],
    content: ciphertext,
  };

  const signed = await signer.signEvent(template);

  const writeRelays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(writeRelays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('모든 릴레이에 발행 실패');
    console.log('[LnConfig] Published encrypted config to', writeRelays.length, 'write relays');
  } finally {
    pool.destroy();
  }
}

/**
 * 읽기 릴레이에서 NIP-78 LN 설정 이벤트를 구독한다.
 * 로그인 전에도 호출 가능 — 암호화된 content만 전달한다.
 *
 * @returns cleanup 함수
 */
export function subscribeLnConfig(
  relays: string[],
  onEvent: (event: Event) => void,
): () => void {
  const pool = new SimplePool();

  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [APP_DATA_KIND],
      authors: [APP_PUBKEY],
      '#d': [CLIENT_TAG],
    },
    {
      onevent: (event) => {
        onEvent(event);
      },
      oneose: () => {
        console.log('[LnConfig] EOSE — initial sync complete');
      },
    },
  );

  console.log('[LnConfig] Subscribed on', relays.length, 'relays');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[LnConfig] Subscription closed');
  };
}

/**
 * 암호화된 NIP-78 이벤트 content를 복호화하여 LnConfig를 반환한다.
 */
export async function decryptLnConfig(encryptedContent: string): Promise<LnConfig> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const plaintext = await signer.nip44Decrypt(APP_PUBKEY, encryptedContent);
  const parsed: unknown = JSON.parse(plaintext);

  if (!isLnConfig(parsed)) {
    throw new Error('복호화된 데이터가 LnConfig 형식이 아님');
  }

  return parsed;
}

function isLnConfig(value: unknown): value is LnConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj.backend === 'lnd' || obj.backend === 'cln') &&
    typeof obj.baseUrl === 'string' &&
    typeof obj.credential === 'string'
  );
}
