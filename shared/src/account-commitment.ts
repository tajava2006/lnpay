/**
 * 계좌정보 커밋먼트 (솔티드)
 *
 * 고객은 계좌정보를 후원자에게 NIP-44로 암호화해 보내면서, 같은 이벤트의 공개 태그에
 * 커밋먼트를 남긴다. 분쟁 시 후원자가 "받은 계좌"를 공개하면 Admin이 이 커밋먼트와
 * 대조해, 후원자가 나중에 다른 계좌를 주장할 수 없게 만든다.
 *
 * ── 왜 솔트가 필요한가
 *
 * 커밋먼트는 공개 태그다. 솔트가 없으면 `sha256(JSON.stringify(accountInfo))`인데
 * 원상 공간이 매우 작다 — 한국 은행 ~20개, 계좌번호는 은행별 고정 포맷이라 자릿수보다
 * 엔트로피가 훨씬 낮고, 예금주는 한글 2~3자다. 은행과 예금주를 아는 공격자라면 GPU로
 * 수 분~수 시간이면 계좌번호를 복원한다. 즉 같은 이벤트에 실린 NIP-44 암호문이
 * 무의미해진다(감사 2026-09-13 A-1).
 *
 * 32바이트 랜덤 솔트를 앞에 붙이면 사전 공격이 불가능해지고, 구속력은 그대로다 —
 * 솔트는 암호문 안에 들어가 후원자만 알고, 분쟁 때 계좌정보와 함께 공개된다.
 *
 * ── 공식은 반드시 여기 한 곳에만
 *
 * 고객이 만들고 Admin이 검증하므로 양쪽이 같은 공식을 써야 한다. 예전에는
 * publish.ts와 CommitmentBadge.tsx에 각각 흩어져 있었다.
 */
import { sha256Hex } from './crypto';
import type { AccountInfo } from './types';

/** 계좌정보 + 솔트. NIP-44 암호문 안에 이 모양으로 들어간다. */
export interface AccountInfoEnvelope {
  accountInfo: AccountInfo;
  /** 32바이트 랜덤 솔트 (hex 64자) */
  salt: string;
}

/** 커밋먼트용 랜덤 솔트를 생성한다. */
export function generateCommitmentSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 커밋먼트를 계산한다.
 *
 * @param salt 없으면 레거시(무솔트) 방식으로 계산한다 — 솔트 도입 이전에 발행된
 *             기록을 계속 검증하기 위해서다. 새로 발행할 때는 반드시 솔트를 넘긴다.
 */
export function computeAccountCommitment(
  accountInfo: AccountInfo,
  salt?: string,
): Promise<string> {
  const plaintext = JSON.stringify(accountInfo);
  return sha256Hex(salt ? salt + plaintext : plaintext);
}

/**
 * 공개된 계좌정보가 커밋먼트와 맞는지 검증한다.
 *
 * 솔트가 없는 옛 기록도 통과시킨다. 커밋먼트는 발행 시점에 고정된 값이라
 * 레거시 폴백이 새 발행분의 보안을 낮추지 않는다.
 */
export async function verifyAccountCommitment(
  accountInfo: AccountInfo,
  commitment: string,
  salt?: string,
): Promise<boolean> {
  return (await computeAccountCommitment(accountInfo, salt)) === commitment;
}

/**
 * 암호문을 복호화한 평문을 봉투로 해석한다.
 *
 * 솔트 도입 전에는 `AccountInfo`가 그대로 들어 있었으므로 두 모양을 모두 받는다.
 */
export function parseAccountInfoEnvelope(plaintext: string): AccountInfoEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  // 신형: { accountInfo, salt }
  if (typeof obj.accountInfo === 'object' && obj.accountInfo !== null) {
    return {
      accountInfo: obj.accountInfo as AccountInfo,
      salt: typeof obj.salt === 'string' ? obj.salt : '',
    };
  }

  // 구형: AccountInfo 그 자체 (솔트 없음)
  if (typeof obj.accountNumber === 'string') {
    return { accountInfo: obj as unknown as AccountInfo, salt: '' };
  }

  return null;
}
