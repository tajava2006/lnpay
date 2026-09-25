/**
 * 종결 tx 빌더 + 사전서명 검증
 *
 * 여기가 **실제로 돈을 옮기는 코드**다. 지키는 것 셋:
 *   ① 같은 입력이면 **누가 만들어도 같은 바이트** — 아니면 사전서명 대조가 무의미하다
 *   ② 수수료 추정이 **실제 vsize와 일치** — 빗나가면 tx가 멤풀에서 썩는다
 *   ③ **다른 tx용 서명을 받아주지 않는다** (T-109)
 */
import { describe, it, expect } from 'vitest';
import { p2tr, p2wpkh, TEST_NETWORK, utils } from '@scure/btc-signer';
import { pubECDSA } from '@scure/btc-signer/utils.js';
import { deriveEscrowAddress } from '../onchain/address';
import { hexToBytes } from '../onchain/hex';
import { xonlyFromPrivkey } from '../onchain/keys';
import {
  buildSettlementTx, estimateSettlementVsize, dustThresholdFor, finalizeSettlement,
  fromPsbtBase64, settlementFeeSat, settlementLeafFor, signSettlement, tapScriptSigOf,
  toPsbtBase64, type BuildSettlementParams, type SettlementPath,
} from '../onchain/tx';
import { leafHashOf, verifyPresignature } from '../onchain/verify';

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const SK_C = sk(1), SK_S = sk(40), SK_A = sk(80), SK_D = sk(120), SK_X = sk(160);

const KEYS = {
  customer: xonlyFromPrivkey(SK_C),
  sponsor: xonlyFromPrivkey(SK_S),
  admin: xonlyFromPrivkey(SK_A),
};
const D = deriveEscrowAddress({ keys: KEYS, network: 'signet' });

const DEST_TR = p2tr(utils.pubSchnorr(SK_D), undefined, TEST_NETWORK).address!;
const DEST_WPKH = p2wpkh(pubECDSA(SK_D), TEST_NETWORK).address!;
const DEST_EVIL = p2tr(utils.pubSchnorr(SK_X), undefined, TEST_NETWORK).address!;

const INPUT = { outpoint: { txid: 'f'.repeat(64), vout: 1 }, valueSat: 50_000 };

function params(over: Partial<BuildSettlementParams> = {}): BuildSettlementParams {
  return { descriptor: D, input: INPUT, path: 'release', destination: DEST_TR, feeSat: 338, ...over };
}

describe('경로 → 리프', () => {
  it.each([
    ['release', 'release'],
    ['refund', 'customer-win'],
    ['customer-win', 'customer-win'],
    ['sponsor-win', 'sponsor-win'],
    ['timelock', 'timelock'],
  ] as const)('%s → leaf %s', (path, leaf) => {
    expect(settlementLeafFor(path)).toBe(leaf);
  });

  /** 환불과 고객승은 tx가 완전히 같다. 다른 건 사유와 보증금 처리뿐이다. */
  it('refund와 customer-win은 같은 tx를 만든다', () => {
    const a = buildSettlementTx(params({ path: 'refund', destination: DEST_TR }));
    const b = buildSettlementTx(params({ path: 'customer-win', destination: DEST_TR }));
    expect(a.id).toBe(b.id);
  });
});

describe('결정론 — 누가 만들어도 같은 바이트', () => {
  it('같은 입력이면 같은 txid', () => {
    expect(buildSettlementTx(params()).id).toBe(buildSettlementTx(params()).id);
  });

  it('무엇 하나라도 다르면 txid가 갈린다', () => {
    const base = buildSettlementTx(params()).id;
    expect(buildSettlementTx(params({ feeSat: 339 })).id).not.toBe(base);
    expect(buildSettlementTx(params({ destination: DEST_EVIL })).id).not.toBe(base);
    expect(buildSettlementTx(params({
      input: { ...INPUT, outpoint: { txid: 'e'.repeat(64), vout: 1 } },
    })).id).not.toBe(base);
    expect(buildSettlementTx(params({ path: 'timelock' })).id).not.toBe(base);
  });
});

