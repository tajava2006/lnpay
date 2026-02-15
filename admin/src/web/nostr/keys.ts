/**
 * 어드민 키 검증
 *
 * Vite dev 서버의 /__admin_config 엔드포인트에서 키를 받아와
 * APP_PUBKEY와 매칭되는지 검증한다.
 * 프로덕션 빌드에는 이 엔드포인트가 없으므로 키에 접근할 수 없다.
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

export async function validateAdminKey(): Promise<KeyValidation> {
  let raw: string;
  try {
    const res = await fetch('/__admin_config');
    if (!res.ok) {
      return { valid: false, reason: '개발 서버에서 키를 불러올 수 없습니다. pnpm dev:admin으로 실행해 주세요.' };
    }
    const data: { secretKey: string } = await res.json();
    raw = data.secretKey;
  } catch {
    return { valid: false, reason: '개발 서버에서 키를 불러올 수 없습니다. pnpm dev:admin으로 실행해 주세요.' };
  }

  if (!raw || raw.trim() === '') {
    return { valid: false, reason: 'APP_SECRET_KEY가 설정되지 않았습니다.' };
  }

  const hex = raw.trim();

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return {
      valid: false,
      reason: `APP_SECRET_KEY가 유효한 형식이 아닙니다. 32바이트(64자) hex 문자열이어야 합니다. (현재 ${hex.length}자)`,
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
