/**
 * 시드 파생 (DM-005)
 *
 * 프리이미지와 온체인 어드민 키를 **시드 하나에서** 만든다. DB를 잃어도 시드만 있으면 다시 만든다 —
 * 프론트 시절의 키 저장소·프리이미지 백업·병합 코드(그리고 거기서 나온 유실 버그)가 통째로 사라진다.
 *
 * ⚠️ **파생 규칙을 바꾸면 이미 발행한 인보이스와 주소를 다시 못 만든다.** 라벨의 `v1`이 그 약속이다.
 * 바꿔야 하면 새 버전 라벨을 추가하고 옛 것은 남긴다. 고정 벡터 테스트(`derive.test.ts`)가 지킨다.
 */
import { createHash, createHmac } from 'node:crypto';

/** secp256k1 군의 위수 — 개인키는 [1, N) 이어야 한다 */
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function hmac(seed: Uint8Array, label: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', seed).update(label, 'utf8').digest());
}

/**
 * 홀드 인보이스 프리이미지.
 *
 * `scope`는 무엇을 위한 인보이스인지 — 부르는 쪽이 `preimageScope`로 만든다. `attempt`는 같은 목적으로
 * 인보이스를 다시 만들 때 올린다(같은 해시로는 노드가 두 번 안 만든다).
 */
export function derivePreimage(seed: Uint8Array, scope: string, attempt: number): Uint8Array {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error(`attempt는 0 이상의 정수: ${attempt}`);
  return hmac(seed, `lnpay/preimage/v1/${scope}/${attempt}`);
}

export function paymentHashOf(preimage: Uint8Array): string {
  return createHash('sha256').update(preimage).digest('hex');
}

/** 인보이스 목적. 새 목적은 **추가만** 한다 — 기존 문자열을 바꾸면 옛 인보이스를 못 되찾는다 */
export type PreimagePurpose =
  | 'ln-escrow'
  | 'ln-customer-deposit'
  | 'ln-sponsor-deposit'
  | 'oc-customer-bond'
  | 'oc-sponsor-bond';

/**
 * 후원자 보증금은 한 주문에 후보가 여럿일 수 있어(온체인 동시 클레임) 후원자 pubkey까지 넣는다.
 * 구분자 `/`는 orderId·pubkey에 안 나오는 문자다.
 */
export function preimageScope(purpose: PreimagePurpose, orderId: string, party?: string): string {
  if (orderId.includes('/') || party?.includes('/')) throw new Error('scope 구성요소에 / 가 들어갈 수 없다');
  return party ? `${purpose}/${orderId}/${party}` : `${purpose}/${orderId}`;
}

/**
 * payment hash에서 프리이미지를 되찾는다 — DB를 잃었을 때.
 * 시도 번호를 올려가며 맞춰 본다. 못 찾으면 null.
 */
export function recoverPreimage(
  seed: Uint8Array,
  scope: string,
  paymentHash: string,
  maxAttempts = 32,
): { preimage: Uint8Array; attempt: number } | null {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const preimage = derivePreimage(seed, scope, attempt);
    if (paymentHashOf(preimage) === paymentHash) return { preimage, attempt };
  }
  return null;
}

/**
 * 주문별 온체인 어드민 개인키.
 *
 * HMAC 출력이 [1, N) 밖이면(확률 ~2⁻¹²⁸) 카운터를 붙여 다시 뽑는다 — 결정적이다.
 */
export function deriveOnchainAdminKey(seed: Uint8Array, orderId: string): Uint8Array {
  for (let counter = 0; counter < 256; counter++) {
    const candidate = hmac(seed, `lnpay/onchain-admin/v1/${orderId}/${counter}`);
    const k = BigInt('0x' + Buffer.from(candidate).toString('hex'));
    if (k > 0n && k < SECP256K1_N) return candidate;
  }
  throw new Error('어드민 키를 파생하지 못했다'); // 도달하지 않는다
}
