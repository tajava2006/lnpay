/**
 * 온체인 워처의 집행 (PLAN-ONCHAIN-TRACK §9)
 *
 * 판단은 `decide.ts`가 하고 여기서는 **집행만** 한다. 그래서 이 테스트가 보는 건
 * "그 판단이 났을 때 **무엇을 건드리는가**"다 — 특히 리오그에서 **가격 고정이
 * 실제로 지워지는지**, 종결 준비가 **한 번만** 나가는지.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FUNDING_WINDOW_SEC, buildSettlementTx, deriveEscrowAddress, finalizeSettlement, formatOutpoint,
  signSettlement, xonlyFromPrivkey, bytesToHex, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import type {
  AddressFunds, ChainAdapter, ChainQuery, ChainUtxo, FeeEstimates, SpendInfo, TxStatus,
} from '@sajwo-tracker/shared/onchain';
import {
  SIGNATURE_RESEND_SEC, TERMINAL_WATCH_INTERVAL_SEC, _resetWatcherForTesting,
  executeOnchainAction, gatherPinnedFacts, tickOnchainOrder, type OnchainWatcherDeps,
} from '../onchain/watcher';

const NOW = 1_700_000_000;
const TXID = 'd4'.repeat(32);
const AMOUNT = 500_000;
const FEE = 338;

function order(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'o-1', state: 'bonded', status: 'active',
    customerPubkey: 'cust', sponsorPubkey: 'spon', amountSat: AMOUNT,
    createdAt: NOW - 1000, updatedAt: NOW - 1000,
    expiration: NOW + 86_400, network: 'signet',
    escrowAddress: 'tb1pescrow', fundingDeadline: NOW + FUNDING_WINDOW_SEC,
    raw: {},
    ...over,
  };
}

function utxo(over: Partial<ChainUtxo> = {}): ChainUtxo {
  return { txid: TXID, vout: 0, valueSat: AMOUNT, confirmations: 3, ...over };
}

function chainWith(
  funds: ChainQuery<AddressFunds>,
  tx?: ChainQuery<TxStatus>,
  spend?: ChainQuery<SpendInfo>,
): ChainAdapter {
  const unknown = <T>(reason: string): ChainQuery<T> => ({ known: false, reason });
  return {
    getAddressFunds: vi.fn(async () => funds),
    getTxStatus: vi.fn(async () => tx ?? unknown<TxStatus>('안 물어봄')),
    getSpend: vi.fn(async () => spend ?? unknown<SpendInfo>('안 물어봄')),
    getFeeEstimates: vi.fn(async () => unknown<FeeEstimates>('n/a')),
    getTipHeight: vi.fn(async () => unknown<number>('n/a')),
    broadcastTx: vi.fn(async () => unknown<string>('n/a')),
  };
}

interface Harness {
  deps: OnchainWatcherDeps;
  committed: Array<{ orderId: string; patch: Record<string, unknown>; guard?: { ifUnchangedSince?: number } }>;
  outcomes: string[];
  raised: Array<{ level: string; why: string }>;
  decided: Array<{ kind: string; fold: boolean }>;
  rescues: Array<Array<{ txid: string; vout: number; valueSat: number }>>;
  calls: string[];
}

function harness(over: Partial<OnchainWatcherDeps> = {}): Harness {
  const committed: Harness['committed'] = [];
  const outcomes: string[] = [];
  const raised: Harness['raised'] = [];
  const decided: Harness['decided'] = [];
  const rescues: Harness['rescues'] = [];
  const calls: string[] = [];

  const deps: OnchainWatcherDeps = {
    now: () => NOW,
    chain: chainWith({ known: true, value: { confirmed: [], mempool: [] } }),
    btcPriceKrw: () => 100_000_000,
    sponsorBondAlive: vi.fn(async () => true),
    accountInfoSent: () => false,
    releaseFeeSat: () => FEE,
    commit: async (orderId, patch, guard) => {
      committed.push({ orderId, patch: patch as Record<string, unknown>, guard });
      return { ...order(), ...(patch as Partial<OnchainOrder>), orderId };
    },
    decideSettlement: async (_o, kind, opts) => {
      decided.push({ kind, fold: Boolean(opts?.fold) });
      return null;
    },
    requestSignature: async o => { calls.push(`request:${o.orderId}`); },
    lastSignatureRequestAt: () => NOW,
    outboxTxid: () => undefined,
    flushOutbox: async o => { calls.push(`flush:${o.orderId}`); },
    rebroadcast: async o => { calls.push(`rebroadcast:${o.orderId}`); },
    onOutcome: (_o, outcome) => outcomes.push(outcome),
    raise: (_o, level, why) => raised.push({ level, why }),
    raiseRescue: (_o, utxos) => rescues.push(utxos),
    notifyDisputeSoon: o => { calls.push(`dispute-soon:${o.orderId}`); },
    listOrders: () => [],
    getOrder: () => undefined,
    checkDeposits: async () => {},
    ...over,
  };
  return { deps, committed, outcomes, raised, decided, rescues, calls };
}

beforeEach(() => _resetWatcherForTesting());

describe('fund — 가격 고정', () => {
  it('outpoint·컨펌·가격·payout을 한 번에 박는다', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } }),
    });
    await tickOnchainOrder(order(), h.deps);

    expect(h.committed).toHaveLength(1);
    expect(h.committed[0]!.patch).toMatchObject({
      state: 'funded',
      fundingOutpoint: formatOutpoint(TXID, 0),
      fundingConfs: 3,
      fundedAt: NOW,
      priceKrw: 500_000,
      payoutSat: AMOUNT - FEE,
      releaseFeeSat: FEE,
    });
  });

  /**
   * 후원자가 `bonded`에서 주소·feerate를 냈어야 한다. 없으면 우리 기록이
   * 깨진 것이라 **가격을 임의로 고정하면 안 된다.**
   */
  it('릴리스 수수료를 모르면 사람을 부르고 멈춘다', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } }),
      releaseFeeSat: () => undefined,
    });
    await tickOnchainOrder(order(), h.deps);

    expect(h.committed).toHaveLength(0);
    expect(h.raised[0]!.level).toBe('anomaly');
  });

  it('수수료가 거래액을 먹으면 멈춘다', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } }),
      releaseFeeSat: () => AMOUNT,
    });
    await tickOnchainOrder(order(), h.deps);
    expect(h.committed).toHaveLength(0);
    expect(h.raised[0]!.level).toBe('anomaly');
  });
});

