/**
 * 에스크로 주소 파생과 독립 검증
 *
 * 세 층으로 본다:
 *   ① **BIP-341 공식 테스트 벡터** — 트리 구성·머클·트윅·bech32m 전 구간이
 *      비트코인 규약과 맞는지. 우리 코드가 아니라 **남이 만든 정답**과 대조한다.
 *   ② **우리 트리의 머클 루트를 테스트가 직접 계산** — 리프 4개를 어떤 모양으로
 *      묶었는지는 우리 결정이므로, 그 부분은 BIP-341 벡터가 못 잡아준다.
 *      태그드 해시를 테스트 안에서 규약대로 다시 구현해 대조한다.
 *   ③ **고정 주소(골든)** — 위 둘이 통과해도 주소가 조용히 바뀌면 안 된다.
 *      키·트리·타임락이 그대로면 주소도 그대로여야 한다(기기를 바꾼 유저가
 *      같은 주소를 다시 만들어야 하므로).
 */
import { describe, it, expect } from 'vitest';
import { NETWORK, TaprootControlBlock, p2tr } from '@scure/btc-signer';
import type { TaprootScriptTree } from '@scure/btc-signer/payment.js';
import vectors from './fixtures/bip341-scriptpubkey.json';
import { bytesToHex, hexToBytes } from '../onchain/hex';
import { deriveEscrowAddress, verifyEscrowAddress } from '../onchain/address';
import { buildEscrowLeaves } from '../onchain/script';

const C = 'a1'.repeat(32);
const S = 'b2'.repeat(32);
const A = 'c3'.repeat(32);
const KEYS = { customer: C, sponsor: S, admin: A };

// ── ① BIP-341 공식 벡터 ──────────────────────────────────────────────────

type VectorNode = { id: number; script: string; leafVersion: number } | VectorNode[] | null;

function toTree(node: VectorNode): TaprootScriptTree {
  if (Array.isArray(node)) return node.map(toTree);
  if (node === null) throw new Error('빈 트리는 이 헬퍼로 못 만든다');
  return { script: hexToBytes(node.script), leafVersion: node.leafVersion };
}

describe('BIP-341 wallet test vectors (bitcoin/bips)', () => {
  vectors.forEach((v, i) => {
    it(`case ${i}: ${v.expected.bip350Address.slice(0, 16)}…`, () => {
      const internalKey = hexToBytes(v.given.internalPubkey);
      const rawTree = v.given.scriptTree as VectorNode;

      // 트리가 없는 케이스(키패스 전용)와 있는 케이스는 p2tr 오버로드가 달라
      // 반환 타입도 다르다. 분기를 갈라야 각각 구체 타입으로 잡힌다.
      if (rawTree === null) {
        const out = p2tr(internalKey, undefined, NETWORK, true);
        expect(out.address).toBe(v.expected.bip350Address);
        expect(bytesToHex(out.script)).toBe(v.expected.scriptPubKey);
        return;
      }

      const out = p2tr(internalKey, toTree(rawTree), NETWORK, true);
      expect(out.address).toBe(v.expected.bip350Address);
      expect(bytesToHex(out.script)).toBe(v.expected.scriptPubKey);
      expect(bytesToHex(out.tapMerkleRoot)).toBe(v.intermediary.merkleRoot);

      const actualCbs = (out.tapLeafScript ?? []).map(([cb]) =>
        bytesToHex(TaprootControlBlock.encode(cb)),
      );
      expect(new Set(actualCbs)).toEqual(new Set(v.expected.scriptPathControlBlocks ?? []));
    });
  });
});

// ── ② 우리 트리의 머클 루트를 규약대로 다시 계산 ─────────────────────────

const enc = new TextEncoder();

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf as unknown as BufferSource));
}

/** BIP-340 태그드 해시: SHA256(SHA256(tag) || SHA256(tag) || msg) */
async function tagged(tag: string, ...msg: Uint8Array[]): Promise<Uint8Array> {
  const t = await sha256(enc.encode(tag));
  return sha256(t, t, ...msg);
}

async function leafHash(script: Uint8Array): Promise<Uint8Array> {
  // TapLeaf: leafVersion(0xc0) || compactSize(len) || script  (리프가 253바이트 미만이라 1바이트)
  expect(script.length).toBeLessThan(0xfd);
  return tagged('TapLeaf', Uint8Array.of(0xc0), Uint8Array.of(script.length), script);
}

async function branch(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const [lo, hi] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return tagged('TapBranch', lo, hi);
}

