import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  generateCommitmentSalt,
  computeAccountCommitment,
  verifyAccountCommitment,
  parseAccountInfoEnvelope,
} from '../index';
import type { AccountInfo } from '../index';

const ACCOUNT: AccountInfo = { bankName: '국민', accountNumber: '123456-01-789012', holderName: '홍길동' };

describe('sha256Hex', () => {
  it('같은 입력은 항상 같은 해시', async () => {
    const input = JSON.stringify(ACCOUNT);
    expect(await sha256Hex(input)).toBe(await sha256Hex(input));
  });

  it('hex 문자열 반환 (64자)', async () => {
    expect(await sha256Hex('test')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateCommitmentSalt', () => {
  it('32바이트 hex를 돌려준다', () => {
    expect(generateCommitmentSalt()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('호출마다 다르다', () => {
    const salts = new Set(Array.from({ length: 50 }, () => generateCommitmentSalt()));
    expect(salts.size).toBe(50);
  });
});

describe('계좌정보 커밋먼트 (솔티드)', () => {
  it('같은 계좌+같은 솔트는 같은 커밋먼트', async () => {
    const salt = generateCommitmentSalt();
    expect(await computeAccountCommitment(ACCOUNT, salt))
      .toBe(await computeAccountCommitment(ACCOUNT, salt));
  });

  // 솔트의 존재 이유. 같은 계좌라도 커밋먼트가 매번 달라야 릴레이 관찰자가
  // 사전을 만들어 두고 대조하는 공격이 불가능해진다.
  it('같은 계좌라도 솔트가 다르면 커밋먼트가 다르다', async () => {
    const a = await computeAccountCommitment(ACCOUNT, generateCommitmentSalt());
    const b = await computeAccountCommitment(ACCOUNT, generateCommitmentSalt());
    expect(a).not.toBe(b);
  });

  it('솔트를 알아도 계좌가 다르면 불일치 — 구속력은 그대로', async () => {
    const salt = generateCommitmentSalt();
    const commitment = await computeAccountCommitment(ACCOUNT, salt);

    const tampered: AccountInfo = { ...ACCOUNT, accountNumber: '123456-01-789013' };
    expect(await verifyAccountCommitment(tampered, commitment, salt)).toBe(false);
  });

  it('올바른 계좌+솔트면 검증 통과', async () => {
    const salt = generateCommitmentSalt();
    const commitment = await computeAccountCommitment(ACCOUNT, salt);
    expect(await verifyAccountCommitment(ACCOUNT, commitment, salt)).toBe(true);
  });

  it('솔트가 빠지면 검증 실패 — 솔티드 커밋먼트는 솔트 없이 못 연다', async () => {
    const salt = generateCommitmentSalt();
    const commitment = await computeAccountCommitment(ACCOUNT, salt);
    expect(await verifyAccountCommitment(ACCOUNT, commitment)).toBe(false);
  });

  it('틀린 솔트면 검증 실패', async () => {
    const commitment = await computeAccountCommitment(ACCOUNT, generateCommitmentSalt());
    expect(await verifyAccountCommitment(ACCOUNT, commitment, generateCommitmentSalt())).toBe(false);
  });
});

describe('레거시 무솔트 기록', () => {
  // 솔트 도입 이전에 발행된 커밋먼트도 계속 검증돼야 한다.
  // 커밋먼트는 발행 시점에 고정된 값이라 이 폴백이 새 발행분의 보안을 낮추지 않는다.
  it('솔트 없이 만든 커밋먼트는 솔트 없이 검증된다', async () => {
    const legacy = await sha256Hex(JSON.stringify(ACCOUNT));
    expect(await computeAccountCommitment(ACCOUNT)).toBe(legacy);
    expect(await verifyAccountCommitment(ACCOUNT, legacy)).toBe(true);
  });

  it('레거시 커밋먼트도 계좌가 다르면 불일치', async () => {
    const legacy = await sha256Hex(JSON.stringify(ACCOUNT));
    const tampered: AccountInfo = { ...ACCOUNT, holderName: '김철수' };
    expect(await verifyAccountCommitment(tampered, legacy)).toBe(false);
  });
});

describe('parseAccountInfoEnvelope', () => {
  it('신형 봉투를 읽는다', () => {
    const salt = generateCommitmentSalt();
    const parsed = parseAccountInfoEnvelope(JSON.stringify({ accountInfo: ACCOUNT, salt }));
    expect(parsed).toEqual({ accountInfo: ACCOUNT, salt });
  });

  // 솔트 도입 전 암호문은 AccountInfo가 그대로 들어 있었다.
  it('구형 평문(AccountInfo 그 자체)도 읽고 솔트는 빈 문자열', () => {
    const parsed = parseAccountInfoEnvelope(JSON.stringify(ACCOUNT));
    expect(parsed).toEqual({ accountInfo: ACCOUNT, salt: '' });
  });

  it('JSON이 아니거나 모양이 다르면 null', () => {
    expect(parseAccountInfoEnvelope('not json')).toBeNull();
    expect(parseAccountInfoEnvelope(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(parseAccountInfoEnvelope(JSON.stringify(null))).toBeNull();
  });
});
