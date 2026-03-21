/**
 * Hold invoice 프리이미지 릴레이 백업/복원
 *
 * NIP-78 (kind 30078) addressable event에 NIP-44로 암호화된
 * 프리이미지 맵을 저장한다. ln-config.ts와 동일한 패턴.
 *
 * d-tag = `escrow:${CLIENT_TAG}` (LN config과 구분)
 * author = APP_PUBKEY
 * content = nip44Encrypt(APP_PUBKEY, JSON.stringify(EscrowMap))
 *
 * 브라우저 localStorage가 초기화되더라도 릴레이에서 복원 가능.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import { APP_PUBKEY, CLIENT_TAG, getWriteRelays, storage } from '@sajwo-tracker/shared';
import { getSigner } from './nip46';
import type { EscrowEntry } from '../escrow-store';

const APP_DATA_KIND = 30078;
const D_TAG = `escrow:${CLIENT_TAG}`;

type EscrowMap = Record<string, EscrowEntry>;

/**
 * 전체 에스크로 맵을 NIP-44로 암호화하여 쓰기 릴레이에 발행한다.
 * addressable event이므로 동일 d-tag의 이전 이벤트를 대체한다.
 */
export async function publishEscrowBackup(entries: EscrowMap): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('escrow-backup: signer 없음');

  const plaintext = JSON.stringify(entries);
  const ciphertext = await signer.nip44Encrypt(APP_PUBKEY, plaintext);

  const template: EventTemplate = {
    kind: APP_DATA_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', D_TAG]],
    content: ciphertext,
  };

  const signed = await signer.signEvent(template);

  const writeRelays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(writeRelays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('모든 릴레이에 발행 실패');
    console.log('[EscrowBackup] Published encrypted backup to', writeRelays.length, 'write relays');
  } finally {
    pool.destroy();
  }
}

/**
 * 쓰기 릴레이에서 에스크로 백업을 조회하여 복호화한다.
 * 로컬 캐시가 비어있을 때 복원용으로 호출한다.
 *
 * @returns 복호화된 에스크로 맵. 없으면 빈 객체.
 */
export async function fetchEscrowBackup(): Promise<EscrowMap> {
  const signer = getSigner();
  if (!signer) return {};

  const writeRelays = await getWriteRelays(storage);
  const pool = new SimplePool();

  try {
    const event = await pool.get(writeRelays, {
      kinds: [APP_DATA_KIND],
      authors: [APP_PUBKEY],
      '#d': [D_TAG],
    });

    if (!event?.content) return {};

    const plaintext = await signer.nip44Decrypt(APP_PUBKEY, event.content);
    const parsed: unknown = JSON.parse(plaintext);

    if (typeof parsed !== 'object' || parsed === null) return {};

    // 각 엔트리 검증
    const result: EscrowMap = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEscrowEntry(val)) {
        result[key] = val;
      }
    }

    console.log('[EscrowBackup] Restored', Object.keys(result).length, 'entries from relay');
    return result;
  } catch (e) {
    console.warn('[EscrowBackup] Failed to fetch/decrypt backup:', e);
    return {};
  } finally {
    pool.destroy();
  }
}

function isEscrowEntry(value: unknown): value is EscrowEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.preimage === 'string' &&
    typeof obj.paymentHash === 'string' &&
    typeof obj.createdAt === 'number'
  );
}
