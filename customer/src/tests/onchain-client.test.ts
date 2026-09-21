/**
 * 온체인 클라이언트 로직 (PLAN-ONCHAIN-TRACK §3.4 · §6.1b · §7.1)
 *
 * 여기가 **유저를 지키는 마지막 줄**이다. 어드민이 악의적이거나 침해당했을 때,
 * 혹은 후원자가 유리한 tx를 밀어 넣을 때 막아야 하는 자리가 전부 클라이언트다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildSettlementTx, deriveEscrowAddress, deriveSingleKeyAddress, formatOutpoint,
  settlementFeeSat, signSettlement, toPsbtBase64, xonlyFromPrivkey,
  type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const SK_S = sk(40), SK_A = sk(80), SK_D = sk(120), SK_EVIL = sk(200);

// 내 nostr 키는 고정 — 주문별 키 파생이 결정론적이어야 한다
vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  getSecretKey: async () => sk(1),
  storage: {},
}));

const { myOrderKey, _clearKeyCache } = await import('../onchain/keys');
const { checkEscrowAddress, inspectSettlementPsbt, releaseNeedsPriceOverride } =
  await import('../onchain/verify');
const { buildPresignature, cosignSettlement, timelockStatus, TIMELOCK_BLOCK_THRESHOLD } =
  await import('../onchain/actions');
const claims = await import('../onchain/claim-store');

const ORDER_ID = 'order-1';
const TXID = 'd4'.repeat(32);
const AMOUNT = 500_000;

let MY_XONLY = '';
const XS = xonlyFromPrivkey(SK_S);
const XA = xonlyFromPrivkey(SK_A);
const PAYOUT = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'signet');

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
    orderId: ORDER_ID, state: 'bonded', status: 'active',
    customerPubkey: 'cust', sponsorPubkey: 'spon', amountSat: AMOUNT,
    createdAt: 1, updatedAt: 1, expiration: 2_000_000_000, network: 'signet',
    customerXonly: MY_XONLY, sponsorXonly: XS, adminXonly: XA,
    escrowAddress: descriptor.address, timelockBlocks: descriptor.timelockBlocks,
    raw: {},
    ...over,
  };
}

describe('주문별 키 (§3.2)', () => {
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

describe('주소 독립 검증 (T-107 · 공격 G)', () => {
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

  /** 두 키가 같으면 2-of-3 보장이 사라진다 (공격 H). */
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

