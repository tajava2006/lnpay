/**
 * 온체인 클라이언트 로직
 *
 * 여기가 **유저를 지키는 마지막 줄**이다. 어드민이 악의적이거나 침해당했을 때,
 * 혹은 후원자가 유리한 tx를 밀어 넣을 때 막아야 하는 자리가 전부 클라이언트다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Event } from 'nostr-tools/core';
import {
  PRESIGN_WINDOW_SEC, addTapScriptSig, buildSettlementTx, deriveEscrowAddress, deriveSingleKeyAddress,
  formatOutpoint, fromPsbtBase64, settlementFeeSat, signSettlement, tapScriptSigOf, toPsbtBase64,
  verifyPresignature, xonlyFromPrivkey,
  type OnchainOrder, type SettlementPath,
} from '@sajwo-tracker/shared/onchain';

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const SK_S = sk(40), SK_A = sk(80), SK_D = sk(120), SK_EVIL = sk(200), SK_R = sk(150);

/** 수신함 핸들러가 "나"로 보는 pubkey — 후원자 역할 테스트에서 바꾼다 */
let ME = 'spon';

// 내 nostr 키는 고정 — 주문별 키 파생이 결정론적이어야 한다.
// NIP-44는 접두사로 흉내 낸다 — 여기서 보는 건 암호가 아니라 **발신자 판정**이다.
vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  getSecretKey: async () => sk(1),
  getUserPubkey: async () => ME,
  nip44Decrypt: (content: string) => {
    if (!content.startsWith('enc:')) throw new Error('복호화 실패');
    return content.slice(4);
  },
  storage: {},
}));

const { APP_PUBKEY, CLIENT_TAG_ONCHAIN, MESSAGE_KIND, ORDER_KIND } = await import('@sajwo-tracker/shared');
const { onchainOrderTags, TIMELOCK_REMIT_THRESHOLD_BLOCKS } = await import('@sajwo-tracker/shared/onchain');
const { myOrderKey, _clearKeyCache } = await import('../onchain/keys');
const { checkEscrowAddress, checkSignRequest, releaseNeedsPriceOverride } =
  await import('../onchain/verify');
const { buildPresignature, buildCosignature, timelockStatus } =
  await import('../onchain/actions');
const claims = await import('../onchain/claim-store');

const ORDER_ID = 'order-1';
const TXID = 'd4'.repeat(32);
const AMOUNT = 500_000;

let MY_XONLY = '';
const XS = xonlyFromPrivkey(SK_S);
const XA = xonlyFromPrivkey(SK_A);
const PAYOUT = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'signet');
/** 고객이 의뢰 때 낸 환불 주소 */
const REFUND = deriveSingleKeyAddress(xonlyFromPrivkey(SK_R), 'signet');
/** 침해된 어드민의 주소 */
const EVIL = deriveSingleKeyAddress(xonlyFromPrivkey(SK_EVIL), 'signet');

beforeEach(async () => {
  _clearKeyCache();
  claims._resetForTesting();
  MY_XONLY = (await myOrderKey(ORDER_ID)).xonly;
});

function order(over: Partial<OnchainOrder> = {}): OnchainOrder {
  const descriptor = deriveEscrowAddress({
    keys: { customer: over.customerXonly ?? MY_XONLY, sponsor: XS, admin: XA },
    network: 'signet',
  });
  return {
    orderId: ORDER_ID, state: 'bonded',
    customerPubkey: 'cust', sponsorPubkey: 'spon', amountSat: AMOUNT,
    createdAt: 1, updatedAt: 1, expiration: 2_000_000_000, network: 'signet',
    customerXonly: MY_XONLY, sponsorXonly: XS, adminXonly: XA,
    escrowAddress: descriptor.address, timelockBlocks: descriptor.timelockBlocks,
    raw: {},
    ...over,
  };
}

describe('주문별 키', () => {
  it('같은 주문이면 같은 키 — 브라우저를 지워도 다시 나온다', async () => {
    const a = await myOrderKey(ORDER_ID);
    _clearKeyCache();
    const b = await myOrderKey(ORDER_ID);
    expect(b.xonly).toBe(a.xonly);
  });

  it('주문이 다르면 키가 다르다', async () => {
    expect((await myOrderKey('order-2')).xonly).not.toBe(MY_XONLY);
  });
});