describe('nSequence (T-115)', () => {
  /**
   * 릴리스가 멤풀에 있는 동안 고객이 같은 UTXO를 쓰는 다른 tx로 교체하면
   * **릴리스를 탈취**한다. RBF를 끈다.
   */
  it.each(['release', 'refund', 'customer-win', 'sponsor-win'] as const)('%s는 RBF 비활성', path => {
    const tx = buildSettlementTx(params({ path, destination: DEST_TR }));
    expect(tx.getInput(0).sequence).toBe(0xffffffff);
  });

  /** CSV를 만족시키려면 nSequence가 **블록 수 그 자체**여야 한다. */
  it('timelock만 CSV 블록 수를 쓴다', () => {
    const tx = buildSettlementTx(params({ path: 'timelock' }));
    expect(tx.getInput(0).sequence).toBe(8064);
    expect(tx.getInput(0).sequence).toBe(D.timelockBlocks);
  });

  /** BIP-68 상대 타임락은 version 2 이상에서만 동작한다. */
  it('version은 2다', () => {
    expect(buildSettlementTx(params({ path: 'timelock' })).version).toBe(2);
  });
});

describe('수수료 추정이 실제와 맞는가', () => {
  /**
   * 빗나가면 둘 중 하나다 — 더 내면 손해, 덜 내면 **tx가 멤풀에서 썩는다.**
   * Schnorr 서명이 64바이트 고정이라 이건 추정이 아니라 계산이어야 한다.
   */
  it('2서명 경로: 추정 vsize == 서명 후 실제 vsize', () => {
    const tx = buildSettlementTx(params());
    signSettlement(tx, SK_S);
    signSettlement(tx, SK_C);
    finalizeSettlement(tx, 'release');
    expect(tx.vsize).toBe(estimateSettlementVsize('release', D, DEST_TR));
    expect(tx.vsize).toBe(169);
  });

  it('타임락(단독 서명)도 맞는다', () => {
    const tx = buildSettlementTx(params({ path: 'timelock', feeSat: 292 }));
    signSettlement(tx, SK_C);
    finalizeSettlement(tx, 'timelock');
    expect(tx.vsize).toBe(estimateSettlementVsize('timelock', D, DEST_TR));
    expect(tx.vsize).toBe(146);
  });

  /** 받는 주소 종류를 우리가 정하지 않으므로 출력 크기를 실제 스크립트에서 센다. */
  it('받는 주소 종류에 따라 크기가 달라진다', () => {
    const tr = estimateSettlementVsize('release', D, DEST_TR);
    const wpkh = estimateSettlementVsize('release', D, DEST_WPKH);
    expect(wpkh).toBeLessThan(tr);

    const tx = buildSettlementTx(params({ destination: DEST_WPKH }));
    signSettlement(tx, SK_S);
    signSettlement(tx, SK_C);
    finalizeSettlement(tx, 'release');
    expect(tx.vsize).toBe(wpkh);
  });

  it('feerate를 곱해 수수료를 낸다 (올림)', () => {
    expect(settlementFeeSat('release', D, DEST_TR, 2)).toBe(338);
    expect(settlementFeeSat('release', D, DEST_TR, 1.5)).toBe(Math.ceil(169 * 1.5));
    expect(() => settlementFeeSat('release', D, DEST_TR, 0)).toThrow(/feerate/);
  });
});

describe('dust · 금액 검사', () => {
  it('출력 종류별 dust 한계', () => {
    expect(dustThresholdFor(DEST_TR, D)).toBe(330);
    expect(dustThresholdFor(DEST_WPKH, D)).toBe(294);
  });

  /** dust 이하면 릴레이가 안 받는다. 만들기 전에 막는다. */
  it('출력이 dust 이하면 만들지 않는다', () => {
    expect(() => buildSettlementTx(params({ feeSat: INPUT.valueSat - 329 }))).toThrow(/dust/);
    expect(() => buildSettlementTx(params({ feeSat: INPUT.valueSat - 330 }))).not.toThrow();
  });

  it('수수료가 입력보다 크면 막는다', () => {
    expect(() => buildSettlementTx(params({ feeSat: INPUT.valueSat + 1 }))).toThrow(/dust/);
  });

  it('비정상 금액을 거부한다', () => {
    expect(() => buildSettlementTx(params({ input: { ...INPUT, valueSat: 0 } }))).toThrow(/입력 금액/);
    expect(() => buildSettlementTx(params({ feeSat: -1 }))).toThrow(/수수료/);
  });

  /** 네트워크가 다른 주소는 디코딩 단계에서 걸린다. */
  it('다른 네트워크 주소는 거부한다', () => {
    const mainnetAddr = p2tr(utils.pubSchnorr(SK_D)).address!;
    expect(() => buildSettlementTx(params({ destination: mainnetAddr }))).toThrow();
  });
});

