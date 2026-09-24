/**
 * 펀딩 판정 (PLAN-ONCHAIN-TRACK §4.1c · §7 D·E·K)
 *
 * 순수 함수라 전수로 돈다. 여기 한 줄이 틀리면 **돈이 있는 주소를 비었다고 보고
 * 취소**하거나, **되돌릴 수 있는 0-conf 위에 가격을 고정**한다.
 */
import { describe, it, expect } from 'vitest';
import { canCancelOnchain } from '@sajwo-tracker/shared/onchain';
import type { AddressFunds, ChainQuery, ChainUtxo } from '@sajwo-tracker/shared/onchain';
import {
  escrowUnfundedFor, judgeFunding, judgePinnedFunding, requiredConfirmations, strayUtxos,
  type FundingVerdict,
} from '../onchain/funding';

const TXID = 'a'.repeat(64);
const AMOUNT = 50_000;

function utxo(over: Partial<ChainUtxo> = {}): ChainUtxo {
  return { txid: TXID, vout: 0, valueSat: AMOUNT, confirmations: 1, ...over };
}

function known(funds: Partial<AddressFunds>): ChainQuery<AddressFunds> {
  return { known: true, value: { confirmed: [], mempool: [], ...funds } };
}

const UNKNOWN: ChainQuery<AddressFunds> = { known: false, reason: '502' };

describe('요구 컨펌 수 (§12 Q1)', () => {
  it.each([
    [1, 1], [99_999, 1],
    [100_000, 2], [999_999, 2],
    [1_000_000, 3], [100_000_000, 3],
  ])('%s sat → %s컨펌', (amount, confs) => {
    expect(requiredConfirmations(amount)).toBe(confs);
  });

  it('금액이 비정상이면 던진다 (조용히 1컨펌으로 떨어지지 않는다)', () => {
    expect(() => requiredConfirmations(0)).toThrow();
    expect(() => requiredConfirmations(Number.NaN)).toThrow();
  });
});

describe('펀딩 판정', () => {
  it('조회 실패는 "모름" — 없다고 하지 않는다', () => {
    const v = judgeFunding(UNKNOWN, AMOUNT);
    expect(v.status).toBe('unknown');
  });

  it('빈 주소는 none', () => {
    expect(judgeFunding(known({}), AMOUNT)).toEqual({ status: 'none' });
  });

  /**
   * 멤풀은 **화면 힌트 전용**이다. `pending`을 돌려주긴 하지만 판정상으로는
   * `none`과 같이 취급한다 — 0-conf는 RBF로 되돌릴 수 있다(공격 D).
   */
  it('멤풀에만 있으면 pending (금액이 맞아도 funded가 아니다)', () => {
    const v = judgeFunding(known({ mempool: [utxo({ confirmations: 0 })] }), AMOUNT);
    expect(v).toEqual({ status: 'pending', mempoolValueSat: AMOUNT });
  });

  it('컨펌이 모자라면 confirming', () => {
    const v = judgeFunding(
      known({ confirmed: [utxo({ confirmations: 1, valueSat: 1_000_000 })] }),
      1_000_000,
    );
    expect(v.status).toBe('confirming');
    if (v.status !== 'confirming') return;
    expect(v.required).toBe(3);
    expect(v.outpoint).toEqual({ txid: TXID, vout: 0 });
  });

  it('금액이 정확하고 N컨펌이면 funded + outpoint를 준다', () => {
    const v = judgeFunding(known({ confirmed: [utxo({ confirmations: 2 })] }), AMOUNT);
    expect(v).toEqual({
      status: 'funded',
      outpoint: { txid: TXID, vout: 0 },
      confirmations: 2,
      valueSat: AMOUNT,
    });
  });

  it('멤풀에 다른 게 있어도 컨펌된 게 맞으면 funded다', () => {
    const v = judgeFunding(
      known({ confirmed: [utxo({ confirmations: 1 })], mempool: [utxo({ txid: 'b'.repeat(64) })] }),
      AMOUNT,
    );
    expect(v.status).toBe('funded');
  });
});

describe('모양이 다르면 사람이 본다 (공격 K)', () => {
  /**
   * 자동으로 진행해서도, 취소해서도 안 된다 — 취소하면 그 자금이 아무도 안 보는
   * 주소에 남는다. 대개 `{A,C}` 협조 환불로 돌려주는 자리다.
   */
  it('UTXO가 2개면 anomaly', () => {
    const v = judgeFunding(
      known({ confirmed: [utxo(), utxo({ txid: 'b'.repeat(64) })] }),
      AMOUNT,
    );
    expect(v.status).toBe('anomaly');
    if (v.status !== 'anomaly') return;
    expect(v.utxoCount).toBe(2);
    expect(v.confirmedValueSat).toBe(AMOUNT * 2);
  });

  /** 더 보내도 anomaly다 — 릴리스는 UTXO를 통째로 보내므로 초과분이 공짜로 넘어간다. */
  it('초과 송금도 anomaly', () => {
    const v = judgeFunding(known({ confirmed: [utxo({ valueSat: AMOUNT + 1 })] }), AMOUNT);
    expect(v.status).toBe('anomaly');
  });

  it('부족 송금도 anomaly', () => {
    const v = judgeFunding(known({ confirmed: [utxo({ valueSat: AMOUNT - 1 })] }), AMOUNT);
    expect(v.status).toBe('anomaly');
  });
});

