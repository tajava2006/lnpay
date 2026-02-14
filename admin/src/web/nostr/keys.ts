/**
 * 어드민 키 검증
 *
 * .env의 VITE_APP_SECRET_KEY가 유효한 32바이트 hex이고,
 * APP_PUBKEY와 매칭되는지 검증한다.
 */
import { getPublicKey } from 'nostr-tools/pure';
import { APP_PUBKEY } from '@sajwo-tracker/shared';

export type KeyValidation =
  | { valid: true; secretKey: Uint8Array }
  | { valid: false; reason: string };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function validateAdminKey(): KeyValidation {
  const raw = import.meta.env.VITE_APP_SECRET_KEY;

  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return { valid: false, reason: 'VITE_APP_SECRET_KEY가 설정되지 않았습니다.' };
  }

  const hex = raw.trim();

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return {
      valid: false,
      reason: `VITE_APP_SECRET_KEY가 유효한 형식이 아닙니다. 32바이트(64자) hex 문자열이어야 합니다. (현재 ${hex.length}자)`,
    };
  }

  const sk = hexToBytes(hex);

  try {
    const derivedPubkey = getPublicKey(sk);
    if (derivedPubkey !== APP_PUBKEY) {
      return {
        valid: false,
        reason: `제공된 키에서 도출된 pubkey가 APP_PUBKEY와 일치하지 않습니다.\n도출: ${derivedPubkey}\n기대: ${APP_PUBKEY}`,
      };
    }
    return { valid: true, secretKey: sk };
  } catch {
    return { valid: false, reason: '키에서 pubkey를 도출하는 데 실패했습니다.' };
  }
}
