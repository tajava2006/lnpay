/**
 * 리뷰 #8 회귀 테스트 — shared 층 (PLAN-ONCHAIN-TRACK §14 리뷰 #8)
 *
 * 각 describe가 리뷰에서 재현한 사고 하나에 대응한다. 여기가 깨지면 그 사고가
 * 다시 열렸다는 뜻이다.
 */
import { describe, it, expect } from 'vitest';
import { Transaction, p2tr, TEST_NETWORK, utils } from '@scure/btc-signer';
import { deriveEscrowAddress, deriveSingleKeyAddress, addressProblem } from '../onchain/address';
import { xonlyFromPrivkey } from '../onchain/keys';
import {
  addTapScriptSig, buildKeyPathSweep, buildSettlementTx, finalizeSettlement, leafOfWitness,
  outputAddressOf, signSettlement, tapScriptSigOf, toPsbtBase64, type BuildSettlementParams,
} from '../onchain/tx';
import { verifyPresignature } from '../onchain/verify';
import { bytesToHex } from '../onchain/hex';
import {
  ONCHAIN_EVENT_HORIZON_SEC, TERMINAL_GRACE_SEC, isPast, krwDeadlineOf,
  onchainOrderEventExpiration, presignDeadlineOf,
} from '../onchain/timing';
import {
  MAX_RELEASE_FEE_SHARE, releaseFeerateProblem, requiredConfirmations, reserveProblem,
} from '../onchain/policy';
import { onchainOrderTags, parseOnchainOrder, type OnchainOrder } from '../onchain/order';
import { freshPrice, type PriceSnapshot } from '../price';

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const SK_C = sk(1), SK_S = sk(40), SK_A = sk(80), SK_D = sk(120), SK_X = sk(160);
const KEYS = {
  customer: xonlyFromPrivkey(SK_C),
  sponsor: xonlyFromPrivkey(SK_S),
  admin: xonlyFromPrivkey(SK_A),
};
const D = deriveEscrowAddress({ keys: KEYS, network: 'signet' });
const DEST = p2tr(utils.pubSchnorr(SK_D), undefined, TEST_NETWORK).address!;
const EVIL = p2tr(utils.pubSchnorr(SK_X), undefined, TEST_NETWORK).address!;
const INPUT = { outpoint: { txid: 'f'.repeat(64), vout: 1 }, valueSat: 50_000 };

function params(over: Partial<BuildSettlementParams> = {}): BuildSettlementParams {
  return { descriptor: D, input: INPUT, path: 'refund', destination: DEST, feeSat: 400, ...over };
}

// ─── 의뢰 만료를 넘긴 거래가 멈췄다 (NIP-40) ───────────────────────

describe('이벤트 만료는 의뢰 만료와 따로 간다', () => {
  const now = 1_700_000_000;
  const listing = now - 3600; // 의뢰는 한 시간 전에 만료됐다

  /**
   * 전에는 진행 중 상태에도 의뢰 만료를 그대로 실어서, 막바지에 클레임된 주문은
   * `funded`부터 발행이 릴레이에 거절됐다(NIP-40). 거래가 멈췄다.
   */
  it.each(['bonded', 'funded', 'presigned', 'remitted', 'disputed', 'refunding', 'settling'])(
    '%s는 의뢰 만료가 지나도 거래 상한 동안 산다',
    state => {
      const exp = onchainOrderEventExpiration(state, listing, now, false);
      expect(exp).toBeGreaterThan(now);
      expect(exp).toBe(now + ONCHAIN_EVENT_HORIZON_SEC);
    },
  );

  it('listed는 의뢰 만료 그대로 — 오더북에서 저절로 사라져야 한다', () => {
    expect(onchainOrderEventExpiration('listed', now + 100, now, false)).toBe(now + 100);
  });

  it('터미널은 지났으면 유예를 준다', () => {
    expect(onchainOrderEventExpiration('cancelled', listing, now, true)).toBe(now + TERMINAL_GRACE_SEC);
  });

  it('거래 상한은 타임락(8064블록≈56일)보다 길다', () => {
    expect(ONCHAIN_EVENT_HORIZON_SEC).toBeGreaterThan(8064 * 600);
  });
});