describe('fold — 가격을 고정하지 않고 접는다', () => {
  /**
   * 리뷰 #8 — 전에는 가격 없이 `funded`를 발행했다. 후원자에게 "금액이 확정됐으니
   * 15분 안에 서명" 푸시가 가고, 화면은 "넘기면 몰수" 카운트다운을 띄웠다. 이제
   * `bonded → refunding`으로 곧장 결정한다.
   */
  it('보증금이 죽었으면 funded를 거치지 않고 환불을 결정한다', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } }),
      sponsorBondAlive: async () => false,
    });
    await tickOnchainOrder(order(), h.deps);

    expect(h.committed).toHaveLength(0);
    expect(h.decided).toEqual([{ kind: 'refund:bond-expired', fold: true }]);
  });
});

describe('cancel — 사유가 곧 보증금 처리다', () => {
  it('의뢰 만료는 무과실(cancel:expired)', async () => {
    const h = harness();
    await executeOnchainAction(
      order({ state: 'listed', expiration: NOW - 1 }), { kind: 'cancel' }, h.deps,
    );
    expect(h.committed[0]!.patch).toMatchObject({ state: 'cancelled' });
    expect(h.outcomes).toEqual(['cancel:expired']);
  });

  /** 안 쐈든 되돌렸든 수수료가 낮았든 **전부 한 사유**다 (§4.1c). */
  it('마감까지 미컨펌은 고객 몰수(cancel:no-funding)', async () => {
    const h = harness();
    await executeOnchainAction(order({ state: 'bonded' }), { kind: 'cancel' }, h.deps);
    expect(h.outcomes).toEqual(['cancel:no-funding']);
  });
});

