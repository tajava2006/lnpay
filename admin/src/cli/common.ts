/**
 * Admin CLI 공통 유틸리티
 */
import WebSocket from 'ws';
// @ts-expect-error Node.js에 WebSocket이 없으므로 ws 패키지로 폴리필
globalThis.WebSocket = WebSocket;

import { SimplePool } from 'nostr-tools/pool';
import { APP_PUBKEY, DISCOVERY_RELAYS, FALLBACK_RELAYS } from '@sajwo-tracker/shared';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * 테스트용 하드코딩 privkey (보안 불필요)
 */
const TEST_SECRET_KEY_HEX = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
export const TEST_SECRET_KEY = hexToBytes(TEST_SECRET_KEY_HEX);

/** NIP-65에서 앱 read relay를 조회. 실패 시 폴백. */
export async function getRelays(): Promise<string[]> {
  const pool = new SimplePool();
  try {
    const event = await pool.get(DISCOVERY_RELAYS, {
      kinds: [10002],
      authors: [APP_PUBKEY],
    });

    if (!event) return FALLBACK_RELAYS;

    const readRelays = event.tags
      .filter((tag): tag is [string, string, ...string[]] =>
        tag[0] === 'r' && typeof tag[1] === 'string'
      )
      .filter(tag => !tag[2] || tag[2] === 'read')
      .map(tag => tag[1]);

    return readRelays.length > 0 ? readRelays : FALLBACK_RELAYS;
  } catch {
    return FALLBACK_RELAYS;
  } finally {
    pool.destroy();
  }
}

/** min이상 max이하 랜덤 정수 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