// ─── 핸들러가 마감을 안 봤다 ─────────────────────────────────────

describe('마감 헬퍼 — 모르면 지난 것으로 본다', () => {
  it('fundedAt이 없으면 사전서명 마감도 없고, 그건 "지났다"다', () => {
    expect(presignDeadlineOf({})).toBeUndefined();
    expect(isPast(undefined, 0)).toBe(true);
  });

  it('krwDeadline이 박혀 있으면 그걸, 없으면 계좌 공개 + 30분', () => {
    expect(krwDeadlineOf({ krwDeadline: 5 })).toBe(5);
    expect(krwDeadlineOf({ accountSentAt: 100 })).toBe(100 + 30 * 60);
    expect(krwDeadlineOf({})).toBeUndefined();
  });
});

// ─── 후원자 feerate 상한이 없었다 (공짜 그리핑) ───────────────────

describe('릴리스 feerate 경계', () => {
  const base = { amountSat: 500_000, dustSat: 330 };

  it('터무니없이 높은 값은 거절한다 (거래를 bonded에 영원히 묶던 값)', () => {
    expect(releaseFeerateProblem({ ...base, feerateSatPerVb: 1_000_000, fastestSatPerVb: 10, releaseFeeSat: 169_000_000 }))
      .toMatch(/너무 높/);
  });

  it('수수료가 거래액의 20%를 넘으면 거절한다', () => {
    expect(releaseFeerateProblem({ ...base, feerateSatPerVb: 90, fastestSatPerVb: 100, releaseFeeSat: 500_000 * MAX_RELEASE_FEE_SHARE + 1 }))
      .toMatch(/20%/);
  });

  it('중계가 안 되는 값(1 sat/vB 미만)은 거절한다', () => {
    expect(releaseFeerateProblem({ ...base, feerateSatPerVb: 0.1, releaseFeeSat: 17 })).toMatch(/최소/);
  });

  it('정상 값은 통과', () => {
    expect(releaseFeerateProblem({ ...base, feerateSatPerVb: 5, fastestSatPerVb: 8, releaseFeeSat: 845 })).toBeNull();
  });

  it('상한은 "가장 빠름"의 배수이되 바닥이 있다', () => {
    expect(releaseFeerateProblem({ ...base, feerateSatPerVb: 100, fastestSatPerVb: 1, releaseFeeSat: 16_900 })).toBeNull();
    expect(releaseFeerateProblem({ ...base, feerateSatPerVb: 101, fastestSatPerVb: 1, releaseFeeSat: 17_069 })).toMatch(/너무 높/);
  });
});

// ─── reserve가 공짜 풋옵션이었다 ──────────────────────────────────

describe('최저가는 시세보다 3% 이상 낮아야 한다', () => {
  const price = 100_000_000; // 1 BTC = 1억 원
  const amountSat = 1_000_000; // 0.01 BTC = 100만 원

  it('시세에 붙은 최저가는 거절한다', () => {
    expect(reserveProblem({ reserveKrw: 990_000, amountSat, btcPriceKrw: price })).toMatch(/3%/);
  });

  it('3% 이상 낮으면 받는다', () => {
    expect(reserveProblem({ reserveKrw: 970_000, amountSat, btcPriceKrw: price })).toBeNull();
  });

  it('시세를 모르면 판단할 수 없어 거절한다', () => {
    expect(reserveProblem({ reserveKrw: 900_000, amountSat, btcPriceKrw: undefined })).toMatch(/시세/);
  });
});

describe('요구 컨펌 수는 한 곳에서 정한다 (어드민 판정과 후원자 자체 확인이 같은 값)', () => {
  it.each([[99_999, 1], [100_000, 2], [999_999, 2], [1_000_000, 3]])('%i sats → %i', (amt, n) => {
    expect(requiredConfirmations(amt)).toBe(n);
  });
});

// ─── 서명을 옮겨 심는다 — 받은 PSBT에 그대로 서명하지 않는다 ──────

