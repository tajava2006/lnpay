/**
 * 온체인 워처의 집행 (PLAN-ONCHAIN-TRACK §9)
 *
 * 판단은 `decide.ts`가 하고 여기서는 **집행만** 한다. 그래서 이 테스트가 보는 건
 * "그 판단이 났을 때 **무엇을 건드리는가**"다 — 특히 리오그에서 **가격 고정이
 * 실제로 지워지는지**, 종결 준비가 **한 번만** 나가는지.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  FUNDING_WINDOW_SEC, formatOutpoint, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import type {
  AddressFunds, ChainAdapter, ChainQuery, ChainUtxo, FeeEstimates, TxStatus,
} from '../onchain/chain';
import { executeOnchainAction, tickOnchainOrder, type OnchainWatcherDeps } from '../onchain/watcher';
import {
  _resetForTesting, getPendingSettlement, putPendingSettlement,
} from '../onchain/pending-settlement-store';

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
): ChainAdapter {
  const unknown = <T>(reason: string): ChainQuery<T> => ({ known: false, reason });
  return {
    getAddressFunds: vi.fn(async () => funds),
    getTxStatus: vi.fn(async () => tx ?? unknown<TxStatus>('안 물어봄')),
    getFeeEstimates: vi.fn(async () => unknown<FeeEstimates>('n/a')),
    getTipHeight: vi.fn(async () => unknown<number>('n/a')),
    broadcastTx: vi.fn(async () => unknown<string>('n/a')),
  };
}

interface Harness {
  deps: OnchainWatcherDeps;
  committed: Array<{ orderId: string; patch: Record<string, unknown> }>;
  outcomes: string[];
  raised: Array<{ level: string; why: string }>;
  prepared: string[];
}

function harness(over: Partial<OnchainWatcherDeps> = {}): Harness {
  const committed: Harness['committed'] = [];
  const outcomes: string[] = [];
  const raised: Harness['raised'] = [];
  const prepared: string[] = [];

  const deps: OnchainWatcherDeps = {
    now: () => NOW,
    chain: chainWith({ known: true, value: { confirmed: [], mempool: [] } }),
    btcPriceKrw: () => 100_000_000,
    sponsorBondAlive: vi.fn(async () => true),
    accountInfoSent: () => false,
    releaseFeeSat: () => FEE,
    commit: async (orderId, patch) => {
      committed.push({ orderId, patch: patch as Record<string, unknown> });
      return { ...order(), ...(patch as Partial<OnchainOrder>), orderId };
    },
    prepareSettlement: async (o, kind) => { prepared.push(`${o.orderId}:${kind}`); },
    onOutcome: (_o, outcome) => outcomes.push(outcome),
    raise: (_o, level, why) => raised.push({ level, why }),
    listOrders: () => [],
    checkDeposits: async () => {},
    ...over,
  };
  return { deps, committed, outcomes, raised, prepared };
}

beforeEach(() => _resetForTesting());

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
  it('보증금이 죽었으면 funded로 올리되 가격 없이 종결 준비', async () => {
    const h = harness({
      chain: chainWith({ known: true, value: { confirmed: [utxo()], mempool: [] } }),
      sponsorBondAlive: async () => false,
    });
    await tickOnchainOrder(order(), h.deps);

    expect(h.committed[0]!.patch).toMatchObject({ state: 'funded', fundedAt: NOW });
    expect(h.committed[0]!.patch.priceKrw).toBeUndefined();
    expect(h.prepared).toEqual(['o-1:refund:bond-expired']);
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

describe('종결 준비는 한 번만 (멱등)', () => {
  /**
   * 없으면 마감이 지난 주문에 **매 틱마다 새 환불 tx**를 만들어 쏜다.
   * 그러면 상대가 서명한 tx와 우리가 기다리는 tx가 갈린다.
   */
  it('이미 대기 중이면 새로 만들지 않는다', async () => {
    const h = harness();
    putPendingSettlement({
      orderId: 'o-1', settlementKind: 'refund:sponsor-timeout', path: 'refund',
      psbt: 'psbt', destination: 'tb1p', feeSat: FEE, awaiting: 'customer',
      createdAt: NOW - 10, lastRequestedAt: NOW - 10,
    });

    await executeOnchainAction(
      order({ state: 'funded' }), { kind: 'settle', settlementKind: 'refund:sponsor-timeout' }, h.deps,
    );
    expect(h.prepared).toHaveLength(0);
  });

  it('없으면 만든다', async () => {
    const h = harness();
    await executeOnchainAction(
      order({ state: 'funded' }), { kind: 'settle', settlementKind: 'refund:customer-late' }, h.deps,
    );
    expect(h.prepared).toEqual(['o-1:refund:customer-late']);
    expect(getPendingSettlement('o-1')).toBeUndefined(); // 실제 생성은 prepareSettlement 몫
  });
});

describe('dispute — 고객 동의를 묻지 않는다 (O-010)', () => {
  it('강제 전이한다', async () => {
    const h = harness();
    await executeOnchainAction(order({ state: 'remitted' }), { kind: 'dispute' }, h.deps);
    expect(h.committed[0]!.patch).toEqual({ state: 'disputed' });
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
        { known: true, value: { confirmed: true, confirmations: 2, blockHeight: 1 } },
      ),
    });
    await tickOnchainOrder(
      order({ state: 'settling', settlementKind: 'release', settlementTxid: TXID }), h.deps,
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

  it('터미널은 아예 건드리지 않는다', async () => {
    const h = harness();
    const action = await tickOnchainOrder(order({ state: 'released' }), h.deps);
    expect(action.kind).toBe('idle');
    expect(h.deps.chain.getAddressFunds).not.toHaveBeenCalled();
  });
});