describe('reorg — 가격 고정을 실제로 지운다 (O-008)', () => {
  const funded = order({
    state: 'funded', fundingOutpoint: formatOutpoint(TXID, 0), fundedAt: NOW - 100,
    priceKrw: 500_000, payoutSat: AMOUNT - FEE, releaseFeeSat: FEE,
    presignedAt: NOW - 50, accountSentAt: NOW - 40, krwDeadline: NOW + 100,
  });

  it('funded-era 필드가 전부 비워진다', async () => {
    const h = harness();
    await executeOnchainAction(funded, { kind: 'reorg', why: 'gone' }, h.deps);

    const patch = h.committed[0]!.patch;
    expect(patch.state).toBe('bonded');
    for (const field of [
      'fundingOutpoint', 'fundingConfs', 'fundedAt', 'priceKrw', 'payoutSat',
      'releaseFeeSat', 'presignedAt', 'accountSentAt', 'krwDeadline',
    ]) {
      expect(patch, field).toHaveProperty(field, undefined);
    }
  });

  /** ⚠️ 마감을 다시 안 찍으면 **체인 사고로 정직한 고객이 몰수된다**(§4.1c). */
  it('펀딩 마감을 다시 찍는다', async () => {
    const h = harness();
    await executeOnchainAction(funded, { kind: 'reorg', why: 'shallow' }, h.deps);
    expect(h.committed[0]!.patch.fundingDeadline).toBe(NOW + FUNDING_WINDOW_SEC);
  });

  it('사람에게도 알린다', async () => {
    const h = harness();
    await executeOnchainAction(funded, { kind: 'reorg', why: 'gone' }, h.deps);
    expect(h.raised[0]!.level).toBe('warn');
  });
});

describe('환불 결정', () => {
  /**
   * 결정은 한 번이다 — `refunding`이 박히면 decide가 다시 `settle`을 내지 않는다.
   * 멱등은 사이드 스토어가 아니라 **상태**가 보장한다(리뷰 #8).
   */
  it('마감 초과 → 환불을 결정한다', async () => {
    const h = harness();
    await executeOnchainAction(
      order({ state: 'funded' }), { kind: 'settle', settlementKind: 'refund:customer-late' }, h.deps,
    );
    expect(h.decided).toEqual([{ kind: 'refund:customer-late', fold: false }]);
  });

  it('refunding에서는 다시 결정하지 않고, 오래되면 서명 요청만 다시 보낸다', async () => {
    const refunding = order({
      state: 'refunding', fundingOutpoint: formatOutpoint(TXID, 0), settlementKind: 'refund:sponsor-timeout',
    });
    const funds = chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } });

    const fresh = harness({ chain: funds, lastSignatureRequestAt: () => NOW - 60 });
    await tickOnchainOrder(refunding, fresh.deps);
    expect(fresh.decided).toHaveLength(0);
    expect(fresh.calls).not.toContain('request:o-1');

    const old = harness({ chain: funds, lastSignatureRequestAt: () => NOW - SIGNATURE_RESEND_SEC });
    await tickOnchainOrder(refunding, old.deps);
    expect(old.calls).toContain('request:o-1');
  });
});

describe('dispute — 고객 동의를 묻지 않는다 (O-010)', () => {
  it('강제 전이하고 분쟁 진입 시각을 박는다', async () => {
    const h = harness();
    await executeOnchainAction(order({ state: 'remitted' }), { kind: 'dispute' }, h.deps);
    expect(h.committed[0]!.patch).toEqual({ state: 'disputed', disputedAt: NOW });
  });

  it('분쟁 임박 알림은 전용 경로로 (워처가 한 번만 보낸다)', async () => {
    const h = harness();
    await executeOnchainAction(order({ state: 'remitted' }), { kind: 'dispute-soon' }, h.deps);
    expect(h.calls).toEqual(['dispute-soon:o-1']);
    expect(h.raised).toHaveLength(0);
  });
});

