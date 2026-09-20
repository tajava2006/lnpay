/**
 * 에스크로 스크립트 트리 (PLAN-ONCHAIN-TRACK §3.1)
 *
 * 리프 바이트열을 **손으로 적은 기댓값**과 대조한다. 라이브러리 인코더를 그대로
 * 믿고 "인코더가 낸 값 == 인코더가 낸 값"을 확인하면 아무것도 검증하지 않는 것이다.
 * 여기서는 opcode 바이트(0x20 push32 / 0xad CHECKSIGVERIFY / 0xac CHECKSIG /
 * 0xb2 CSV / 0x75 DROP)를 직접 이어붙여 비교한다.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMELOCK_BLOCKS,
  MAX_TIMELOCK_BLOCKS,
  NUMS_INTERNAL_KEY,
  buildEscrowLeaves,
  buildEscrowTree,
  describeLeafScript,
  numsInternalKey,
  numsMatchesLibrary,
} from '../onchain/script';
import { bytesToHex } from '../onchain/hex';

const C = 'a1'.repeat(32);
const S = 'b2'.repeat(32);
const A = 'c3'.repeat(32);
const KEYS = { customer: C, sponsor: S, admin: A };

describe('NUMS 내부키', () => {
  /**
   * 이 상수가 한 글자만 틀려도 전혀 다른 주소가 나오고, 그건 곧 전액 동결이다.
   * BIP-341이 제시한 값이자 라이브러리가 쓰는 값과 같아야 한다.
   */
  it('BIP-341 NUMS 점이고 라이브러리 값과 같다', () => {
    expect(NUMS_INTERNAL_KEY).toBe(
      '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
    );
    expect(numsMatchesLibrary()).toBe(true);
    expect(numsInternalKey()).toHaveLength(32);
  });

  it('호출마다 새 복사본을 준다 (공유 가변 배열 금지)', () => {
    const a = numsInternalKey();
    a[0] = 0xff;
    expect(bytesToHex(numsInternalKey())).toBe(NUMS_INTERNAL_KEY);
  });
});

describe('리프 4개', () => {
  const leaves = buildEscrowLeaves(KEYS);

  it('이름과 순서가 고정돼 있다 (트리 모양 = 주소)', () => {
    expect(leaves.map(l => l.name)).toEqual([
      'release', 'customer-win', 'sponsor-win', 'timelock',
    ]);
  });

  it('release = <C> CHECKSIGVERIFY <S> CHECKSIG', () => {
    expect(bytesToHex(leaves[0]!.script)).toBe(`20${C}ad20${S}ac`);
    expect(leaves[0]!.signers).toEqual(['customer', 'sponsor']);
  });

  it('customer-win = <A> CHECKSIGVERIFY <C> CHECKSIG', () => {
    expect(bytesToHex(leaves[1]!.script)).toBe(`20${A}ad20${C}ac`);
    expect(leaves[1]!.signers).toEqual(['admin', 'customer']);
  });

  it('sponsor-win = <A> CHECKSIGVERIFY <S> CHECKSIG', () => {
    expect(bytesToHex(leaves[2]!.script)).toBe(`20${A}ad20${S}ac`);
    expect(leaves[2]!.signers).toEqual(['admin', 'sponsor']);
  });

  /**
   * 8064 = 0x1f80 → ScriptNum 리틀엔디안 최소 인코딩 `801f`, 2바이트 push(`02`).
   * 타임락 리프의 서명자는 **고객 혼자**다 — 어드민이 증발해도 고객은 되찾는다.
   */
  it('timelock = <8064> CSV DROP <C> CHECKSIG', () => {
    expect(DEFAULT_TIMELOCK_BLOCKS).toBe(8064);
    expect(bytesToHex(leaves[3]!.script)).toBe(`02801fb27520${C}ac`);
    expect(leaves[3]!.signers).toEqual(['customer']);
  });

  it('타임락 블록 수를 바꾸면 스크립트가 따라 바뀐다', () => {
    const custom = buildEscrowLeaves(KEYS, 4032); // 0x0fc0
    expect(bytesToHex(custom[3]!.script)).toBe(`02c00fb27520${C}ac`);
  });

  it('사람이 읽는 형태로 덤프된다 (감사용)', () => {
    expect(describeLeafScript(leaves[0]!.script)).toBe(
      `${C} CHECKSIGVERIFY ${S} CHECKSIG`,
    );
  });
});

describe('입력 검증', () => {
  it('세 키가 겹치면 리프를 만들지 않는다 (공격 H)', () => {
    expect(() => buildEscrowLeaves({ ...KEYS, admin: C })).toThrow(/중복/);
  });

  it('키 형식이 틀리면 막는다', () => {
    expect(() => buildEscrowLeaves({ ...KEYS, sponsor: 'zz'.repeat(32) })).toThrow(/형식 오류/);
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])('타임락 %s 거부', blocks => {
    expect(() => buildEscrowLeaves(KEYS, blocks)).toThrow(/타임락/);
  });

  it('상한은 시퀀스 block-height 모드의 16비트', () => {
    expect(MAX_TIMELOCK_BLOCKS).toBe(0xffff);
    expect(() => buildEscrowLeaves(KEYS, MAX_TIMELOCK_BLOCKS)).not.toThrow();
  });
});

describe('트리 모양', () => {
  it('균형 이진 트리 [[release, customer-win], [sponsor-win, timelock]]', () => {
    const leaves = buildEscrowLeaves(KEYS);
    const tree = buildEscrowTree(leaves);
    expect(tree).toEqual([
      [{ script: leaves[0]!.script }, { script: leaves[1]!.script }],
      [{ script: leaves[2]!.script }, { script: leaves[3]!.script }],
    ]);
  });

  it('리프가 4개가 아니면 거부', () => {
    const leaves = buildEscrowLeaves(KEYS);
    expect(() => buildEscrowTree(leaves.slice(0, 3))).toThrow(/4개/);
  });
});
