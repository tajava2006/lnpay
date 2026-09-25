/**
 * 워처의 판단
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
import {
  decideOnchainAction, type OnchainWatchContext, type PinnedFacts,
} from '../onchain/decide';

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

const ALIVE: PinnedFacts = { status: 'alive', confirmations: 3 };
const GONE: PinnedFacts = { status: 'gone' };

/** 기본은 "박아둔 펀딩이 살아 있다". 펀딩 이전 상태는 이 값을 안 본다. */
function ctx(over: Partial<OnchainWatchContext> = {}): OnchainWatchContext {
  return {
    now: NOW, funds: funds(), pinned: ALIVE, btcPriceKrw: PRICE_FEED, sponsorBondAlive: true, ...over,
  };
}

describe('조회 실패는 아무것도 안 한다', () => {
  /** '모름'을 '없음'으로 쓰면 **돈이 있는 주소를 비었다고 보고 취소**한다. */
  it.each(['bonded', 'funded', 'presigned'] as const)('%s에서 hold', state => {
    const o = order({
      state, fundingDeadline: NOW - 1, fundingOutpoint: formatOutpoint(TXID, 0),
      fundedAt: NOW - 10_000, presignedAt: NOW - 10_000,
    });
    expect(decideOnchainAction(o, ctx({ funds: UNKNOWN, pinned: { status: 'unknown', reason: '502' } })).kind)
      .toBe('hold');
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

describe('bonded — 펀딩 판정', () => {
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

  /** 멤풀은 화면 힌트일 뿐이다. 0-conf는 RBF로 되돌릴 수 있다(T-104). */
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

  /** O-014 — 조회 실패는 '비었다'가 아니다. 모르면 마감이 지나도 취소하지 않는다 */
  it('체인을 모르면 마감이 지나도 취소하지 않는다', () => {
    const o = bonded({ fundingDeadline: NOW - 1 });
    expect(decideOnchainAction(o, ctx({ funds: { known: false, reason: 'timeout' } })).kind).toBe('hold');
  });

  it('모양이 다르면 사람을 부른다 (T-111)', () => {
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
    const action = decideOnchainAction(o, ctx({ pinned: { status: 'shallow', confirmations: 1, required: 3 } }));
    expect(action).toEqual({ kind: 'reorg', why: 'shallow' });
  });

  it('펀딩 tx 자체가 사라지면 리오그(gone) — 이중지불이다', () => {
    expect(decideOnchainAction(funded(), ctx({ pinned: GONE })))
      .toEqual({ kind: 'reorg', why: 'gone' });
  });

  /** 마감보다 리오그를 먼저 본다 — 순서가 바뀌면 사라진 펀딩을 환불하려 든다. */
  it('마감이 지났어도 리오그가 우선이다', () => {
    const o = funded({ fundedAt: NOW - PRESIGN_WINDOW_SEC - 1 });
    expect(decideOnchainAction(o, ctx({ pinned: GONE })).kind).toBe('reorg');
  });

  /**
   * **누가 썼으면 리오그가 아니다.** 전에는 UTXO가 목록에서 빠지면 전부
   * 리오그로 읽어서, 우리가 뿌린 환불을 `bonded` 복귀로 바꾸고 마감이 차면 엉뚱한
   * 쪽을 몰수했다.
   */
  it('에스크로가 소모됐으면 리오그가 아니라 소모 관측이다', () => {
    const spent: PinnedFacts = { status: 'spent', txid: 'ee'.repeat(32), leaf: 'customer-win', confirmed: false };
    expect(decideOnchainAction(funded(), ctx({ pinned: spent })))
      .toEqual({ kind: 'observe-spend', txid: 'ee'.repeat(32), leaf: 'customer-win', confirmed: false });
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

  /**
   * 데몬이 찍은 마감을 따른다(2026-09-25) — 앱도 같은 값을 보여준다. 상수로 다시 계산하면 데몬·앱 버전이
   * 어긋났을 때 서로 다른 마감을 본다(앱은 1시간이라는데 데몬은 15분에 끊는다).
   */
  it('찍힌 계좌 마감이 있으면 그걸 따른다 — 상수로 다시 계산하지 않는다', () => {
    const stampedEarly = presigned({ presignedAt: NOW - 100, accountDeadline: NOW - 1 });
    expect(decideOnchainAction(stampedEarly, alive())).toEqual({ kind: 'settle', settlementKind: 'refund:customer-late' });
    const stampedLate = presigned({ presignedAt: NOW - ACCOUNT_WINDOW_SEC - 100, accountDeadline: NOW + 60 });
    expect(decideOnchainAction(stampedLate, alive()).kind).toBe('idle');
  });

  it('계좌 공개 전에는 고객 차례 — ACCOUNT_WINDOW_SEC', () => {
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

  it('총 옵션 창이 T0+105분을 못 넘는다 (계좌 창 1시간, 2026-09-25)', () => {
    expect(MAX_OPTION_WINDOW_SEC).toBe(105 * 60);
    expect(PRESIGN_WINDOW_SEC + ACCOUNT_WINDOW_SEC + KRW_WINDOW_SEC).toBe(MAX_OPTION_WINDOW_SEC);
  });

  it('여기서도 리오그가 우선이다', () => {
    expect(decideOnchainAction(presigned(), ctx({ pinned: GONE })).kind).toBe('reorg');
  });

  /**
   * T-124 — 후원자가 마감 **전에** 계좌 이의를 냈다면 마감이 차도 곧장 후원자 몰수가
   * 아니다. 잠정 사유로 보증금을 붙잡고 사람이 가른다(전에는 이의가 콘솔에만 남았다).
   */
  it('계좌 이의가 있으면 잠정 사유(account-disputed)로 환불한다', () => {
    const o = presigned({
      presignedAt: NOW - 10_000, accountSentAt: NOW - KRW_WINDOW_SEC,
      krwDeadline: NOW, accountDisputedAt: NOW - 600,
    });
    expect(decideOnchainAction(o, alive({ accountInfoSent: true }))).toEqual({
      kind: 'settle', settlementKind: 'refund:account-disputed',
    });
  });
});

describe('refunding — 결정은 되돌아가지 않는다', () => {
  const refunding = (over: Partial<OnchainOrder> = {}) => order({
    state: 'refunding', fundingOutpoint: formatOutpoint(TXID, 0), fundedAt: NOW - 10_000,
    settlementKind: 'refund:sponsor-timeout', settlementFeeSat: 400, decidedAt: NOW - 100, ...over,
  });

  it('고객 서명을 기다린다 — 다시 결정하지 않는다', () => {
    expect(decideOnchainAction(refunding(), ctx()).kind).toBe('idle');
  });

  it('얕은 리오그면 다시 캐지길 기다린다 (거래를 되살리지 않는다)', () => {
    expect(decideOnchainAction(refunding(), ctx({
      pinned: { status: 'shallow', confirmations: 0, required: 2 },
    })).kind).toBe('hold');
  });

  it('펀딩이 사라지면 사람을 부른다', () => {
    expect(decideOnchainAction(refunding(), ctx({ pinned: GONE })).kind).toBe('anomaly');
  });

});

describe('원화가 오간 뒤에는 리오그로 되돌리지 않는다', () => {
  it.each(['remitted', 'disputed'] as const)('%s + 펀딩 사라짐 → 사람을 부른다', state => {
    const o = order({ state, fundingOutpoint: formatOutpoint(TXID, 0), remittedAt: NOW - 100 });
    expect(decideOnchainAction(o, ctx({ pinned: GONE })).kind).toBe('anomaly');
  });
});

describe('remitted — 24시간 뒤 강제 분쟁 (O-010)', () => {
  const remitted = (over: Partial<OnchainOrder> = {}) =>
    order({ state: 'remitted', remittedAt: NOW - 100, fundingOutpoint: formatOutpoint(TXID, 0), ...over });

  it('마감 전에는 조용하다', () => {
    expect(decideOnchainAction(remitted(), ctx()).kind).toBe('idle');
  });

  /**
   * 느린 고객 대부분이 여기서 스스로 끝낸다 → 어드민이 안 불려 나온다. 전용 행동이라
   * 워처가 **한 번만** 알린다(전에는 경고로 내서 30초마다 푸시가 나갔다).
   */
  it('2시간 전에 유예 경고', () => {
    const o = remitted({ remittedAt: NOW - COSIGN_WINDOW_SEC + 2 * 3600 });
    expect(decideOnchainAction(o, ctx())).toEqual({ kind: 'dispute-soon' });
  });

  /** **고객 동의를 묻지 않는다.** 침묵으로 타임락까지 끄는 경로를 막는 자리다. */
  it('24시간을 넘기면 분쟁으로 강제 전이', () => {
    const o = remitted({ remittedAt: NOW - COSIGN_WINDOW_SEC });
    expect(decideOnchainAction(o, ctx())).toEqual({ kind: 'dispute' });
  });
});

describe('disputed — 하드 마감이 없다', () => {
  /** 자동 해소는 어느 방향이든 탈취다. 대신 사람을 더 세게 부른다. */
  it('시간이 지나도 스스로 해소하지 않는다', () => {
    const o = order({ state: 'disputed', updatedAt: NOW - 30 * 86_400, fundingOutpoint: formatOutpoint(TXID, 0) });
    const action = decideOnchainAction(o, ctx());
    expect(action.kind).toBe('warn');
    expect(['confirmed', 'settle', 'cancel']).not.toContain(action.kind);
  });

  it('7일·14일에 에스컬레이션한다', () => {
    const pinned = formatOutpoint(TXID, 0);
    const week = order({ state: 'disputed', updatedAt: NOW - 7 * 86_400, fundingOutpoint: pinned });
    expect(decideOnchainAction(week, ctx())).toMatchObject({ kind: 'warn' });
    const fresh = order({ state: 'disputed', updatedAt: NOW - 3600, fundingOutpoint: pinned });
    expect(decideOnchainAction(fresh, ctx()).kind).toBe('idle');
  });

  /**
   * 시계는 **분쟁 진입 시각**이다. `updatedAt`은 재발행(판정 기록·필드 수정)
   * 마다 바뀌어 에스컬레이션이 리셋됐다.
   */
  it('재발행으로 updatedAt이 바뀌어도 분쟁 시계는 진입 시각이다', () => {
    const o = order({
      state: 'disputed', disputedAt: NOW - 8 * 86_400, updatedAt: NOW - 60,
      fundingOutpoint: formatOutpoint(TXID, 0),
    });
    expect(decideOnchainAction(o, ctx())).toMatchObject({ kind: 'warn' });
  });
});

describe('settling — 컨펌되면 터미널 (O-005)', () => {
  const settling = (over: Partial<OnchainOrder> = {}) => order({
    state: 'settling', settlementKind: 'release', settlementTxid: TXID,
    fundingOutpoint: formatOutpoint('aa'.repeat(32), 0), settlingAt: NOW - 100, ...over,
  });

  /**
   * 종결 tx도 **펀딩과 같은 컨펌 수**를 요구한다. 터미널 판정이 곧 보증금
   * 정산(실제 LN 결제)을 부르므로, 기록이 체인보다 앞서 가면 안 된다.
   */
  it('요구 컨펌을 채우면 종결 (500k sat = 2컨펌)', () => {
    const shallow = decideOnchainAction(settling(), ctx({
      settlementTx: { known: true, value: { seen: true, confirmed: true, confirmations: 1, blockHeight: 1 } },
    }));
    expect(shallow.kind).toBe('idle');

    const action = decideOnchainAction(settling(), ctx({
      settlementTx: { known: true, value: { seen: true, confirmed: true, confirmations: 2, blockHeight: 1 } },
    }));
    expect(action).toEqual({ kind: 'confirmed' });
  });

  it('소액(1컨펌 요구)은 1컨펌에 종결된다', () => {
    const o = settling({ amountSat: 50_000 });
    const action = decideOnchainAction(o, ctx({
      settlementTx: { known: true, value: { seen: true, confirmed: true, confirmations: 1, blockHeight: 1 } },
    }));
    expect(action).toEqual({ kind: 'confirmed' });
  });

  it('멤풀이면 기다린다', () => {
    const action = decideOnchainAction(settling(), ctx({
      settlementTx: { known: true, value: { seen: true, confirmed: false, confirmations: 0 } },
    }));
    expect(action.kind).toBe('idle');
  });

  /** 되돌아가지 않는다. 재브로드캐스트 + CPFP가 답이다. */
  it('24시간 넘게 안 잡히면 경고 (되돌리지 않는다)', () => {
    const o = settling({ settlingAt: NOW - SETTLING_WARN_SEC });
    const action = decideOnchainAction(o, ctx({
      settlementTx: { known: true, value: { seen: true, confirmed: false, confirmations: 0 } },
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

  /**
   * O-005 "멤풀 이탈은 같은 tx 재브로드캐스트로" — 전에는 404를 '모름'으로
   * 받아 영원히 hold했고, raw tx도 안 남겨 다시 뿌릴 수가 없었다.
   */
  it('노드가 모르면(쫓겨났으면) 같은 tx를 다시 뿌린다', () => {
    const gone = { known: true as const, value: { seen: false, confirmed: false, confirmations: 0 } };
    expect(decideOnchainAction(settling(), ctx({ settlementTx: gone, canRebroadcast: true })))
      .toEqual({ kind: 'rebroadcast' });
    expect(decideOnchainAction(settling(), ctx({ settlementTx: gone, canRebroadcast: false })).kind)
      .toBe('anomaly');
  });

  /** 에스크로를 다른 tx가 가져갔으면 우리 tx는 무효다 — 체인을 따른다 */
  it('에스크로가 다른 tx로 소모됐으면 소모 관측', () => {
    const other: PinnedFacts = { status: 'spent', txid: 'ff'.repeat(32), leaf: 'timelock', confirmed: true };
    expect(decideOnchainAction(settling(), ctx({ pinned: other }))).toMatchObject({
      kind: 'observe-spend', leaf: 'timelock',
    });
  });

  it('우리 tx가 소모한 것이면 평소대로 컨펌을 기다린다', () => {
    const ours: PinnedFacts = { status: 'spent', txid: TXID, leaf: 'release', confirmed: false };
    expect(decideOnchainAction(settling(), ctx({
      pinned: ours,
      settlementTx: { known: true, value: { seen: true, confirmed: false, confirmations: 0 } },
    })).kind).toBe('idle');
  });
});

describe('터미널은 관측만 한다', () => {
  it.each(['released', 'refunded', 'sponsor_wins', 'customer_wins', 'cancelled', 'swept'] as const)(
    '%s', state => {
      expect(decideOnchainAction(order({ state }), ctx()).kind).toBe('idle');
    },
  );
});