describe('리뷰 #8 — 옛 판단으로 새 상태를 덮지 않는다', () => {
  /**
   * 조회를 기다리는 사이 핸들러가 오더를 바꿨다(브로드캐스트 → settling). 전에는
   * 틱 시작 때 스냅샷으로 판단해 **방금 뿌린 환불을 리오그로 읽고 bonded로 되돌릴 수
   * 있었다.**
   */
  it('조회하는 사이 오더가 바뀌었으면 이번 틱은 쉰다', async () => {
    const snap = order({ state: 'presigned', fundingOutpoint: formatOutpoint(TXID, 0), presignedAt: NOW - 100 });
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [], mempool: [] } }),
      getOrder: () => ({ ...snap, state: 'settling', updatedAt: snap.updatedAt + 5 }),
    });
    const action = await tickOnchainOrder(snap, h.deps);
    expect(action.kind).toBe('hold');
    expect(h.committed).toHaveLength(0);
  });

  it('모든 쓰기에 "그 사이 안 바뀌었을 때만"을 건다', async () => {
    const h = harness();
    const o = order({ state: 'remitted' });
    await executeOnchainAction(o, { kind: 'dispute' }, h.deps);
    expect(h.committed[0]!.guard).toEqual({ ifUnchangedSince: o.updatedAt });
  });
});

describe('소모 관측 — 체인이 장부보다 먼저 말했다', () => {
  const funded = order({
    state: 'funded', fundingOutpoint: formatOutpoint(TXID, 0), fundedAt: NOW - 100,
  });

  /** O-006 — 증거(타임락 리프)가 있을 때만 swept으로 간다. 전에는 한 번도 기록되지 않았다. */
  it('타임락 리프로 쓰였으면 swept', async () => {
    const h = harness();
    await executeOnchainAction(funded, { kind: 'observe-spend', txid: 'ee'.repeat(32), leaf: 'timelock', confirmed: true }, h.deps);
    expect(h.committed[0]!.patch).toMatchObject({ state: 'swept', settlementTxid: 'ee'.repeat(32) });
    expect(h.outcomes).toEqual(['swept']);
  });

  it('릴리스 리프로 쓰였으면 release로 적는다 (후원자가 받았다)', async () => {
    const h = harness();
    const o = order({ ...funded, state: 'remitted' });
    await executeOnchainAction(o, { kind: 'observe-spend', txid: 'ee'.repeat(32), leaf: 'release', confirmed: false }, h.deps);
    expect(h.committed[0]!.patch).toMatchObject({ state: 'settling', settlementKind: 'release', settlementTxid: 'ee'.repeat(32) });
  });

  it('결정된 사유의 리프면 그 사유로 적는다 (기록이 안 남은 우리 종결)', async () => {
    const h = harness();
    const o = order({ ...funded, state: 'refunding', settlementKind: 'refund:sponsor-timeout' });
    await executeOnchainAction(o, { kind: 'observe-spend', txid: 'ee'.repeat(32), leaf: 'customer-win', confirmed: false }, h.deps);
    expect(h.committed[0]!.patch).toMatchObject({ state: 'settling', settlementKind: 'refund:sponsor-timeout' });
  });

  it('장부에 없는 어드민 리프 소모는 사람을 부른다 (어드민 키 유출 의심)', async () => {
    const h = harness();
    await executeOnchainAction(funded, { kind: 'observe-spend', txid: 'ee'.repeat(32), leaf: 'sponsor-win', confirmed: true }, h.deps);
    expect(h.committed).toHaveLength(0);
    expect(h.raised[0]!.level).toBe('anomaly');
  });

  it('재브로드캐스트·outbox 마무리를 부른다', async () => {
    const h = harness();
    await executeOnchainAction(funded, { kind: 'rebroadcast' }, h.deps);
    await executeOnchainAction(funded, { kind: 'flush-outbox' }, h.deps);
    expect(h.calls).toEqual(['rebroadcast:o-1', 'flush:o-1']);
  });
});