describe('주소 독립 검증 (T-107)', () => {
  it('내 키로 만든 주소면 통과한다', () => {
    const check = checkEscrowAddress(order(), 'customer', MY_XONLY);
    expect(check.ok).toBe(true);
  });

  /**
   * ⚠️ 어드민이 알려준 주소를 그냥 믿으면, 어드민이 침해당했을 때 **전액을 잃는다.**
   */
  it('어드민이 바꿔치기한 주소를 잡아낸다', () => {
    const fake = deriveEscrowAddress({
      keys: { customer: MY_XONLY, sponsor: XS, admin: xonlyFromPrivkey(SK_EVIL) },
      network: 'signet',
    }).address;
    const check = checkEscrowAddress(order({ escrowAddress: fake }), 'customer', MY_XONLY);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.derived).toBeDefined();
  });

  /**
   * 내 키 자리에 남의 키가 꽂혀 있으면 **나는 그 돈을 영영 못 만진다.**
   * 주소만 대조하면 이 경우를 놓친다 — 주소는 그 키들로 정상 파생되기 때문이다.
   */
  it('오더에 실린 "내 키"가 내 것이 아니면 막는다', () => {
    const notMine = xonlyFromPrivkey(SK_EVIL);
    const tampered = deriveEscrowAddress({
      keys: { customer: notMine, sponsor: XS, admin: XA }, network: 'signet',
    });
    const check = checkEscrowAddress(
      order({ customerXonly: notMine, escrowAddress: tampered.address }),
      'customer', MY_XONLY,
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/내가 파생한 키와 다르다/);
  });

  /** 두 키가 같으면 2-of-3 보장이 사라진다 (T-108). */
  it('세 키 중 둘이 같으면 막는다', () => {
    const check = checkEscrowAddress(
      order({ sponsorXonly: XA }), 'customer', MY_XONLY,
    );
    expect(check.ok).toBe(false);
  });

  it('타임락이 다르면 주소가 갈려 걸린다', () => {
    const shortened = deriveEscrowAddress({
      keys: { customer: MY_XONLY, sponsor: XS, admin: XA },
      network: 'signet', timelockBlocks: 144,
    }).address;
    const check = checkEscrowAddress(
      order({ escrowAddress: shortened }), 'customer', MY_XONLY,
    );
    expect(check.ok).toBe(false);
  });

  it('정보가 아직 안 왔으면 진행하지 않는다', () => {
    const check = checkEscrowAddress(order({ escrowAddress: undefined }), 'customer', MY_XONLY);
    expect(check.ok).toBe(false);
  });
});

/** 이 주문의 에스크로 */
const escrow = () => deriveEscrowAddress({
  keys: { customer: MY_XONLY, sponsor: XS, admin: XA }, network: 'signet',
});

/** 어드민이 보낼 법한 요청 PSBT */
function requestPsbt(p: {
  path: SettlementPath; destination: string; feeSat: number;
  txid?: string; valueSat?: number; signWith?: Uint8Array;
}): string {
  const tx = buildSettlementTx({
    descriptor: escrow(),
    input: { outpoint: { txid: p.txid ?? TXID, vout: 0 }, valueSat: p.valueSat ?? AMOUNT },
    path: p.path, destination: p.destination, feeSat: p.feeSat,
  });
  if (p.signWith) signSettlement(tx, p.signWith);
  return toPsbtBase64(tx);
}