describe('우리 4-리프 트리의 머클 루트 (테스트가 직접 계산)', () => {
  it('[[release, customer-win], [sponsor-win, timelock]] 로 묶인다', async () => {
    const leaves = buildEscrowLeaves(KEYS);
    const [h0, h1, h2, h3] = await Promise.all(leaves.map(l => leafHash(l.script)));
    const expected = await branch(await branch(h0!, h1!), await branch(h2!, h3!));

    const d = deriveEscrowAddress({ keys: KEYS, network: 'mainnet' });
    expect(d.tapMerkleRoot).toBe(bytesToHex(expected));
  });

  it('모든 리프의 깊이가 2다 → control block이 전부 97바이트', () => {
    const d = deriveEscrowAddress({ keys: KEYS, network: 'mainnet' });
    const sizes = d.tapLeafScripts.map(([cb]) => TaprootControlBlock.encode(cb).length);
    expect(sizes).toEqual([97, 97, 97, 97]);
  });
});

// ── ③ 골든 + 네트워크 + 검증 ─────────────────────────────────────────────

describe('주소 파생', () => {
  it('고정 키 → 고정 주소 (mainnet)', () => {
    const d = deriveEscrowAddress({ keys: KEYS, network: 'mainnet' });
    expect(d.address).toBe('bc1plh936afrnp3y86wlrmd6k73msg3ke4tnv9lrsvut790dkdmcm8asckq3jn');
    expect(d.scriptPubKey).toBe(
      '5120fdcb1d7523986243e9df1edbab7a3b82236cd573617e38338bf15edb3778d9fb',
    );
    expect(d.timelockBlocks).toBe(8064);
  });

  it('네트워크별 prefix — 같은 키면 witness program은 같다', () => {
    const main = deriveEscrowAddress({ keys: KEYS, network: 'mainnet' });
    const signet = deriveEscrowAddress({ keys: KEYS, network: 'signet' });
    const testnet = deriveEscrowAddress({ keys: KEYS, network: 'testnet' });
    const regtest = deriveEscrowAddress({ keys: KEYS, network: 'regtest' });

    expect(main.address.startsWith('bc1p')).toBe(true);
    expect(signet.address.startsWith('tb1p')).toBe(true);
    expect(regtest.address.startsWith('bcrt1p')).toBe(true);
    // signet과 testnet은 주소 형식이 같다
    expect(signet.address).toBe(testnet.address);
    expect(signet.scriptPubKey).toBe(main.scriptPubKey);
    expect(signet.address).toBe('tb1plh936afrnp3y86wlrmd6k73msg3ke4tnv9lrsvut790dkdmcm8as07k7gu');
  });

  it('타임락이 다르면 주소가 다르다 (스크립트에 박히므로)', () => {
    const a = deriveEscrowAddress({ keys: KEYS, network: 'mainnet' });
    const b = deriveEscrowAddress({ keys: KEYS, network: 'mainnet', timelockBlocks: 4032 });
    expect(a.address).not.toBe(b.address);
  });
});

describe('독립 검증 (T-107 — 어드민이 가짜 주소를 발행)', () => {
  const real = deriveEscrowAddress({ keys: KEYS, network: 'mainnet' }).address;

  it('일치하면 통과', () => {
    const check = verifyEscrowAddress({ keys: KEYS, network: 'mainnet' }, real);
    expect(check.ok).toBe(true);
  });

  /**
   * 어드민이 자기 키를 슬쩍 바꿔치기한 주소를 주는 경우. 클라이언트는 **자기가
   * 아는 세 키**로만 다시 만들어 보므로 값이 갈린다.
   */
  it('키가 하나라도 다르면 막고, 내가 파생한 주소를 같이 알려준다', () => {
    const attacker = { ...KEYS, admin: 'dd'.repeat(32) };
    const fake = deriveEscrowAddress({ keys: attacker, network: 'mainnet' }).address;
    const check = verifyEscrowAddress({ keys: KEYS, network: 'mainnet' }, fake);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.derived).toBe(real);
  });

  it('타임락을 몰래 줄인 주소도 막는다', () => {
    const shortened = deriveEscrowAddress({
      keys: KEYS, network: 'mainnet', timelockBlocks: 144,
    }).address;
    expect(verifyEscrowAddress({ keys: KEYS, network: 'mainnet' }, shortened).ok).toBe(false);
  });

  it('네트워크가 다르면 막는다', () => {
    const signet = deriveEscrowAddress({ keys: KEYS, network: 'signet' }).address;
    expect(verifyEscrowAddress({ keys: KEYS, network: 'mainnet' }, signet).ok).toBe(false);
  });

  it('키가 겹치면 검증 단계에서 사유와 함께 실패한다 (예외로 새지 않는다)', () => {
    const check = verifyEscrowAddress(
      { keys: { ...KEYS, sponsor: C }, network: 'mainnet' }, real,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/중복/);
  });
});