describe('서명 · PSBT 왕복', () => {
  /**
   * release 리프는 `{C,S}`다. 어드민 키는 거기 없다 — 조용히 넘어가면
   * **서명 없는 tx를 다 만들어놓고 마지막에** 알게 된다.
   */
  it('리프에 없는 키로 서명하면 던진다', () => {
    const tx = buildSettlementTx(params());
    expect(() => signSettlement(tx, SK_A)).toThrow(/서명할 수 없다/);
    expect(tapScriptSigOf(tx, KEYS.admin)).toBeNull();
  });

  it('분쟁 경로에서는 어드민이 서명한다', () => {
    const win = buildSettlementTx(params({ path: 'sponsor-win' }));
    signSettlement(win, SK_A);
    signSettlement(win, SK_S);
    expect(tapScriptSigOf(win, KEYS.admin)).toHaveLength(64);
  });

  it('PSBT로 날라도 txid와 서명이 보존된다', () => {
    const tx = buildSettlementTx(params());
    signSettlement(tx, SK_S);
    const back = fromPsbtBase64(toPsbtBase64(tx));
    expect(back.id).toBe(tx.id);
    expect(tapScriptSigOf(back, KEYS.sponsor)).toHaveLength(64);
  });

  it('양쪽이 서명하면 완성된다', () => {
    const tx = buildSettlementTx(params());
    signSettlement(tx, SK_S);
    const received = fromPsbtBase64(toPsbtBase64(tx));
    signSettlement(received, SK_C);
    finalizeSettlement(received, 'release');
    expect(received.extract().length).toBeGreaterThan(100);
  });

  /**
   * 타임락 리프는 라이브러리가 모르는 모양이라(`<N> CSV DROP <C> CHECKSIG`)
   * `finalize()`가 거부한다. 증인을 직접 쌓는다.
   */
  it('타임락은 고객 단독으로 완성된다', () => {
    const tx = buildSettlementTx(params({ path: 'timelock', feeSat: 292 }));
    signSettlement(tx, SK_C);
    expect(() => tx.finalize()).toThrow(/Unknown tapLeafScript/);
    finalizeSettlement(tx, 'timelock');
    expect(tx.extract().length).toBeGreaterThan(100);
  });
});

