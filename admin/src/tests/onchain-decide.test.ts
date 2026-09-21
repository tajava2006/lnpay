/**
 * 워처의 판단 (PLAN-ONCHAIN-TRACK §9 · §6.2)
 *
 * 마감·리오그·이상징후 판정이 전부 여기 모여 있다. 한 줄이 틀리면
 * **돈이 있는 주소를 취소**하거나 **사라진 펀딩 위에 가격을 고정**한다.
 * 네트워크도 시계도 인자라 전수로 돈다.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_WINDOW_SEC, COSIGN_WINDOW_SEC, FUNDING_WINDOW_SEC, KRW_WINDOW_SEC,
  MAX_OPTION_WINDOW_SEC, PRESIGN_WINDOW_SEC, SETTLING_WARN_SEC,
  formatOutpoint, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import type { AddressFunds, ChainQuery, ChainUtxo } from '@sajwo-tracker/shared/onchain';
import { decideOnchainAction, needsSettlementTx, type OnchainWatchContext } from '../onchain/decide';

const NOW = 1_700_000_000;
const TXID = 'd4'.repeat(32);
const AMOUNT = 500_000;
/** 1 BTC = 1억원이면 500k sat = 500,000원 */
const PRICE_FEED = 100_000_000;

function order(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'o-1', state: 'listed', status: 'active',
    customerPubkey: 'cust', amountSat: AMOUNT,
    createdAt: NOW - 1000, updatedAt: NOW - 1000,
    expiration: NOW + 86_400, network: 'signet', raw: {},
    ...over,
  };
}

function utxo(over: Partial<ChainUtxo> = {}): ChainUtxo {
  return { txid: TXID, vout: 0, valueSat: AMOUNT, confirmations: 3, ...over };
}

function funds(over: Partial<AddressFunds> = {}): ChainQuery<AddressFunds> {
  return { known: true, value: { confirmed: [], mempool: [], ...over } };
}

const UNKNOWN: ChainQuery<AddressFunds> = { known: false, reason: '502' };

function ctx(over: Partial<OnchainWatchContext> = {}): OnchainWatchContext {
  return { now: NOW, funds: funds(), btcPriceKrw: PRICE_FEED, sponsorBondAlive: true, ...over };
}

describe('조회 실패는 아무것도 안 한다', () => {
  /** '모름'을 '없음'으로 쓰면 **돈이 있는 주소를 비었다고 보고 취소**한다. */
  it.each(['bonded', 'funded', 'presigned'] as const)('%s에서 hold', state => {
    const o = order({
      state, fundingDeadline: NOW - 1, fundingOutpoint: formatOutpoint(TXID, 0),
      fundedAt: NOW - 10_000, presignedAt: NOW - 10_000,
    });
    expect(decideOnchainAction(o, ctx({ funds: UNKNOWN })).kind).toBe('hold');
  });
});

describe('listed', () => {
  it('만료 전에는 아무것도 안 한다', () => {
    expect(decideOnchainAction(order(), ctx()).kind).toBe('idle');
  });

  it('의뢰가 만료되면 취소한다', () => {
    expect(decideOnchainAction(order({ expiration: NOW }), ctx()).kind).toBe('cancel');
  });
});

