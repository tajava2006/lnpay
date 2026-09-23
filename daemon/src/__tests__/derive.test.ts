/**
 * 시드 파생 (DM-005)
 *
 * ⚠️ **고정 벡터는 절대 고치지 않는다.** 이 값이 바뀌었다면 파생 규칙이 바뀐 것이고, 그러면 이미
 * 발행한 인보이스의 프리이미지와 이미 만든 에스크로 주소의 어드민 키를 **다시 못 만든다.** 규칙을
 * 바꿔야 하면 새 버전 라벨을 추가하고 이 테스트는 그대로 둔다.
 */
import { describe, expect, it } from 'vitest';
import {
  derivePreimage, deriveOnchainAdminKey, paymentHashOf, preimageScope, recoverPreimage,
} from '../derive';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const SEED = new Uint8Array(32).fill(1);
const SPONSOR = 'ab'.repeat(32);

describe('고정 벡터 — 바뀌면 옛 인보이스·주소를 못 되찾는다', () => {
  it('프리이미지', () => {
    const p = derivePreimage(SEED, preimageScope('ln-escrow', 'o-1'), 0);
    expect(hex(p)).toBe('32489b607da63410fd0823a349962f1ea4574108e8d6de1d9fa5066ea8b59787');
    expect(paymentHashOf(p)).toBe('40b1bcc1427260438a1c5c58f7a5abf87c0be38d11f214db3b369e0324ba7da1');
  });

  it('후원자별 보증금 프리이미지', () => {
    const p = derivePreimage(SEED, preimageScope('oc-sponsor-bond', 'o-1', SPONSOR), 2);
    expect(hex(p)).toBe('4045f5afdf43eaddbebf67df4867e3a889f97135518188499019c906905b3dc1');
  });

  it('온체인 어드민 키', () => {
    expect(hex(deriveOnchainAdminKey(SEED, 'o-1'))).toBe('86f925dc58430bb5b3cb0f9bb5af33290cdaf55889ad3befd7d35e2b6cf95d29');
  });
});

describe('파생 성질', () => {
  it('목적·주문·시도·후원자 중 하나만 달라도 다르다', () => {
    const base = hex(derivePreimage(SEED, preimageScope('ln-escrow', 'o-1'), 0));
    expect(hex(derivePreimage(SEED, preimageScope('ln-escrow', 'o-2'), 0))).not.toBe(base);
    expect(hex(derivePreimage(SEED, preimageScope('ln-escrow', 'o-1'), 1))).not.toBe(base);
    expect(hex(derivePreimage(SEED, preimageScope('ln-customer-deposit', 'o-1'), 0))).not.toBe(base);
    expect(hex(derivePreimage(SEED, preimageScope('oc-sponsor-bond', 'o-1', SPONSOR), 0)))
      .not.toBe(hex(derivePreimage(SEED, preimageScope('oc-sponsor-bond', 'o-1', 'cd'.repeat(32)), 0)));
  });

  it('시드가 다르면 다르다', () => {
    const other = new Uint8Array(32).fill(2);
    expect(hex(deriveOnchainAdminKey(other, 'o-1'))).not.toBe(hex(deriveOnchainAdminKey(SEED, 'o-1')));
  });

  /** DB를 잃었을 때 — 공개된 payment hash만 있으면 시도 번호를 올려가며 되찾는다 */
  it('payment hash에서 프리이미지를 되찾는다', () => {
    const scope = preimageScope('ln-sponsor-deposit', 'o-9', SPONSOR);
    const target = derivePreimage(SEED, scope, 5);
    const found = recoverPreimage(SEED, scope, paymentHashOf(target));
    expect(found?.attempt).toBe(5);
    expect(hex(found!.preimage)).toBe(hex(target));
    expect(recoverPreimage(SEED, preimageScope('ln-escrow', 'o-9'), paymentHashOf(target))).toBeNull();
  });

  it('scope 구성요소에 구분자가 들어가면 거부한다 — 다른 scope와 겹칠 수 있다', () => {
    expect(() => preimageScope('ln-escrow', 'o/1')).toThrow();
  });

  it('시도 번호는 0 이상의 정수', () => {
    expect(() => derivePreimage(SEED, 'x', -1)).toThrow();
    expect(() => derivePreimage(SEED, 'x', 1.5)).toThrow();
  });
});