describe('사전서명 검증 (T-109)', () => {
  function presigned(over: Partial<BuildSettlementParams> = {}): string {
    const tx = buildSettlementTx(params(over));
    signSettlement(tx, SK_S);
    return toPsbtBase64(tx);
  }

  it('정상 사전서명은 통과하고 txid를 돌려준다', () => {
    const v = verifyPresignature({
      psbtBase64: presigned(), expected: params(), signerXonly: KEYS.sponsor,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.txid).toBe(buildSettlementTx(params()).id);
  });

  /**
   * ⚠️ **T-109의 핵심.** 후원자가 *다른* tx(자기에게 더 유리한)에 서명해 보내면,
   * 서명 자체는 암호학적으로 멀쩡하다. 구조만 보면 통과한다.
   * **우리가 만든 tx의 sighash로 검증**해야 걸린다.
   */
  it('다른 tx용 서명을 옮겨 심으면 걸린다', () => {
    // 후원자가 수수료를 낮춰(= 자기 몫을 늘려) 서명한 뒤, 그 서명만 떼어
    // 우리가 기대하는 tx에 붙인 상황
    const greedy = buildSettlementTx(params({ feeSat: 200 }));
    signSettlement(greedy, SK_S);
    const stolenSig = tapScriptSigOf(greedy, KEYS.sponsor)!;

    const shell = buildSettlementTx(params());
    const leafHash = leafHashOf(D.leaves[0]!.script);
    shell.updateInput(0, {
      tapScriptSig: [[
        { pubKey: hexToBytes(KEYS.sponsor), leafHash: hexToBytes(leafHash) },
        stolenSig,
      ]],
    }, true);

    const v = verifyPresignature({
      psbtBase64: toPsbtBase64(shell), expected: params(), signerXonly: KEYS.sponsor,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/이 tx에 대한 것이 아니다/);
  });

  it.each([
    ['받는 주소가 다르면', { destination: DEST_EVIL }, /받는 주소가 다르다/],
    ['금액이 다르면', { feeSat: 200 }, /금액이 다르다/],
    ['소모 UTXO가 다르면', {
      input: { outpoint: { txid: 'e'.repeat(64), vout: 1 }, valueSat: 50_000 },
    }, /UTXO가 다르다/],
  ] as const)('%s 막는다', (_label, over, pattern) => {
    const v = verifyPresignature({
      psbtBase64: presigned(over as Partial<BuildSettlementParams>),
      expected: params(),
      signerXonly: KEYS.sponsor,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(pattern);
  });

  it('서명이 아예 없으면 막는다', () => {
    const v = verifyPresignature({
      psbtBase64: toPsbtBase64(buildSettlementTx(params())),
      expected: params(),
      signerXonly: KEYS.sponsor,
    });
    expect(v.ok).toBe(false);
  });

  it('다른 사람의 서명은 그 키로 찾지 못한다', () => {
    const v = verifyPresignature({
      psbtBase64: presigned(), expected: params(), signerXonly: KEYS.customer,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/서명이 PSBT에 없다/);
  });

  it('망가진 PSBT는 사유와 함께 실패한다', () => {
    for (const bad of ['', 'not-base64!!', 'AAAA']) {
      const v = verifyPresignature({ psbtBase64: bad, expected: params(), signerXonly: KEYS.sponsor });
      expect(v.ok, bad).toBe(false);
    }
  });

  it('키 형식이 틀리면 검증 전에 막는다', () => {
    const v = verifyPresignature({
      psbtBase64: presigned(), expected: params(), signerXonly: 'ZZ'.repeat(32),
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/x-only/);
  });
});

describe('리프 해시', () => {
  it('리프마다 다르고 결정론적이다', () => {
    const hashes = D.leaves.map(l => leafHashOf(l.script));
    expect(new Set(hashes).size).toBe(4);
    expect(leafHashOf(D.leaves[0]!.script)).toBe(hashes[0]);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('crypto 인스턴스', () => {
  /**
   * 검증에 쓰는 `@noble/curves`가 `@scure/btc-signer`가 서명에 쓰는 것과
   * **같은 구현**인지 확인한다. 서명은 btc-signer가, 검증은 우리가 부르므로
   * 둘이 갈리면 **멀쩡한 서명을 가짜로 판정**하거나 그 반대가 된다.
   */
  it('btc-signer가 만든 서명을 우리 verify가 받아들인다', async () => {
    const { signSchnorr } = await import('@scure/btc-signer/utils.js');
    const { schnorr } = await import('@noble/curves/secp256k1.js');
    const msg = new Uint8Array(32).fill(7);
    const sig = signSchnorr(msg, SK_C);
    expect(schnorr.verify(sig, msg, utils.pubSchnorr(SK_C))).toBe(true);
  });
});

/** 경로 전수 — 새 경로를 추가하면 여기가 먼저 깨진다 */
describe('모든 경로가 만들어진다', () => {
  const ALL: SettlementPath[] = ['release', 'refund', 'customer-win', 'sponsor-win', 'timelock'];

  it.each(ALL)('%s', path => {
    const tx = buildSettlementTx(params({ path, feeSat: 400 }));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutput(0)!.amount).toBe(BigInt(INPUT.valueSat - 400));
  });
});
