/**
 * 주문별 온체인 키
 *
 * ── 왜 nostr 키를 그대로 안 쓰나
 *
 * nostr 키는 secp256k1이라 비트코인 키로 그냥 쓸 수 있다. **그러면 안 된다.**
 * 오더북의 kind 30402·1111에 각자의 nostr pubkey가 공개로 박히므로, 그 키를
 * taproot에 넣으면 누구나 "이 nostr 계정 = 이 온체인 주소"를 잇고 자금 흐름을
 * 따라간다. non-KYC 거래를 하겠다고 온 사람에게 이건 치명적인 후퇴다.
 *
 * → **주문별로 파생한다.** 신원과 온체인이 끊기고, 주문마다 새 키라 주소
 *   재사용도 없다. nostr 키 하나만 있으면 결정론적으로 복원되므로 **추가
 *   백업 부담이 0**이다 — 이게 BIP-32 대신 HMAC을 쓰는 이유다(체인코드를
 *   따로 보관할 게 없다).
 *
 * ── 어드민 키는 데몬이 만든다
 *
 * 데몬 시드에서 주문마다 파생한다(`daemon/src/derive.ts`, DM-005). 시드를 잃으면 그 주문의 분쟁 중재가
 * 영구 불가다 — `{A,S}`·`{A,C}` 둘 다 서명할 수 없고, 고객이 타임락(8주)으로 회수할 때까지 아무도 못 한다.
 */
import { utils } from '@scure/btc-signer';
import { bytesToHex, isXonlyHex } from './hex';

/** HMAC 메시지 접두사. 바꾸면 **기존 주문의 키가 전부 달라진다** — 버전을 올릴 것. */
export const ORDER_KEY_PREFIX = 'pairbuy-onchain/v1/';

/** secp256k1 군 위수 n. 파생 결과가 [1, n-1] 밖이면 그 키는 못 쓴다. */
const CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** 파생 재시도 상한. 한 번 실패할 확률이 ~2⁻¹²⁸이라 2회면 우주가 끝난다. */
const MAX_DERIVE_ATTEMPTS = 8;

/** 주문별 키 한 벌. `xonly`는 스크립트·오더 태그에 들어가는 공개값이다. */
export interface OrderKey {
  /** 32바이트 비밀키 */
  privkey: Uint8Array;
  /** BIP-340 x-only pubkey (64자 hex) */
  xonly: string;
}

/** 에스크로 스크립트에 들어가는 세 x-only 키 (전부 hex) */
export interface EscrowXonlyKeys {
  customer: string;
  sponsor: string;
  admin: string;
}

export type EscrowRole = keyof EscrowXonlyKeys;

/** 스칼라가 [1, n-1] 안인지. 밖이면 그 바이트열은 비밀키가 될 수 없다. */
export function isValidScalar(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n > 0n && n < CURVE_ORDER;
}

/** 비밀키 → x-only pubkey hex */
export function xonlyFromPrivkey(privkey: Uint8Array): string {
  return bytesToHex(utils.pubSchnorr(privkey));
}

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    // 복사본은 `Uint8Array<ArrayBuffer>`라 DOM·Node 타입 양쪽의 BufferSource에 맞는다 (데몬도 이 파일을 쓴다)
    new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(message));
  return new Uint8Array(mac);
}

/**
 * 고객·후원자의 주문별 키를 nostr 개인키에서 파생한다.
 *
 * ```
 * orderKey = HMAC-SHA256(key = nostrPrivkey, msg = "pairbuy-onchain/v1/" + orderId)
 * ```
 *
 * 결과가 곡선 범위 밖이면(확률 ~2⁻¹²⁸) msg에 `/1`, `/2`를 붙여 재시도한다.
 * **같은 (nostr 키, orderId)는 언제나 같은 결과**여야 한다 — 기기를 바꿔도,
 * 앱을 지웠다 깔아도 같은 주소가 나와야 자금을 되찾을 수 있다.
 */
export async function deriveOrderKey(
  nostrPrivkey: Uint8Array,
  orderId: string,
): Promise<OrderKey> {
  if (nostrPrivkey.length !== 32) {
    throw new Error('deriveOrderKey: nostr 개인키는 32바이트여야 한다');
  }
  if (!orderId) {
    throw new Error('deriveOrderKey: orderId가 비어 있다');
  }

  for (let attempt = 0; attempt < MAX_DERIVE_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? '' : `/${attempt}`;
    const privkey = await hmacSha256(nostrPrivkey, `${ORDER_KEY_PREFIX}${orderId}${suffix}`);
    if (isValidScalar(privkey)) {
      return { privkey, xonly: xonlyFromPrivkey(privkey) };
    }
  }
  // 여기 도달하면 HMAC이 고장 난 것이다. 조용히 넘기면 안 된다.
  throw new Error('deriveOrderKey: 유효한 스칼라를 얻지 못했다');
}

/**
 * 세 키가 서로 다른지 — 같으면 **2-of-3 보장 자체가 사라진다** (T-108).
 *
 * `{A,S}` 리프는 두 키가 **다른 주체**에 있다는 전제 위에 있다. 한 사람이 둘을
 * 쥐면 그 리프는 단독 서명이 되고, 그 순간 에스크로가 아니라 그냥 그 사람 돈이다.
 * 실수로 같아지는 경로가 실재한다 — 테스트하다 한 키로 양쪽을 돌린다든지,
 * 자기 의뢰를 자기가 클레임한다든지.
 *
 * x-only로 비교하는 게 맞다. 서로 다른 비밀키 k와 n−k가 **같은 x-only**를 내므로,
 * 비밀키를 비교하면 그 경우를 놓친다. 체인이 보는 건 x-only다.
 *
 * @returns 겹치는 역할 쌍. 전부 다르면 `null`.
 */
export function findDuplicateEscrowKey(
  keys: EscrowXonlyKeys,
): readonly [EscrowRole, EscrowRole] | null {
  const roles: readonly EscrowRole[] = ['customer', 'sponsor', 'admin'];
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const a = roles[i]!;
      const b = roles[j]!;
      if (keys[a] === keys[b]) return [a, b];
    }
  }
  return null;
}

/**
 * 주소 파생 직전 게이트. 형식이 틀렸거나 세 키가 겹치면 **진행을 막는다**.
 * 클라이언트와 어드민 **양쪽**에서 부른다 — 한쪽만 검사하면 그쪽이 악의적일 때 뚫린다.
 */
export function assertEscrowKeys(keys: EscrowXonlyKeys): void {
  for (const role of ['customer', 'sponsor', 'admin'] as const) {
    if (!isXonlyHex(keys[role])) {
      throw new Error(`에스크로 키 형식 오류: ${role} (x-only 64자 hex가 아니다)`);
    }
  }
  const dup = findDuplicateEscrowKey(keys);
  if (dup) {
    throw new Error(
      `에스크로 키 중복: ${dup[0]} = ${dup[1]}. 2-of-3 보장이 깨지므로 진행할 수 없다`,
    );
  }
}