describe('서명 요청 확인 — 릴리스 (T-109)', () => {
  const remitted = (over: Partial<OnchainOrder> = {}) => order({
    state: 'remitted', fundingOutpoint: formatOutpoint(TXID, 0),
    releaseFeeSat: 338, payoutSat: AMOUNT - 338, remittedAt: 1_700_000_000, ...over,
  });
  const release = (psbt: string, o = remitted()) =>
    checkSignRequest({ order: o, purpose: 'release', psbt, role: 'customer', myXonly: MY_XONLY });

  it('내 에스크로를 쓰고 얼마가 나가는지 알려준다', () => {
    const check = release(requestPsbt({ path: 'release', destination: PAYOUT, feeSat: 338, signWith: SK_S }));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.amountSat).toBe(AMOUNT - 338);
    expect(check.destination).toBe(PAYOUT);
    expect(check.counterparty?.xonly).toBe(XS);
  });

  /** 남의 UTXO를 쓰는 tx에 서명하면 엉뚱한 주문의 돈이 움직인다. */
  it('다른 UTXO를 쓰는 PSBT는 막는다', () => {
    const check = release(requestPsbt({
      path: 'release', destination: PAYOUT, feeSat: 338, txid: 'ee'.repeat(32), signWith: SK_S,
    }));
    expect(check.ok).toBe(false);
  });

  it('망가진 PSBT는 막는다', () => {
    expect(release('not-psbt').ok).toBe(false);
  });

  it('펀딩 기록이 없으면 막는다', () => {
    const psbt = requestPsbt({ path: 'release', destination: PAYOUT, feeSat: 338, signWith: SK_S });
    expect(release(psbt, remitted({ fundingOutpoint: undefined })).ok).toBe(false);
  });

  /**
   * 릴리스는 후원자 주소를 내가 모른다 — 그래서 **후원자 서명이 이 tx에 대해 유효한지**로
   * 묶는다. 어드민이 받는 주소를 바꾸고 원래 tx의 후원자 서명을 옮겨 심어도 안 통한다.
   */
  it('다른 tx의 후원자 서명을 옮겨 심은 PSBT는 막는다', () => {
    const honest = fromPsbtBase64(requestPsbt({ path: 'release', destination: PAYOUT, feeSat: 338, signWith: SK_S }));
    const leaf = honest.getInput(0).tapLeafScript![0]!;
    const sig = tapScriptSigOf(honest, XS)!;

    const forged = buildSettlementTx({
      descriptor: escrow(), input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'release', destination: EVIL, feeSat: 338,
    });
    addTapScriptSig(forged, leaf[1].subarray(0, -1), XS, sig);
    expect(release(toPsbtBase64(forged)).ok).toBe(false);
  });

  it('후원자 서명이 없으면 막는다', () => {
    expect(release(requestPsbt({ path: 'release', destination: PAYOUT, feeSat: 338 })).ok).toBe(false);
  });

  it('고객이 아닌 역할로는 확인하지 않는다', () => {
    const psbt = requestPsbt({ path: 'release', destination: PAYOUT, feeSat: 338, signWith: SK_S });
    expect(checkSignRequest({ order: remitted(), purpose: 'release', psbt, role: 'sponsor', myXonly: XS }).ok)
      .toBe(false);
  });
});

/**
 * T-120 — **환불 서명은 내가 낸 주소로 가는지** 본다.
 *
 * 전에는 "내 에스크로 UTXO를 쓰는가"만 봤다. 침해된 어드민이 `{A,C}` 리프로 **자기
 * 주소에 보내는 "환불"**을 보내면 화면이 "맞다"고 했고, 고객 서명 하나로 어드민이
 * 2-of-2를 완성했다.
 */
describe('서명 요청 확인 — 환불', () => {
  const refunding = (over: Partial<OnchainOrder> = {}) => order({
    state: 'refunding', fundingOutpoint: formatOutpoint(TXID, 0),
    settlementKind: 'refund:sponsor-timeout', settlementFeeSat: 300, ...over,
  });
  const refund = (psbt: string, refundAddress?: string, o = refunding()) =>
    checkSignRequest({ order: o, purpose: 'refund', psbt, role: 'customer', myXonly: MY_XONLY, refundAddress });

  it('내가 낸 환불 주소로 가면 통과한다', () => {
    const check = refund(requestPsbt({ path: 'refund', destination: REFUND, feeSat: 300 }), REFUND);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.destination).toBe(REFUND);
    expect(check.amountSat).toBe(AMOUNT - 300);
  });

  it('어드민 주소로 가는 "환불"은 막는다', () => {
    const check = refund(requestPsbt({ path: 'refund', destination: EVIL, feeSat: 300 }), REFUND);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/환불 주소가 아니다/);
  });

  /** 기기를 바꿔 기록이 없으면 "모른다"고 말하고 **서명하지 않는다** — 유저가 다시 입력하면 대조한다 */
  it('환불 주소를 모르면 서명하지 않고 입력을 청한다', () => {
    const check = refund(requestPsbt({ path: 'refund', destination: EVIL, feeSat: 300 }));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.needsRefundAddress).toBe(true);
  });

  it('환불 주소를 받기 전의 주문은 주문별 키 주소로 가는 환불을 받는다', () => {
    const legacy = deriveSingleKeyAddress(MY_XONLY, 'signet');
    expect(refund(requestPsbt({ path: 'refund', destination: legacy, feeSat: 300 })).ok).toBe(true);
  });

  /** 주소가 맞아도 채굴자에게 태우면 고객이 잃는다 */
  it('비정상 수수료는 막는다', () => {
    const o = refunding({ settlementFeeSat: 400_000 });
    const check = refund(requestPsbt({ path: 'refund', destination: REFUND, feeSat: 400_000 }), REFUND, o);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toMatch(/수수료/);
  });

  it('결정된 수수료와 다른 PSBT는 막는다', () => {
    expect(refund(requestPsbt({ path: 'refund', destination: REFUND, feeSat: 5_000 }), REFUND).ok).toBe(false);
  });

  it('환불이 결정되지 않은 주문이면 막는다', () => {
    const o = refunding({ state: 'remitted', settlementKind: undefined });
    expect(refund(requestPsbt({ path: 'refund', destination: REFUND, feeSat: 300 }), REFUND, o).ok).toBe(false);
  });

  it('구조 — 약정 밖 UTXO도 내 환불 주소로 가야만 통과한다', () => {
    const stray = { txid: 'cc'.repeat(32), valueSat: 70_000 };
    const good = requestPsbt({ path: 'refund', destination: REFUND, feeSat: 300, ...stray });
    const bad = requestPsbt({ path: 'refund', destination: EVIL, feeSat: 300, ...stray });
    const rescue = (psbt: string) => checkSignRequest({
      order: order({ state: 'cancelled' }), purpose: 'rescue', psbt, role: 'customer',
      myXonly: MY_XONLY, refundAddress: REFUND,
    });
    expect(rescue(good).ok).toBe(true);
    expect(rescue(bad).ok).toBe(false);
  });
});