describe('bonded — 펀딩 판정 (§4.1c)', () => {
  const bonded = (over: Partial<OnchainOrder> = {}) =>
    order({ state: 'bonded', fundingDeadline: NOW + FUNDING_WINDOW_SEC, ...over });

  it('약정 금액이 N컨펌되면 가격을 고정한다', () => {
    const action = decideOnchainAction(bonded(), ctx({ funds: funds({ confirmed: [utxo()] }) }));
    expect(action).toEqual({
      kind: 'fund', outpoint: { txid: TXID, vout: 0 }, confirmations: 3, priceKrw: 500_000,
    });
  });

  it('컨펌이 모자라면 기다린다', () => {
    const o = bonded({ amountSat: 2_000_000 });
    const action = decideOnchainAction(o, ctx({
      funds: funds({ confirmed: [utxo({ valueSat: 2_000_000, confirmations: 1 })] }),
    }));
    expect(action.kind).toBe('idle');
  });

  /** 멤풀은 화면 힌트일 뿐이다. 0-conf는 RBF로 되돌릴 수 있다(공격 D). */
  it('멤풀에만 있으면 funded가 아니다', () => {
    const action = decideOnchainAction(bonded(), ctx({
      funds: funds({ mempool: [utxo({ confirmations: 0 })] }),
    }));
    expect(action.kind).toBe('idle');
  });

  it('마감까지 컨펌 안 되면 취소 (멤풀에 보여도)', () => {
    const o = bonded({ fundingDeadline: NOW });
    expect(decideOnchainAction(o, ctx()).kind).toBe('cancel');
    expect(decideOnchainAction(o, ctx({
      funds: funds({ mempool: [utxo({ confirmations: 0 })] }),
    })).kind).toBe('cancel');
  });

  /** 컨펌된 자금이 있으면 **절대** 취소하지 않는다 — 아무도 안 보는 주소에 남는다. */
  it('마감이 지나도 컨펌된 자금이 있으면 취소하지 않는다', () => {
    const o = bonded({ fundingDeadline: NOW - 1, amountSat: 2_000_000 });
    const action = decideOnchainAction(o, ctx({
      funds: funds({ confirmed: [utxo({ valueSat: 2_000_000, confirmations: 1 })] }),
    }));
    expect(action.kind).toBe('idle');
  });

  it('모양이 다르면 사람을 부른다 (공격 K)', () => {
    const action = decideOnchainAction(bonded(), ctx({
      funds: funds({ confirmed: [utxo(), utxo({ vout: 1 })] }),
    }));
    expect(action.kind).toBe('anomaly');
  });

  it('시세를 모르면 가격을 고정하지 않는다', () => {
    const action = decideOnchainAction(bonded(), ctx({
      funds: funds({ confirmed: [utxo()] }), btcPriceKrw: undefined,
    }));
    expect(action.kind).toBe('hold');
  });

  /** O-015 — 무담보 옵션 창을 열지 않는다. */
  it('후원자 보증금이 죽었으면 가격을 고정하지 않고 접는다', () => {
    const action = decideOnchainAction(bonded(), ctx({
      funds: funds({ confirmed: [utxo()] }), sponsorBondAlive: false,
    }));
    expect(action).toMatchObject({ kind: 'fold', settlementKind: 'refund:bond-expired' });
  });

  it('보증금 생존을 모르면 hold다 (죽은 걸로 치지 않는다)', () => {
    const action = decideOnchainAction(bonded(), ctx({
      funds: funds({ confirmed: [utxo()] }), sponsorBondAlive: undefined,
    }));
    expect(action.kind).toBe('hold');
  });

  it('시세가 최저가 미만이면 접는다 (양쪽 무과실)', () => {
    const o = bonded({ reserveKrw: 600_000 });
    const action = decideOnchainAction(o, ctx({ funds: funds({ confirmed: [utxo()] }) }));
    expect(action).toMatchObject({ kind: 'fold', settlementKind: 'refund:reserve' });
  });

  it('최저가를 넘으면 그대로 진행한다', () => {
    const o = bonded({ reserveKrw: 400_000 });
    expect(decideOnchainAction(o, ctx({ funds: funds({ confirmed: [utxo()] }) })).kind).toBe('fund');
  });
});

describe('funded — 사전서명 마감 (T0+15분)', () => {
  const funded = (over: Partial<OnchainOrder> = {}) => order({
    state: 'funded', fundingOutpoint: formatOutpoint(TXID, 0), fundedAt: NOW - 100,
    priceKrw: 500_000, ...over,
  });
  const alive = ctx({ funds: funds({ confirmed: [utxo()] }) });

  it('마감 전에는 기다린다', () => {
    expect(decideOnchainAction(funded(), alive).kind).toBe('idle');
  });

  it('T0+15분을 넘기면 후원자 타임아웃 환불', () => {
    const o = funded({ fundedAt: NOW - PRESIGN_WINDOW_SEC });
    expect(decideOnchainAction(o, alive)).toEqual({
      kind: 'settle', settlementKind: 'refund:sponsor-timeout',
    });
  });

  /** 리오그 — 사라진 펀딩 위에 가격이 고정된 채로 굴러가면 안 된다(O-008). */
  it('컨펌이 N 아래로 내려가면 리오그 복귀', () => {
    const o = funded({ amountSat: 2_000_000 });
    const action = decideOnchainAction(o, ctx({
      funds: funds({ confirmed: [utxo({ valueSat: 2_000_000, confirmations: 1 })] }),
    }));
    expect(action).toEqual({ kind: 'reorg', why: 'shallow' });
  });

  it('펀딩이 아예 사라지면 리오그(gone) — 이중지불이다', () => {
    expect(decideOnchainAction(funded(), ctx({ funds: funds() })))
      .toEqual({ kind: 'reorg', why: 'gone' });
  });

  /** 마감보다 리오그를 먼저 본다 — 순서가 바뀌면 사라진 펀딩을 환불하려 든다. */
  it('마감이 지났어도 리오그가 우선이다', () => {
    const o = funded({ fundedAt: NOW - PRESIGN_WINDOW_SEC - 1 });
    expect(decideOnchainAction(o, ctx({ funds: funds() })).kind).toBe('reorg');
  });

  it('outpoint가 없으면 사람을 부른다', () => {
    const o = funded({ fundingOutpoint: undefined });
    expect(decideOnchainAction(o, alive).kind).toBe('anomaly');
  });
});