describe('서명 요청 PSBT 확인 (§7 I)', () => {
  const funded = () => order({
    state: 'remitted', fundingOutpoint: formatOutpoint(TXID, 0),
    releaseFeeSat: 338, remittedAt: 1_700_000_000,
  });

  function psbtFor(over: { txid?: string; feeSat?: number } = {}): string {
    const o = funded();
    const descriptor = deriveEscrowAddress({
      keys: { customer: MY_XONLY, sponsor: XS, admin: XA }, network: 'signet',
    });
    const tx = buildSettlementTx({
      descriptor,
      input: { outpoint: { txid: over.txid ?? TXID, vout: 0 }, valueSat: o.amountSat },
      path: 'release', destination: PAYOUT, feeSat: over.feeSat ?? 338,
    });
    signSettlement(tx, SK_S);
    return toPsbtBase64(tx);
  }

  it('내 에스크로를 쓰고 얼마가 나가는지 알려준다', () => {
    const check = inspectSettlementPsbt(funded(), psbtFor());
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.amountSat).toBe(AMOUNT - 338);
  });

  /** 남의 UTXO를 쓰는 tx에 서명하면 엉뚱한 주문의 돈이 움직인다. */
  it('다른 UTXO를 쓰는 PSBT는 막는다', () => {
    const check = inspectSettlementPsbt(funded(), psbtFor({ txid: 'ee'.repeat(32) }));
    expect(check.ok).toBe(false);
  });

  it('망가진 PSBT는 막는다', () => {
    expect(inspectSettlementPsbt(funded(), 'not-psbt').ok).toBe(false);
  });

  it('펀딩 기록이 없으면 막는다', () => {
    expect(inspectSettlementPsbt(order(), psbtFor()).ok).toBe(false);
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

describe('후원자 사전서명 (§2.4 · §6.1b)', () => {
  const funded = () => {
    const descriptor = deriveEscrowAddress({
      keys: { customer: MY_XONLY, sponsor: XS, admin: XA }, network: 'signet',
    });
    return order({
      state: 'funded',
      fundingOutpoint: formatOutpoint(TXID, 0),
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
});

describe('최종 서명', () => {
  it('받은 PSBT에 내 서명을 얹는다 (상대 서명을 날리지 않는다)', async () => {
    const descriptor = deriveEscrowAddress({
      keys: { customer: MY_XONLY, sponsor: XS, admin: XA }, network: 'signet',
    });
    const tx = buildSettlementTx({
      descriptor,
      input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'release', destination: PAYOUT, feeSat: 338,
    });
    signSettlement(tx, SK_S);
    const before = toPsbtBase64(tx);

    const result = await cosignSettlement(ORDER_ID, before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 두 서명이 다 들어 있어야 완성된다
    const { fromPsbtBase64, tapScriptSigOf } = await import('@sajwo-tracker/shared/onchain');
    const signed = fromPsbtBase64(result.psbt);
    expect(tapScriptSigOf(signed, XS)).toHaveLength(64);
    expect(tapScriptSigOf(signed, MY_XONLY)).toHaveLength(64);
  });

  it('내 키가 그 리프에 없으면 실패를 값으로 돌려준다', async () => {
    const descriptor = deriveEscrowAddress({
      keys: { customer: xonlyFromPrivkey(SK_EVIL), sponsor: XS, admin: XA }, network: 'signet',
    });
    const tx = buildSettlementTx({
      descriptor,
      input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'release', destination: PAYOUT, feeSat: 338,
    });
    const result = await cosignSettlement(ORDER_ID, toPsbtBase64(tx));
    expect(result.ok).toBe(false);
  });
});

describe('타임락 안전망 (T-106 · §7.1)', () => {
  const o = () => order({ state: 'presigned', timelockBlocks: 8064 });

  /**
   * 라이트닝에서 같은 모양의 버그를 겪었다 — 에스크로가 2시간 남았는데 6시간짜리
   * 인보이스를 받아줘서 후원자만 잃었다(AUDIT-EXPIRY F2). **되돌릴 수 없는 행동
   * 직전에 내 보호 창이 살아 있는지** 확인시킨다.
   */
  it('잔여가 넉넉하면 보내도 된다', () => {
    const status = timelockStatus(o(), 10);
    expect(status.safeToRemit).toBe(true);
    expect(status.remainingBlocks).toBe(8054);
  });

  it('임계 아래면 막는다', () => {
    const status = timelockStatus(o(), 8064 - TIMELOCK_BLOCK_THRESHOLD + 1);
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
 * ⚠️ 의뢰 등록은 kind 1111을 쏘는 것으로 끝나고 **오더는 보증금을 결제해야**
 * 생긴다(§4.1b). 그 사이에 거절되거나 실패하면 유저 쪽에 흔적이 하나도 없다 —
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

    store.putOnchainAccount('oc-1', envelope!.accountInfo);
    expect(store.getOnchainAccount('oc-1')?.accountNumber).toBe('123-456');
  });

  /** 계좌가 나간 뒤 바뀌면 후원자가 이미 본 계좌와 달라진다. */
  it('먼저 온 것을 유지한다', async () => {
    const store = await import('../onchain/account-store');
    store._resetForTesting();
    store.putOnchainAccount('oc-1', { bankName: 'A', accountNumber: '1', holderName: '갑' });
    store.putOnchainAccount('oc-1', { bankName: 'B', accountNumber: '2', holderName: '을' });
    expect(store.getOnchainAccount('oc-1')?.bankName).toBe('A');
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