describe('서명 요청 확인 — 후원자승 집행', () => {
  const ruled = () => order({
    state: 'disputed', fundingOutpoint: formatOutpoint(TXID, 0),
    settlementKind: 'sponsor_win', settlementFeeSat: 300,
  });
  const check = (destination: string, payoutAddress: string) => checkSignRequest({
    order: ruled(), purpose: 'dispute-sponsor', role: 'sponsor', myXonly: XS, payoutAddress,
    psbt: requestPsbt({ path: 'sponsor-win', destination, feeSat: 300 }),
  });

  it('내가 낸 받을 주소면 통과한다', () => {
    expect(check(PAYOUT, PAYOUT).ok).toBe(true);
  });

  it('다른 주소면 막는다', () => {
    expect(check(EVIL, PAYOUT).ok).toBe(false);
  });
});

describe('가격 유효창 (O-016)', () => {
  const remitted = (at: number) => order({ state: 'remitted', remittedAt: at });

  /** 정직한 지연 거래에는 마찰이 없어야 한다 — 24시간 안이면 프롬프트가 안 뜬다. */
  it('24시간 안이면 우회 프롬프트가 없다', () => {
    const t = 1_700_000_000;
    expect(releaseNeedsPriceOverride(remitted(t), t * 1000 + 3600_000)).toBe(false);
  });

  /** 후원자가 늦게 보내 **낡은 가격으로 체결**시키는 걸 막는 마지막 방어선. */
  it('24시간을 넘기면 경고한다', () => {
    const t = 1_700_000_000;
    expect(releaseNeedsPriceOverride(remitted(t), (t + 86_401) * 1000)).toBe(true);
  });
});

describe('후원자 사전서명', () => {
  const funded = () => {
    const descriptor = deriveEscrowAddress({
      keys: { customer: MY_XONLY, sponsor: XS, admin: XA }, network: 'signet',
    });
    return order({
      state: 'funded',
      fundingOutpoint: formatOutpoint(TXID, 0),
      fundedAt: Math.floor(Date.now() / 1000),
      releaseFeeSat: settlementFeeSat('release', descriptor, PAYOUT, 2),
    });
  };

  beforeEach(() => {
    claims.rememberMyClaim({ orderId: ORDER_ID, payoutAddress: PAYOUT, feerateSatPerVb: 2 });
  });

  it('내가 낸 주소·feerate로 만들어 서명한다', async () => {
    const result = await buildPresignature(funded());
    expect(result.ok).toBe(true);
  });

  /**
   * ⚠️ **어드민이 준 PSBT에 서명하지 않는다.** 그러면 그게 내 주소로 가는지
   * 어드민 말만 믿는 셈이다. 내가 다시 만들어 서명한다.
   *
   * 그리고 어드민이 고정한 수수료가 내가 낸 feerate에서 나온 값인지 본다 —
   * 다르면 **내가 덜 받는다**(부담자가 나다).
   */
  it('오더의 릴리스 수수료가 내 feerate와 안 맞으면 거부한다', async () => {
    const o = funded();
    const result = await buildPresignature({ ...o, releaseFeeSat: o.releaseFeeSat! + 500 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/수수료가 내가 낸 값과 다르다/);
  });

  it('내가 낸 주소 기록이 없으면 만들지 않는다', async () => {
    claims._resetForTesting();
    const result = await buildPresignature(funded());
    expect(result.ok).toBe(false);
  });

  it('펀딩 확정 전에는 만들 수 없다', async () => {
    const result = await buildPresignature(order({ state: 'bonded' }));
    expect(result.ok).toBe(false);
  });

  /**
   * T-121 — 마감이 지난 사전서명은 **만들지도 않는다.** 어드민이 받지 않고,
   * 받았던 시절에는 이미 결정된 환불과 얽혀 고객 서명 하나로 둘 다 완성되는 tx가 나왔다.
   */
  it('사전서명 마감이 지났으면 만들지 않는다', async () => {
    const late = { ...funded(), fundedAt: Math.floor(Date.now() / 1000) - PRESIGN_WINDOW_SEC - 1 };
    const result = await buildPresignature(late);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/마감/);
  });

  it('환불이 결정된 주문이면 만들지 않는다', async () => {
    const result = await buildPresignature({
      ...funded(), state: 'refunding', settlementKind: 'refund:sponsor-timeout',
    });
    expect(result.ok).toBe(false);
  });
});