describe('presigned — 두 사람의 마감이 순서대로 (O-013)', () => {
  const presigned = (over: Partial<OnchainOrder> = {}) => order({
    state: 'presigned', fundingOutpoint: formatOutpoint(TXID, 0),
    fundedAt: NOW - 1000, presignedAt: NOW - 100, ...over,
  });
  const alive = (over: Partial<OnchainWatchContext> = {}) =>
    ctx({ funds: funds({ confirmed: [utxo()] }), ...over });

  it('계좌 공개 전에는 고객 차례 — 5분', () => {
    expect(decideOnchainAction(presigned(), alive()).kind).toBe('idle');
    const late = presigned({ presignedAt: NOW - ACCOUNT_WINDOW_SEC });
    expect(decideOnchainAction(late, alive())).toEqual({
      kind: 'settle', settlementKind: 'refund:customer-late',
    });
  });

  /**
   * ⚠️ 후원자 마감은 **계좌 공개 시점부터** 센다. 고객이 4분 59초에 공개해도
   * 후원자는 30분을 온전히 받는다 — 고객 지연이 후원자를 치면 안 된다.
   */
  it('계좌가 나간 뒤에는 후원자 차례 — 계좌공개+30분', () => {
    const sent = presigned({
      presignedAt: NOW - ACCOUNT_WINDOW_SEC - 1000,
      accountSentAt: NOW - 100,
      krwDeadline: NOW - 100 + KRW_WINDOW_SEC,
    });
    expect(decideOnchainAction(sent, alive({ accountInfoSent: true })).kind).toBe('idle');

    const expired = presigned({
      presignedAt: NOW - 10_000,
      accountSentAt: NOW - KRW_WINDOW_SEC,
      krwDeadline: NOW - KRW_WINDOW_SEC + KRW_WINDOW_SEC,
    });
    expect(decideOnchainAction(expired, alive({ accountInfoSent: true }))).toEqual({
      kind: 'settle', settlementKind: 'refund:sponsor-timeout',
    });
  });

  it('총 옵션 창이 T0+60분을 못 넘는다', () => {
    expect(MAX_OPTION_WINDOW_SEC).toBe(60 * 60);
    expect(PRESIGN_WINDOW_SEC + ACCOUNT_WINDOW_SEC + KRW_WINDOW_SEC).toBe(MAX_OPTION_WINDOW_SEC);
  });

  it('여기서도 리오그가 우선이다', () => {
    expect(decideOnchainAction(presigned(), ctx({ funds: funds() })).kind).toBe('reorg');
  });
});

describe('remitted — 24시간 뒤 강제 분쟁 (O-010)', () => {
  const remitted = (over: Partial<OnchainOrder> = {}) =>
    order({ state: 'remitted', remittedAt: NOW - 100, ...over });

  it('마감 전에는 조용하다', () => {
    expect(decideOnchainAction(remitted(), ctx()).kind).toBe('idle');
  });

  /** 느린 고객 대부분이 여기서 스스로 끝낸다 → 어드민이 안 불려 나온다. */
  it('2시간 전에 유예 경고', () => {
    const o = remitted({ remittedAt: NOW - COSIGN_WINDOW_SEC + 2 * 3600 });
    const action = decideOnchainAction(o, ctx());
    expect(action.kind).toBe('warn');
  });

  /** **고객 동의를 묻지 않는다.** 침묵으로 타임락까지 끄는 경로를 막는 자리다. */
  it('24시간을 넘기면 분쟁으로 강제 전이', () => {
    const o = remitted({ remittedAt: NOW - COSIGN_WINDOW_SEC });
    expect(decideOnchainAction(o, ctx())).toEqual({ kind: 'dispute' });
  });
});