describe('박아둔 펀딩의 사실 모으기 (리뷰 #8 — "UTXO가 없다" ≠ 리오그)', () => {
  const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
  const keys = { customer: xonlyFromPrivkey(sk(1)), sponsor: xonlyFromPrivkey(sk(40)), admin: xonlyFromPrivkey(sk(80)) };
  const D = deriveEscrowAddress({ keys, network: 'signet' });
  const withKeys = order({
    state: 'funded', fundingOutpoint: formatOutpoint(TXID, 0),
    customerXonly: keys.customer, sponsorXonly: keys.sponsor, adminXonly: keys.admin,
    timelockBlocks: D.timelockBlocks,
  });
  const EMPTY: ChainQuery<AddressFunds> = { known: true, value: { confirmed: [], mempool: [] } };

  it('목록에 있으면 소모 조회를 안 한다', async () => {
    const chain = chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } });
    expect(await gatherPinnedFacts(withKeys, await chain.getAddressFunds(''), chain))
      .toEqual({ status: 'alive', confirmations: 3 });
    expect(chain.getSpend).not.toHaveBeenCalled();
  });

  it('누가 썼으면 spent + 증인으로 가른 리프', async () => {
    const tx = buildSettlementTx({
      descriptor: D, input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'refund', destination: D.address, feeSat: 500,
    });
    signSettlement(tx, sk(80));
    signSettlement(tx, sk(1));
    finalizeSettlement(tx, 'refund');
    const witness = tx.getInput(0).finalScriptWitness!.map(w => bytesToHex(w));
    const chain = chainWith(EMPTY, undefined, {
      known: true, value: { spent: true, txid: 'ee'.repeat(32), confirmed: false, witness },
    });
    expect(await gatherPinnedFacts(withKeys, EMPTY, chain)).toEqual({
      status: 'spent', txid: 'ee'.repeat(32), leaf: 'customer-win', confirmed: false,
    });
  });

  it('안 쓰였는데 펀딩 tx를 노드가 모르면 gone (진짜 리오그·이중지불)', async () => {
    const chain = chainWith(EMPTY, { known: true, value: { seen: false, confirmed: false, confirmations: 0 } }, {
      known: true, value: { spent: false },
    });
    expect(await gatherPinnedFacts(withKeys, EMPTY, chain)).toEqual({ status: 'gone' });
  });

  it('소모 조회가 실패하면 모름 — 리오그로 단정하지 않는다', async () => {
    const chain = chainWith(EMPTY, undefined, { known: false, reason: 'timeout' });
    expect((await gatherPinnedFacts(withKeys, EMPTY, chain))?.status).toBe('unknown');
  });
});

describe('약정 밖의 자금 (구조)', () => {
  it('bonded에서 모양이 틀린 펀딩은 전부 구조 대상', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo({ valueSat: AMOUNT - 100 })], mempool: [] } }),
    });
    await tickOnchainOrder(order(), h.deps);
    expect(h.raised[0]!.level).toBe('anomaly');
    expect(h.rescues.at(-1)).toEqual([{ txid: TXID, vout: 0, valueSat: AMOUNT - 100 }]);
  });

  it('bonded에서 정상 펀딩이 컨펌 중이면 건드리지 않는다', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo({ confirmations: 1 })], mempool: [] } }),
    });
    await tickOnchainOrder(order(), h.deps);
    expect(h.rescues.at(-1)).toEqual([]);
  });

  /**
   * §4.1c · §7.4가 요구했던 것 — 취소된 주문의 주소도 한동안 본다. 전에는 터미널이면
   * 바로 빠져서, 취소 직후 컨펌된 펀딩이 **아무도 안 보는 주소에** 남았다.
   */
  it('취소된 주문 주소에 늦게 들어온 자금을 찾는다 (드문드문)', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } }),
    });
    const cancelled = order({ state: 'cancelled', updatedAt: NOW - 3600 });
    await tickOnchainOrder(cancelled, h.deps);
    expect(h.rescues.at(-1)).toEqual([{ txid: TXID, vout: 0, valueSat: AMOUNT }]);

    await tickOnchainOrder(cancelled, h.deps); // 곧바로 다시 — 조회하지 않는다
    expect(h.deps.chain.getAddressFunds).toHaveBeenCalledTimes(1);

    const later = { ...h.deps, now: () => NOW + TERMINAL_WATCH_INTERVAL_SEC };
    await tickOnchainOrder(cancelled, later);
    expect(h.deps.chain.getAddressFunds).toHaveBeenCalledTimes(2);
  });
});

