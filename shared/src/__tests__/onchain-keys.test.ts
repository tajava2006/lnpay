/**
 * 주문별 키 파생 (PLAN-ONCHAIN-TRACK §3.2 · §3.3)
 *
 * 여기서 지키는 건 셋이다:
 *   ① **결정론** — 같은 nostr 키 + 같은 orderId면 언제나 같은 키. 깨지면 기기를
 *      바꾼 유저가 자기 에스크로를 못 연다(= 자금 유실).
 *   ② **비연결성** — 파생 키가 nostr 신원과 이어지면 안 된다. 그게 이 파생의 목적이다.
 *   ③ **세 키 상이** — 겹치면 2-of-3 보장이 사라진다(공격 H).
 */
import { describe, it, expect } from 'vitest';
import {
  ORDER_KEY_PREFIX,
  assertEscrowKeys,
  deriveOrderKey,
  findDuplicateEscrowKey,
  generateOrderKey,
  isValidScalar,
  xonlyFromPrivkey,
} from '../onchain/keys';
import { hexToBytes, isXonlyHex } from '../onchain/hex';

const NOSTR_SK = hexToBytes('11'.repeat(32));
const OTHER_SK = hexToBytes('22'.repeat(32));
const ORDER_ID = 'order-abc-123';

describe('결정론', () => {
  it('같은 (키, orderId)는 언제나 같은 결과', async () => {
    const a = await deriveOrderKey(NOSTR_SK, ORDER_ID);
    const b = await deriveOrderKey(NOSTR_SK, ORDER_ID);
    expect(a.xonly).toBe(b.xonly);
    expect(Array.from(a.privkey)).toEqual(Array.from(b.privkey));
  });

  /**
   * 접두사는 규약이다. 바꾸면 **기존 주문의 주소가 전부 달라진다** — 이 테스트가
   * 깨지면 "버전을 올려야 하나"를 먼저 묻는 자리다.
   */
  it('파생 공식이 고정돼 있다 (접두사 + orderId)', async () => {
    expect(ORDER_KEY_PREFIX).toBe('pairbuy-onchain/v1/');
    const k = await deriveOrderKey(NOSTR_SK, ORDER_ID);
    // HMAC-SHA256(key=11..11, msg="pairbuy-onchain/v1/order-abc-123")
    expect(k.xonly).toBe(await goldenXonly(NOSTR_SK, `${ORDER_KEY_PREFIX}${ORDER_ID}`));
  });

  it('orderId가 다르면 키가 다르다 (주소 재사용 없음)', async () => {
    const a = await deriveOrderKey(NOSTR_SK, 'order-1');
    const b = await deriveOrderKey(NOSTR_SK, 'order-2');
    expect(a.xonly).not.toBe(b.xonly);
  });

  it('nostr 키가 다르면 키가 다르다', async () => {
    const a = await deriveOrderKey(NOSTR_SK, ORDER_ID);
    const b = await deriveOrderKey(OTHER_SK, ORDER_ID);
    expect(a.xonly).not.toBe(b.xonly);
  });
});

describe('비연결성 — nostr 신원이 체인에 비치지 않는다', () => {
  it('파생 키는 nostr 키 자신과 다르다', async () => {
    const derived = await deriveOrderKey(NOSTR_SK, ORDER_ID);
    expect(derived.xonly).not.toBe(xonlyFromPrivkey(NOSTR_SK));
  });

  it('x-only는 소문자 64자 hex다 (오더 태그에 그대로 실린다)', async () => {
    const derived = await deriveOrderKey(NOSTR_SK, ORDER_ID);
    expect(isXonlyHex(derived.xonly)).toBe(true);
  });
});

describe('입력 검증', () => {
  it('32바이트가 아닌 nostr 키는 거부', async () => {
    await expect(deriveOrderKey(new Uint8Array(31), ORDER_ID)).rejects.toThrow(/32바이트/);
  });

  it('빈 orderId는 거부', async () => {
    await expect(deriveOrderKey(NOSTR_SK, '')).rejects.toThrow(/orderId/);
  });
});

describe('스칼라 범위', () => {
  const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';

  it('0과 곡선 위수 n 이상은 비밀키가 될 수 없다', () => {
    expect(isValidScalar(hexToBytes('00'.repeat(32)))).toBe(false);
    expect(isValidScalar(hexToBytes(N_HEX))).toBe(false);
    expect(isValidScalar(hexToBytes('ff'.repeat(32)))).toBe(false);
  });

  it('1과 n−1은 유효하다', () => {
    expect(isValidScalar(hexToBytes('00'.repeat(31) + '01'))).toBe(true);
    expect(isValidScalar(hexToBytes(N_HEX.slice(0, 62) + '40'))).toBe(true);
  });

  it('길이가 32가 아니면 무효', () => {
    expect(isValidScalar(new Uint8Array(31))).toBe(false);
    expect(isValidScalar(new Uint8Array(33))).toBe(false);
  });
});

describe('어드민 키 생성', () => {
  it('부를 때마다 다른 유효 키가 나온다', () => {
    const a = generateOrderKey();
    const b = generateOrderKey();
    expect(isValidScalar(a.privkey)).toBe(true);
    expect(isXonlyHex(a.xonly)).toBe(true);
    expect(a.xonly).not.toBe(b.xonly);
  });
});

describe('세 키 상이 (공격 H)', () => {
  const keys = {
    customer: 'aa'.repeat(32),
    sponsor: 'bb'.repeat(32),
    admin: 'cc'.repeat(32),
  };

  it('전부 다르면 통과', () => {
    expect(findDuplicateEscrowKey(keys)).toBeNull();
    expect(() => assertEscrowKeys(keys)).not.toThrow();
  });

  it.each([
    ['customer', 'sponsor'],
    ['customer', 'admin'],
    ['sponsor', 'admin'],
  ] as const)('%s = %s 이면 막는다', (a, b) => {
    const dup = { ...keys, [b]: keys[a] };
    expect(findDuplicateEscrowKey(dup)).toEqual([a, b]);
    expect(() => assertEscrowKeys(dup)).toThrow(/중복/);
  });

  /**
   * ⚠️ 대문자를 받아주면 **같은 키가 다른 문자열로 통과**한다 — `AA…` 와 `aa…` 를
   * 서로 다른 주체로 보고 2-of-3이 1-of-2가 된다. 형식 검사를 소문자로 좁혀 둔
   * 이유가 이것이다.
   */
  it('대문자 hex는 형식 단계에서 막힌다', () => {
    expect(() => assertEscrowKeys({ ...keys, admin: 'CC'.repeat(32) })).toThrow(/형식 오류/);
  });

  it('길이가 틀리면 막는다', () => {
    expect(() => assertEscrowKeys({ ...keys, sponsor: 'bb'.repeat(31) })).toThrow(/형식 오류/);
  });
});

/** 테스트가 스스로 HMAC을 한 번 더 돌려 구현과 대조한다(구현 재사용 금지). */
async function goldenXonly(key: Uint8Array, msg: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(msg)));
  return xonlyFromPrivkey(mac);
}