describe('disputed — 하드 마감이 없다 (§7.5)', () => {
  /** 자동 해소는 어느 방향이든 탈취다. 대신 사람을 더 세게 부른다. */
  it('시간이 지나도 스스로 해소하지 않는다', () => {
    const o = order({ state: 'disputed', updatedAt: NOW - 30 * 86_400 });
    const action = decideOnchainAction(o, ctx());
    expect(action.kind).toBe('warn');
    expect(['confirmed', 'settle', 'cancel']).not.toContain(action.kind);
  });

  it('7일·14일에 에스컬레이션한다', () => {
    const week = order({ state: 'disputed', updatedAt: NOW - 7 * 86_400 });
    expect(decideOnchainAction(week, ctx())).toMatchObject({ kind: 'warn' });
    const fresh = order({ state: 'disputed', updatedAt: NOW - 3600 });
    expect(decideOnchainAction(fresh, ctx()).kind).toBe('idle');
  });
});

describe('settling — 컨펌되면 터미널 (O-005)', () => {
  const settling = (over: Partial<OnchainOrder> = {}) => order({
    state: 'settling', settlementKind: 'release', settlementTxid: TXID,
    settlingAt: NOW - 100, ...over,
  });

  /**
   * 종결 tx도 **펀딩과 같은 컨펌 수**를 요구한다. 터미널 판정이 곧 보증금
   * 정산(실제 LN 결제)을 부르므로, 기록이 체인보다 앞서 가면 안 된다.
   */
  it('요구 컨펌을 채우면 종결 (500k sat = 2컨펌)', () => {
    const shallow = decideOnchainAction(settling(), ctx({
      settlementTx: { known: true, value: { confirmed: true, confirmations: 1, blockHeight: 1 } },
    }));
    expect(shallow.kind).toBe('idle');

    const action = decideOnchainAction(settling(), ctx({
      settlementTx: { known: true, value: { confirmed: true, confirmations: 2, blockHeight: 1 } },
    }));
    expect(action).toEqual({ kind: 'confirmed' });
  });

  it('소액(1컨펌 요구)은 1컨펌에 종결된다', () => {
    const o = settling({ amountSat: 50_000 });
    const action = decideOnchainAction(o, ctx({
      settlementTx: { known: true, value: { confirmed: true, confirmations: 1, blockHeight: 1 } },
    }));
    expect(action).toEqual({ kind: 'confirmed' });
  });

  it('멤풀이면 기다린다', () => {
    const action = decideOnchainAction(settling(), ctx({
      settlementTx: { known: true, value: { confirmed: false, confirmations: 0 } },
    }));
    expect(action.kind).toBe('idle');
  });

  /** 되돌아가지 않는다. 재브로드캐스트 + CPFP가 답이다. */
  it('24시간 넘게 안 잡히면 경고 (되돌리지 않는다)', () => {
    const o = settling({ settlingAt: NOW - SETTLING_WARN_SEC });
    const action = decideOnchainAction(o, ctx({
      settlementTx: { known: true, value: { confirmed: false, confirmations: 0 } },
    }));
    expect(action.kind).toBe('warn');
  });

  it('조회 실패는 hold', () => {
    expect(decideOnchainAction(settling(), ctx({
      settlementTx: { known: false, reason: 'timeout' },
    })).kind).toBe('hold');
  });

  it('txid가 없으면 사람을 부른다', () => {
    expect(decideOnchainAction(settling({ settlementTxid: undefined }), ctx()).kind).toBe('anomaly');
  });
});

describe('터미널은 관측만 한다', () => {
  it.each(['released', 'refunded', 'sponsor_wins', 'customer_wins', 'cancelled', 'swept'] as const)(
    '%s', state => {
      expect(decideOnchainAction(order({ state }), ctx()).kind).toBe('idle');
    },
  );
});

describe('행동 분류', () => {
  it('settle·fold는 종결 tx가 필요하다', () => {
    expect(needsSettlementTx({ kind: 'settle', settlementKind: 'refund:reserve' })).toBe(true);
    expect(needsSettlementTx({
      kind: 'fold', outpoint: { txid: TXID, vout: 0 }, confirmations: 1,
      settlementKind: 'refund:bond-expired',
    })).toBe(true);
    expect(needsSettlementTx({ kind: 'idle' })).toBe(false);
    expect(needsSettlementTx({ kind: 'cancel' })).toBe(false);
  });
});