describe('confirmed — 사유가 터미널과 보증금 처리를 정한다', () => {
  it.each([
    ['release', 'released'],
    ['refund:sponsor-timeout', 'refunded'],
    ['sponsor_win', 'sponsor_wins'],
    ['customer_win', 'customer_wins'],
  ] as const)('%s → %s', async (kind, terminal) => {
    const h = harness();
    await executeOnchainAction(
      order({ state: 'settling', settlementKind: kind, settlementTxid: TXID }),
      { kind: 'confirmed' }, h.deps,
    );
    expect(h.committed[0]!.patch).toEqual({ state: terminal });
    expect(h.outcomes).toEqual([kind]);
  });

  it('사유가 없으면 사람을 부른다 (보증금을 임의로 처리하지 않는다)', async () => {
    const h = harness();
    await executeOnchainAction(
      order({ state: 'settling', settlementTxid: TXID }), { kind: 'confirmed' }, h.deps,
    );
    expect(h.committed).toHaveLength(0);
    expect(h.outcomes).toHaveLength(0);
    expect(h.raised[0]!.level).toBe('anomaly');
  });
});

describe('체인 조회', () => {
  it('주소가 없으면 체인을 찌르지 않는다 (listed)', async () => {
    const h = harness();
    await tickOnchainOrder(order({ state: 'listed', escrowAddress: undefined }), h.deps);
    expect(h.deps.chain.getAddressFunds).not.toHaveBeenCalled();
  });

  it('settling에서만 종결 tx를 조회한다', async () => {
    const h = harness({
      chain: chainWith(
        { known: true, value: { confirmed: [utxo()], mempool: [] } },
        { known: true, value: { seen: true, confirmed: true, confirmations: 2, blockHeight: 1 } },
      ),
    });
    await tickOnchainOrder(
      order({ state: 'settling', settlementKind: 'release', settlementTxid: TXID, fundingOutpoint: formatOutpoint('aa'.repeat(32), 0) }),
      h.deps,
    );
    expect(h.deps.chain.getTxStatus).toHaveBeenCalledWith(TXID);
  });

  /** O-015는 `bonded`에서만 필요하다. 매 틱 LN을 찌를 이유가 없다. */
  it('bonded가 아니면 보증금 생존을 안 묻는다', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } }),
    });
    await tickOnchainOrder(
      order({ state: 'funded', fundingOutpoint: formatOutpoint(TXID, 0), fundedAt: NOW }), h.deps,
    );
    expect(h.deps.sponsorBondAlive).not.toHaveBeenCalled();
  });

  it('터미널은 상태를 건드리지 않는다 (주소만 드문드문 본다)', async () => {
    const h = harness();
    const action = await tickOnchainOrder(order({ state: 'released' }), h.deps);
    expect(action.kind).toBe('idle');
    expect(h.committed).toHaveLength(0);
  });

  it('주소가 없는 터미널은 체인도 안 찌른다', async () => {
    const h = harness();
    await tickOnchainOrder(order({ state: 'cancelled', escrowAddress: undefined }), h.deps);
    expect(h.deps.chain.getAddressFunds).not.toHaveBeenCalled();
  });
});