describe('서명 옮겨 심기 (어드민은 마지막에 서명한다)', () => {
  it('상대 서명을 우리가 만든 tx에 옮겨 심고, 우리 서명을 더하면 완성된다', () => {
    const theirs = buildSettlementTx(params());
    signSettlement(theirs, SK_C); // 고객이 먼저 서명한 PSBT
    const verdict = verifyPresignature({
      psbtBase64: toPsbtBase64(theirs), expected: params(), signerXonly: KEYS.customer,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const ours = buildSettlementTx(params());
    addTapScriptSig(ours, verdict.leafScript, KEYS.customer, verdict.sig);
    signSettlement(ours, SK_A); // 어드민은 마지막
    finalizeSettlement(ours, 'refund');
    expect(ours.id).toBe(theirs.id);
  });

  /** 다른 리프 서명을 끼워 넣은 PSBT에서 그 서명을 집으면 안 된다 */
  it('리프를 지정하면 그 리프의 서명만 찾는다', () => {
    const release = buildSettlementTx(params({ path: 'release' }));
    signSettlement(release, SK_C);
    const leafOf = (name: string) => D.leaves.find(l => l.name === name)!.script;
    expect(tapScriptSigOf(release, KEYS.customer, leafOf('release'))).not.toBeNull();
    expect(tapScriptSigOf(release, KEYS.customer, leafOf('customer-win'))).toBeNull();
  });

  it('출력 주소를 읽는다 (화면에 보여주고 대조한다)', () => {
    expect(outputAddressOf(buildSettlementTx(params({ destination: EVIL })), D)).toBe(EVIL);
  });
});

// ─── "UTXO가 없다"를 리오그로 오인했다 → 소모 증인으로 리프를 가른다 ──

describe('소모 증인 → 리프', () => {
  it.each([
    ['release', [SK_C, SK_S]],
    ['refund', [SK_A, SK_C]],
    ['sponsor-win', [SK_A, SK_S]],
  ] as const)('%s 경로의 증인', (path, keys) => {
    const tx = buildSettlementTx(params({ path }));
    for (const k of keys) signSettlement(tx, k);
    finalizeSettlement(tx, path);
    const witness = tx.getInput(0).finalScriptWitness!.map(w => bytesToHex(w));
    const expected = path === 'refund' ? 'customer-win' : path;
    expect(leafOfWitness(witness, D)).toBe(expected);
  });

  it('타임락 경로를 알아본다 — swept을 관측하는 근거', () => {
    const tx = buildSettlementTx(params({ path: 'timelock' }));
    signSettlement(tx, SK_C);
    finalizeSettlement(tx, 'timelock');
    const witness = tx.getInput(0).finalScriptWitness!.map(w => bytesToHex(w));
    expect(leafOfWitness(witness, D)).toBe('timelock');
  });

  it('모르는 모양이면 추측하지 않는다', () => {
    expect(leafOfWitness(['00'.repeat(64)], D)).toBeNull();
    expect(leafOfWitness(null, D)).toBeNull();
    expect(leafOfWitness(['aa', 'bb', 'cc'], D)).toBeNull();
  });
});

// ─── 옛 환불 주소에서 꺼낼 길이 없었다 ────────────────────────────

describe('단일키 주소 스윕 (환불금 꺼내기 · CPFP)', () => {
  const myXonly = xonlyFromPrivkey(SK_C);
  const refundAddr = deriveSingleKeyAddress(myXonly, 'signet');
  const utxos = [
    { txid: 'a'.repeat(64), vout: 0, valueSat: 40_000 },
    { txid: 'b'.repeat(64), vout: 1, valueSat: 10_000 },
  ];

  it('여러 UTXO를 한 tx로 모아 내 지갑으로 보낸다', () => {
    const { tx, feeSat, outputSat } = buildKeyPathSweep({
      privkey: SK_C, network: 'signet', utxos, destination: DEST, feerateSatPerVb: 3,
    });
    expect(tx.inputsLength).toBe(2);
    expect(outputSat).toBe(50_000 - feeSat);
    expect(feeSat).toBe(Math.ceil(tx.vsize * 3));
    expect(tx.isFinal).toBe(true);
  });

  it('입력이 정말 그 단일키 주소의 것이다 (키가 맞아야 서명된다)', () => {
    const { tx } = buildKeyPathSweep({
      privkey: SK_C, network: 'signet', utxos, destination: DEST, feerateSatPerVb: 1,
    });
    const script = tx.getInput(0).witnessUtxo!.script;
    expect(bytesToHex(script)).toBe(bytesToHex(p2tr(utils.pubSchnorr(SK_C), undefined, TEST_NETWORK).script));
    expect(p2tr(utils.pubSchnorr(SK_C), undefined, TEST_NETWORK).address).toBe(refundAddr);
    // 다시 읽어도 완성된 tx다
    expect(Transaction.fromRaw(tx.extract()).id).toBe(tx.id);
  });

  it('수수료를 빼면 dust면 거부한다', () => {
    expect(() => buildKeyPathSweep({
      privkey: SK_C, network: 'signet', utxos: [{ txid: 'a'.repeat(64), vout: 0, valueSat: 400 }],
      destination: DEST, feerateSatPerVb: 5,
    })).toThrow(/dust/);
  });
});

// ─── 결정이 오더에 실린다 ─────────────────────────────────────────

describe('결정 태그 왕복', () => {
  const order: OnchainOrder = {
    orderId: 'o', state: 'refunding', status: 'active', customerPubkey: 'c', sponsorPubkey: 's',
    amountSat: 500_000, createdAt: 1, updatedAt: 2, expiration: 3, network: 'signet',
    customerXonly: KEYS.customer, sponsorXonly: KEYS.sponsor, adminXonly: KEYS.admin,
    escrowAddress: D.address, timelockBlocks: D.timelockBlocks,
    fundingOutpoint: `${'f'.repeat(64)}:1`,
    settlementKind: 'refund:account-disputed', settlementFeeSat: 400, decidedAt: 10,
    accountDisputedAt: 9, disputedAt: 8,
    raw: {},
  };

  it('사유·수수료·결정 시각·이의·분쟁 시각이 왕복한다', () => {
    const tags = onchainOrderTags(order, 'T');
    const back = parseOnchainOrder({ kind: 30402, pubkey: 'x', created_at: 2, tags }, 'T')!;
    expect(back.settlementKind).toBe('refund:account-disputed');
    expect(back.settlementFeeSat).toBe(400);
    expect(back.decidedAt).toBe(10);
    expect(back.accountDisputedAt).toBe(9);
    expect(back.disputedAt).toBe(8);
  });

  /** 사유가 서명할 tx를 정한다 — 모르는 값을 아는 척하면 엉뚱한 tx에 서명한다 */
  it('모르는 사유가 실린 이벤트는 버린다', () => {
    const tags = onchainOrderTags(order, 'T').map(t => (t[0] === 'settlement-kind' ? ['settlement-kind', 'refund:whatever'] : t));
    expect(parseOnchainOrder({ kind: 30402, pubkey: 'x', created_at: 2, tags }, 'T')).toBeNull();
  });
});

// ─── 낡은 시세로 T0를 고정했다 ────────────────────────────────────

describe('신선한 시세만 돈을 정한다', () => {
  const now = 10_000_000;
  const snap = (ages: Array<number | null>, prices: number[]): PriceSnapshot => ({
    price: 1,
    exchanges: ages.map((age, i) => ({
      name: `x${i}`, price: prices[i]!, connected: age !== null, updatedAt: age === null ? null : now - age,
    })),
  });

  it('최근 소스 둘 이상의 중간값', () => {
    expect(freshPrice(snap([1_000, 2_000, 3_000], [100, 102, 104]), now)).toBe(102);
  });

  it('끊긴 거래소의 마지막 값(몇 시간 전)은 안 쓴다', () => {
    expect(freshPrice(snap([1_000, 5 * 3600_000, 6 * 3600_000], [100, 90, 80]), now)).toBeNull();
  });

  it('소스가 모자라면 null — 부르는 쪽은 기다린다', () => {
    expect(freshPrice(snap([1_000, null, null], [100, 0, 0]), now)).toBeNull();
    expect(freshPrice(snap([1_000, null, null], [100, 0, 0]), now, 60_000, 1)).toBe(100);
  });
});

describe('주소 검증', () => {
  it('네트워크가 다른 주소는 거절한다', () => {
    expect(addressProblem(DEST, 'signet')).toBeNull();
    expect(addressProblem(DEST, 'mainnet')).toMatch(/mainnet/);
    expect(addressProblem('not-an-address', 'signet')).not.toBeNull();
  });
});