describe('최종 서명', () => {
  /**
   * 받은 PSBT에 그대로 서명하지 않는다 — **검증된 재료로 다시 만든 tx**에 서명하고,
   * 릴리스면 검증된 후원자 서명을 옮겨 심는다.
   */
  it('검증된 재료로 다시 만들어 두 서명이 다 든 PSBT를 낸다', async () => {
    const o = order({
      state: 'remitted', fundingOutpoint: formatOutpoint(TXID, 0),
      releaseFeeSat: 338, payoutSat: AMOUNT - 338,
    });
    const psbt = requestPsbt({ path: 'release', destination: PAYOUT, feeSat: 338, signWith: SK_S });
    const check = checkSignRequest({ order: o, purpose: 'release', psbt, role: 'customer', myXonly: MY_XONLY });
    expect(check.ok).toBe(true);

    const result = await buildCosignature(ORDER_ID, check);
    expect(result.ok).toBe(true);
    if (!result.ok || !check.ok) return;

    const signed = fromPsbtBase64(result.psbt);
    expect(signed.id).toBe(fromPsbtBase64(psbt).id);
    expect(tapScriptSigOf(signed, XS)).toHaveLength(64);
    expect(tapScriptSigOf(signed, MY_XONLY)).toHaveLength(64);
    // 옮겨 심은 후원자 서명이 새 tx에서도 유효하다
    expect(verifyPresignature({ psbtBase64: result.psbt, expected: check.expected, signerXonly: XS }).ok).toBe(true);
  });

  it('확인에 실패한 요청은 서명하지 않는다', async () => {
    const result = await buildCosignature(ORDER_ID, { ok: false, reason: '받는 주소가 내 환불 주소가 아니다' });
    expect(result.ok).toBe(false);
  });

  it('내 키가 그 리프에 없으면 실패를 값으로 돌려준다', async () => {
    const descriptor = deriveEscrowAddress({
      keys: { customer: xonlyFromPrivkey(SK_EVIL), sponsor: XS, admin: XA }, network: 'signet',
    });
    const result = await buildCosignature(ORDER_ID, {
      ok: true, destination: REFUND, amountSat: AMOUNT - 300, feeSat: 300,
      expected: {
        descriptor, input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
        path: 'refund', destination: REFUND, feeSat: 300,
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe('타임락 안전망 (T-106)', () => {
  const o = () => order({ state: 'presigned', timelockBlocks: 8064 });

  /**
   * 라이트닝에서 같은 모양의 버그를 겪었다 — 에스크로가 2시간 남았는데 6시간짜리
   * 인보이스를 받아줘서 후원자만 잃었다. **되돌릴 수 없는 행동
   * 직전에 내 보호 창이 살아 있는지** 확인시킨다.
   */
  it('잔여가 넉넉하면 보내도 된다', () => {
    const status = timelockStatus(o(), 10);
    expect(status.safeToRemit).toBe(true);
    expect(status.remainingBlocks).toBe(8054);
  });

  it('임계 아래면 막는다', () => {
    const status = timelockStatus(o(), 8064 - TIMELOCK_REMIT_THRESHOLD_BLOCKS + 1);
    expect(status.safeToRemit).toBe(false);
    expect(status.reason).toMatch(/혼자 회수/);
  });

  /** ⚠️ 모르는 걸 "여유 있다"로 치면 이 안전망이 없는 것과 같다. */
  it('컨펌 수를 모르면 막는다', () => {
    expect(timelockStatus(o(), undefined).safeToRemit).toBe(false);
  });

  it('타임락 값을 모르면 막는다', () => {
    expect(timelockStatus(order({ timelockBlocks: undefined }), 10).safeToRemit).toBe(false);
  });
});

// ─── 스냅샷 안정성 ───────────────────────────────────────────

/**
 * ⚠️ `useSyncExternalStore`의 스냅샷이 호출마다 새 객체면 **무한 렌더 루프**다.
 * 어드민 화면이 그래서 통째로 안 떴다(2026-09-21). 타입·빌드·테스트가 다
 * 통과하고 화면을 열어야만 드러나는 종류라, 스토어별로 못박는다.
 */
describe('스토어 스냅샷은 참조가 안정해야 한다', () => {
  it('오더·서명요청·보증금 인보이스', async () => {
    const store = await import('../onchain/store');
    const signReq = await import('../onchain/sign-request-store');
    const deposit = await import('../onchain/deposit-store');

    const pending = await import('../onchain/pending-request-store');

    for (const get of [
      store.getOnchainOrdersSnapshot,
      signReq.getSignRequestsSnapshot,
      deposit.getDepositInvoicesSnapshot,
      pending.getPendingRequestsSnapshot,
    ]) {
      expect(get()).toBe(get());
    }
  });
});

/**
 * ⚠️ 의뢰 등록은 요청 이벤트를 쏘는 것으로 끝나고 **오더는 보증금을 결제해야**
 * 생긴다. 그 사이에 거절되거나 실패하면 유저 쪽에 흔적이 하나도 없다 —
 * 실제로 의뢰 두 건 중 하나가 그렇게 사라졌다(2026-09-21).
 */
describe('보낸 등록 요청은 답이 올 때까지 남는다', () => {
  it('기억했다가 인보이스·오더가 오면 지운다', async () => {
    const pending = await import('../onchain/pending-request-store');
    pending._resetForTesting();

    pending.rememberPendingRequest({
      orderId: 'oc-1', amountSat: 50_000, expiration: 2_000_000_000, submittedAt: 1,
    });
    expect(Object.keys(pending.getPendingRequestsSnapshot())).toEqual(['oc-1']);

    pending.forgetPendingRequest('oc-1');
    expect(pending.getPendingRequestsSnapshot()).toEqual({});
  });

  it('거절 사유가 남는다 (조용히 사라지지 않는다)', async () => {
    const pending = await import('../onchain/pending-request-store');
    pending._resetForTesting();

    pending.rememberPendingRequest({
      orderId: 'oc-2', amountSat: 1000, expiration: 2_000_000_000, submittedAt: 1,
    });
    pending.markRequestRejected('oc-2', '최소 거래액 미만');

    expect(pending.getPendingRequestsSnapshot()['oc-2']?.rejectedReason)
      .toBe('최소 거래액 미만');
  });

  it('모르는 주문의 거절은 무시한다', async () => {
    const pending = await import('../onchain/pending-request-store');
    pending._resetForTesting();
    pending.markRequestRejected('없는주문', '사유');
    expect(pending.getPendingRequestsSnapshot()).toEqual({});
  });
});

/**
 * ⚠️ 계좌는 **고객이 후원자에게 직접** 보낸다(어드민도 못 본다). 필드 이름이
 * `AccountInfo`와 어긋나면 파싱이 실패해 **계좌가 통째로 안 뜨고**, 후원자는
 * 어디로 보낼지 모른 채 마감 시계만 흐른다(2026-09-21 실측).
 */
describe('계좌 정보 (후원자 수신)', () => {
  it('AccountInfo 모양 그대로 저장된다', async () => {
    const { parseAccountInfoEnvelope } = await import('@sajwo-tracker/shared');
    const store = await import('../onchain/account-store');
    store._resetForTesting();

    // 고객 앱이 실제로 보내는 모양
    const sent = JSON.stringify({
      bankName: '국민', accountNumber: '123-456', holderName: '홍길동',
    });
    const envelope = parseAccountInfoEnvelope(sent);
    expect(envelope?.accountInfo.holderName).toBe('홍길동');

    store.putOnchainAccount('oc-1', { accountInfo: envelope!.accountInfo, salt: envelope!.salt });
    expect(store.getOnchainAccount('oc-1')?.accountInfo.accountNumber).toBe('123-456');
  });

  /** 계좌가 나간 뒤 바뀌면 후원자가 이미 본 계좌와 달라진다. */
  it('먼저 온 것을 유지한다', async () => {
    const store = await import('../onchain/account-store');
    store._resetForTesting();
    store.putOnchainAccount('oc-1', { accountInfo: { bankName: 'A', accountNumber: '1', holderName: '갑' }, salt: 's1' });
    store.putOnchainAccount('oc-1', { accountInfo: { bankName: 'B', accountNumber: '2', holderName: '을' }, salt: 's2' });
    expect(store.getOnchainAccount('oc-1')?.accountInfo.bankName).toBe('A');
  });

  it('스냅샷 참조가 안정하다', async () => {
    const store = await import('../onchain/account-store');
    expect(store.getOnchainAccountsSnapshot()).toBe(store.getOnchainAccountsSnapshot());
  });
});

describe('보증금 금액 표시', () => {
  it('디코딩 실패는 화면을 깨뜨리지 않는다', async () => {
    const { depositAmountText, depositAmountSat } = await import('../onchain/deposit-amount');
    expect(depositAmountText('not-an-invoice')).toBe('');
    expect(depositAmountSat('not-an-invoice')).toBeNull();
  });
});

// ─── O-020 — 발신자 확인 ─────────────────────────────

function inbox(pubkey: string, orderId: string, action: string, extra: string[][] = [], content = ''): Event {
  return {
    id: `ev-${Math.random()}`, pubkey, kind: MESSAGE_KIND, created_at: 1_700_000_000,
    tags: [['a', `${ORDER_KIND}:${APP_PUBKEY}:${orderId}`], ['action', action], ['t', CLIENT_TAG_ONCHAIN], ...extra],
    content, sig: 'sig',
  };
}

const ACCOUNT = { bankName: '국민', accountNumber: '123-456', holderName: '홍길동' };
const FAKE_ACCOUNT = { bankName: '대포', accountNumber: '999-999', holderName: '공격자' };
const accountEvent = (from: string, info = ACCOUNT) =>
  inbox(from, 'oc-acc', 'account-info', [], `enc:${JSON.stringify({ accountInfo: info, salt: 'salt' })}`);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

/**
 * 후원자 pubkey는 오더 태그에 공개돼 있다. 전에는 **아무나 보낸 계좌**를 받았고, 스토어가
 * 먼저 온 것을 유지해서 제3자가 먼저 쏜 가짜 계좌가 진짜 고객 계좌를 밀어냈다 —
 * 후원자가 공격자 계좌로 원화를 보내는 경로다.
 */
describe('T-119 — 계좌는 오더의 고객이 보낸 것만 받는다', () => {
  const service = () => import('../onchain/nostr/service');
  const accounts = () => import('../onchain/account-store');
  const store = () => import('../onchain/store');

  beforeEach(async () => {
    ME = 'spon';
    (await accounts())._resetForTesting();
    (await store())._resetForTesting();
  });

  const seed = async () => (await store()).upsertOnchainOrder(order({
    orderId: 'oc-acc', state: 'presigned', customerPubkey: 'cust', sponsorPubkey: 'spon',
  }));

  it('제3자가 먼저 쏜 가짜 계좌는 버리고, 고객 계좌를 받는다', async () => {
    await seed();
    const { handleInboxEvent } = await service();
    await handleInboxEvent(accountEvent('stranger', FAKE_ACCOUNT));
    expect((await accounts()).getOnchainAccount('oc-acc')).toBeUndefined();

    await handleInboxEvent(accountEvent('cust'));
    expect((await accounts()).getOnchainAccount('oc-acc')?.accountInfo.accountNumber).toBe('123-456');
  });

  /** 새로고침하면 두 구독이 따로 돌아 계좌가 오더보다 먼저 올 수 있다 — 버리면 진짜 계좌를 잃는다 */
  it('오더보다 먼저 온 계좌는 오더가 오면 판정한다', async () => {
    const { handleInboxEvent, handleOrderEvent } = await service();
    await handleInboxEvent(accountEvent('stranger', FAKE_ACCOUNT));
    await handleInboxEvent(accountEvent('cust'));
    expect((await accounts()).getOnchainAccount('oc-acc')).toBeUndefined();

    const o = order({ orderId: 'oc-acc', state: 'presigned', customerPubkey: 'cust', sponsorPubkey: 'spon', updatedAt: 5 });
    await handleOrderEvent({
      id: 'ord', pubkey: APP_PUBKEY, kind: ORDER_KIND, created_at: 5,
      tags: onchainOrderTags(o, CLIENT_TAG_ONCHAIN), content: '', sig: 'sig',
    }, 'spon');
    await flush();
    expect((await accounts()).getOnchainAccount('oc-acc')?.accountInfo.holderName).toBe('홍길동');
  });

  it('내가 그 주문의 후원자가 아니면 받지 않는다', async () => {
    ME = 'someone-else';
    await seed();
    await (await service()).handleInboxEvent(accountEvent('cust'));
    expect((await accounts()).getOnchainAccount('oc-acc')).toBeUndefined();
  });
});

/**
 * 전에는 수신함이 발신자를 안 봐서, 제3자가 `deposit-required`에 **자기 인보이스**를
 * 실어 보내면 그게 "보증금 결제" 화면에 떴다. 라이트닝 트랙은 이미 막고 있던 자리다.
 */
describe('O-020 — 어드민 통지는 어드민이 보낸 것만 받는다', () => {
  beforeEach(async () => {
    (await import('../onchain/deposit-store'))._resetForTesting();
    (await import('../onchain/sign-request-store'))._resetForTesting();
  });

  it('가짜 보증금 인보이스를 버린다', async () => {
    const { handleInboxEvent } = await import('../onchain/nostr/service');
    const deposits = await import('../onchain/deposit-store');

    await handleInboxEvent(inbox('stranger', 'oc-dep', 'deposit-required', [['bolt11', 'lnbc-evil']]));
    expect(deposits.getDepositInvoice('oc-dep')).toBeUndefined();

    await handleInboxEvent(inbox(APP_PUBKEY, 'oc-dep', 'deposit-required', [['bolt11', 'lnbc-real']]));
    expect(deposits.getDepositInvoice('oc-dep')?.bolt11).toBe('lnbc-real');
  });

  it('가짜 서명 요청을 버린다', async () => {
    const { handleInboxEvent } = await import('../onchain/nostr/service');
    const requests = await import('../onchain/sign-request-store');
    const psbt = requestPsbt({ path: 'refund', destination: EVIL, feeSat: 300 });

    await handleInboxEvent(inbox('stranger', 'oc-sig', 'onchain-cosign', [['purpose', 'refund']], `enc:${JSON.stringify({ psbt })}`));
    expect(requests.signRequestsFor(requests.getSignRequestsSnapshot(), 'oc-sig')).toHaveLength(0);

    await handleInboxEvent(inbox(APP_PUBKEY, 'oc-sig', 'onchain-cosign', [['purpose', 'refund']], `enc:${JSON.stringify({ psbt })}`));
    expect(requests.signRequestsFor(requests.getSignRequestsSnapshot(), 'oc-sig')).toHaveLength(1);
  });
});

/**
 * 서명 요청은 **주문 × 목적**으로 쌓인다. 전에는 주문당 하나라 분쟁 판정
 * 요청이 도착하면 아직 안 누른 릴리스 요청을 덮어썼다. 구조는 UTXO마다 따로다.
 */
describe('서명 요청 스토어', () => {
  it('목적이 다르면 따로 남고, 하나를 지워도 나머지는 남는다', async () => {
    const r = await import('../onchain/sign-request-store');
    r._resetForTesting();
    r.putSignRequest({ orderId: 'o', purpose: 'release', psbt: 'a', receivedAt: 1 });
    r.putSignRequest({ orderId: 'o', purpose: 'dispute-customer', psbt: 'b', receivedAt: 2 });
    r.putSignRequest({ orderId: 'o', purpose: 'rescue', psbt: 'c', receivedAt: 3, outpoint: 'x:0' });
    r.putSignRequest({ orderId: 'o', purpose: 'rescue', psbt: 'd', receivedAt: 4, outpoint: 'y:1' });
    expect(r.signRequestsFor(r.getSignRequestsSnapshot(), 'o')).toHaveLength(4);

    r.clearSignRequest({ orderId: 'o', purpose: 'release' });
    expect(r.signRequestsFor(r.getSignRequestsSnapshot(), 'o').map(x => x.psbt).sort()).toEqual(['b', 'c', 'd']);

    // 주문이 끝나도 **구조 요청은 남는다** — 약정 밖 자금이라 FSM 종결과 무관하다
    r.clearSignRequestsFor('o');
    expect(r.signRequestsFor(r.getSignRequestsSnapshot(), 'o').map(x => x.purpose)).toEqual(['rescue', 'rescue']);
  });
});