describe('O-014 게이트로 넘기는 값', () => {
  const cases: Array<[FundingVerdict['status'], boolean | undefined]> = [
    ['unknown', undefined],
    ['none', true],
    ['pending', true],
    ['confirming', false],
    ['funded', false],
    ['anomaly', false],
  ];

  it.each(cases)('%s → escrowUnfunded=%s', (status, expected) => {
    const verdict = { status, reason: 'x', mempoolValueSat: 0, confirmations: 1, required: 1,
      outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT, confirmedValueSat: AMOUNT,
      utxoCount: 1 } as unknown as FundingVerdict;
    expect(escrowUnfundedFor(verdict)).toBe(expected);
  });

  /** 게이트와 실제로 맞물리는지 — 여기가 어긋나면 위 표가 무의미하다. */
  it('"모름"이면 취소가 막힌다', () => {
    const v = judgeFunding(UNKNOWN, AMOUNT);
    expect(canCancelOnchain('bonded', escrowUnfundedFor(v))).toBe(false);
  });

  it('컨펌된 자금이 있으면 취소가 막힌다 (anomaly 포함)', () => {
    for (const funds of [
      known({ confirmed: [utxo()] }),
      known({ confirmed: [utxo(), utxo({ vout: 1 })] }),
    ]) {
      const v = judgeFunding(funds, AMOUNT);
      expect(canCancelOnchain('bonded', escrowUnfundedFor(v))).toBe(false);
    }
  });

  it('진짜로 빈 주소만 취소된다', () => {
    const v = judgeFunding(known({}), AMOUNT);
    expect(canCancelOnchain('bonded', escrowUnfundedFor(v))).toBe(true);
  });
});

describe('funded 이후 감시 (O-008)', () => {
  const pinned = { txid: TXID, vout: 0 };

  it('그대로면 alive', () => {
    const s = judgePinnedFunding(known({ confirmed: [utxo({ confirmations: 6 })] }), pinned, AMOUNT);
    expect(s).toEqual({ status: 'alive', confirmations: 6 });
  });

  /** 리오그로 컨펌이 N 아래로 내려감 → 가격 고정 폐기 + `bonded` 복귀 + 마감 재설정. */
  it('컨펌이 모자라지면 shallow', () => {
    const s = judgePinnedFunding(
      known({ confirmed: [utxo({ confirmations: 1, valueSat: 1_000_000 })] }), pinned, 1_000_000,
    );
    expect(s).toEqual({ status: 'shallow', confirmations: 1, required: 3 });
  });

  it('멤풀로 내려가도 shallow다 (gone과 구분한다 — 다시 캐지면 살아난다)', () => {
    const s = judgePinnedFunding(known({ mempool: [utxo({ confirmations: 0 })] }), pinned, AMOUNT);
    expect(s).toEqual({ status: 'shallow', confirmations: 0, required: 1 });
  });

  /**
   * 리뷰 #8 — 목록에 없다는 건 **"왜 없는지 모른다"**다. esplora `/utxo`는 멤풀에서
   * 소모된 출력도 빼므로, 우리가 방금 뿌린 환불도 이렇게 보인다. 전에는 곧장 `gone`
   * (이중지불)으로 읽어 `bonded`로 되돌렸다. 이제 워처가 소모 여부를 따로 묻는다.
   */
  it('목록에서 빠지면 missing — 이중지불이라고 단정하지 않는다', () => {
    const s = judgePinnedFunding(known({ confirmed: [utxo({ txid: 'b'.repeat(64) })] }), pinned, AMOUNT);
    expect(s).toEqual({ status: 'missing' });
  });

  it('조회 실패는 missing이 아니라 unknown이다', () => {
    const s = judgePinnedFunding(UNKNOWN, pinned, AMOUNT);
    expect(s.status).toBe('unknown');
  });

  /**
   * `funded` 뒤에 같은 주소로 돈이 더 들어와도 **이미 고정된 거래를 흔들지 않는다.**
   * 추가 자금은 별도 이상 징후로 사람에게 올릴 일이지 상태를 되돌릴 일이 아니다.
   */
  it('나중에 들어온 추가 UTXO가 판정을 흔들지 않는다', () => {
    const s = judgePinnedFunding(
      known({ confirmed: [utxo({ confirmations: 3 }), utxo({ txid: 'c'.repeat(64) })] }),
      pinned, AMOUNT,
    );
    expect(s).toEqual({ status: 'alive', confirmations: 3 });
  });
});

describe('약정 밖의 자금 (리뷰 #8 — 구조 대상)', () => {
  const pinned = { txid: TXID, vout: 0 };

  it('박아둔 outpoint를 뺀 컨펌된 UTXO 전부', () => {
    const extra = utxo({ txid: 'c'.repeat(64), valueSat: 1234 });
    expect(strayUtxos(known({ confirmed: [utxo(), extra] }), pinned))
      .toEqual([{ txid: 'c'.repeat(64), vout: 0, valueSat: 1234 }]);
  });

  it('박아둔 게 없으면(취소·금액 불일치) 컨펌된 전부', () => {
    expect(strayUtxos(known({ confirmed: [utxo()] }), null)).toHaveLength(1);
  });

  it('멤풀 것은 아직 대상이 아니다 (되돌려질 수 있다)', () => {
    expect(strayUtxos(known({ mempool: [utxo({ confirmations: 0 })] }), null)).toEqual([]);
  });

  it('조회 실패면 비어 있다 — 없는 걸 있다고 부르지 않는다', () => {
    expect(strayUtxos(UNKNOWN, null)).toEqual([]);
  });
});
