/**
 * 온체인 오더 이벤트 규약
 *
 * 직렬화와 파싱을 같은 파일에 둔 이유가 여기 있다 — **왕복 테스트**가
 * "태그 하나를 추가하고 한쪽만 고치는" 사고를 잡는다.
 */
import { describe, it, expect } from 'vitest';
import {
  formatOutpoint, onchainOrderIssues, onchainOrderTags, parseOnchainOrder, parseOutpoint,
  type OnchainOrder, type OnchainOrderEvent,
} from '../onchain/order';

const TAG = 'sajwo-tracker-onchain';
const XC = 'a1'.repeat(32);
const XS = 'b2'.repeat(32);
const XA = 'c3'.repeat(32);
const TXID = 'd4'.repeat(32);

function base(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'order-1',
    state: 'listed',
    status: 'active',
    customerPubkey: 'cust-pubkey',
    amountSat: 500_000,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    expiration: 1_700_600_000,
    network: 'signet',
    raw: {},
    ...over,
  };
}

function asEvent(order: OnchainOrder, tag = TAG): OnchainOrderEvent {
  return {
    kind: 30402,
    pubkey: 'app-pubkey',
    created_at: order.updatedAt,
    tags: onchainOrderTags(order, tag),
  };
}

describe('왕복 — 직렬화한 걸 다시 읽으면 같다', () => {
  it('최소 오더 (listed)', () => {
    const order = base();
    const parsed = parseOnchainOrder(asEvent(order), TAG);
    expect(parsed).toMatchObject({
      orderId: 'order-1', state: 'listed', customerPubkey: 'cust-pubkey',
      amountSat: 500_000, network: 'signet', expiration: 1_700_600_000,
    });
  });

  it('모든 필드가 찬 오더 (settling)', () => {
    const order = base({
      state: 'settling',
      sponsorPubkey: 'sponsor-pubkey',
      reserveKrw: 90_000_000,
      customerXonly: XC, sponsorXonly: XS, adminXonly: XA,
      escrowAddress: 'tb1pescrow',
      timelockBlocks: 8064,
      fundingDeadline: 1_700_021_600,
      fundingOutpoint: formatOutpoint(TXID, 1),
      fundingConfs: 3,
      fundedAt: 1_700_010_000,
      priceKrw: 95_000_000,
      payoutSat: 499_662,
      releaseFeeSat: 338,
      presignedAt: 1_700_010_300,
      accountSentAt: 1_700_010_500,
      krwDeadline: 1_700_012_300,
      remittedAt: 1_700_011_000,
      settlementKind: 'release',
      settlementTxid: TXID,
      customerDepositHash: 'hash-c',
      sponsorDepositHash: 'hash-s',
    });

    const parsed = parseOnchainOrder(asEvent(order), TAG)!;
    expect(parsed).not.toBeNull();

    // raw/status/createdAt 말고는 전부 그대로 돌아와야 한다
    const { raw: _r1, status: _s1, createdAt: _c1, ...sent } = order;
    const { raw: _r2, status: _s2, createdAt: _c2, ...got } = parsed;
    expect(got).toEqual(sent);
  });

  it('터미널이면 status가 sold다', () => {
    const tags = onchainOrderTags(base({ state: 'released' }), TAG);
    expect(tags).toContainEqual(['status', 'sold']);
    expect(parseOnchainOrder({ kind: 30402, pubkey: 'p', created_at: 1, tags }, TAG)!.status)
      .toBe('sold');
  });

  it('비터미널이면 active다', () => {
    expect(onchainOrderTags(base({ state: 'disputed' }), TAG)).toContainEqual(['status', 'active']);
  });
});

describe('공개하지 않는 것', () => {
  /**
   * 후원자의 받을 주소는 **실제 지갑 주소**다. 공개 태그에 실으면 제3자가
   * 그 지갑을 따라갈 수 있다 — 일회성 파생 키와 성격이 다르다.
   * PSBT 안에 실려 어드민·고객에게만 간다.
   */
  it('받을 주소·feerate를 담는 태그가 없다', () => {
    const names = onchainOrderTags(base({ state: 'presigned' }), TAG).map(t => t[0]);
    expect(names).not.toContain('payout-address');
    expect(names).not.toContain('feerate');
  });
});

describe('트랙 분리', () => {
  /** 라이트닝 태그로 온 이벤트를 온체인으로 읽으면 배포 사고가 난다. */
  it('다른 CLIENT_TAG면 파싱하지 않는다', () => {
    expect(parseOnchainOrder(asEvent(base(), 'sajwo-tracker'), TAG)).toBeNull();
  });

  it('dev 태그와 prod 태그가 서로를 안 읽는다', () => {
    const dev = asEvent(base(), 'sajwo-tracker-onchain-dev');
    expect(parseOnchainOrder(dev, 'sajwo-tracker-onchain')).toBeNull();
    expect(parseOnchainOrder(dev, 'sajwo-tracker-onchain-dev')).not.toBeNull();
  });
});

describe('모르는 모양은 버린다', () => {
  function tamper(mutate: (tags: string[][]) => string[][]): OnchainOrderEvent {
    return { kind: 30402, pubkey: 'p', created_at: 1, tags: mutate(onchainOrderTags(base(), TAG)) };
  }

  /** 새 버전 클라이언트가 발행한 상태일 수 있다. 추측하면 화면이 거짓말을 한다. */
  it('모르는 상태', () => {
    expect(parseOnchainOrder(
      tamper(t => t.map(x => x[0] === 'state' ? ['state', 'escrowed'] : x)), TAG,
    )).toBeNull();
  });

  it('모르는 네트워크', () => {
    expect(parseOnchainOrder(
      tamper(t => t.map(x => x[0] === 'network' ? ['network', 'liquid'] : x)), TAG,
    )).toBeNull();
  });

  it.each(['d', 'state', 'customer', 'network', 'amount-sat'])('%s 태그가 없으면', name => {
    expect(parseOnchainOrder(tamper(t => t.filter(x => x[0] !== name)), TAG)).toBeNull();
  });

  it.each(['0', '-1', '1.5', 'abc'])('금액이 %s이면', value => {
    expect(parseOnchainOrder(
      tamper(t => t.map(x => x[0] === 'amount-sat' ? ['amount-sat', value] : x)), TAG,
    )).toBeNull();
  });

  /** 형식이 틀린 키로 주소를 파생하면 엉뚱한 주소가 나온다. */
  it.each(['customer-xonly', 'sponsor-xonly', 'admin-xonly'])('%s 형식이 틀리면', name => {
    const order = base({ state: 'bonded', customerXonly: XC, sponsorXonly: XS, adminXonly: XA });
    const tags = onchainOrderTags(order, TAG).map(t => t[0] === name ? [name, 'ZZ'] : t);
    expect(parseOnchainOrder({ kind: 30402, pubkey: 'p', created_at: 1, tags }, TAG)).toBeNull();
  });

  it('숫자 태그가 깨졌으면 그 필드만 비운다 (오더 전체를 버리지는 않는다)', () => {
    const order = base({ state: 'funded', priceKrw: 100 });
    const tags = onchainOrderTags(order, TAG).map(t => t[0] === 'price-krw' ? ['price-krw', 'NaN'] : t);
    const parsed = parseOnchainOrder({ kind: 30402, pubkey: 'p', created_at: 1, tags }, TAG);
    expect(parsed).not.toBeNull();
    expect(parsed!.priceKrw).toBeUndefined();
  });
});

describe('outpoint 문자열', () => {
  it('왕복', () => {
    expect(parseOutpoint(formatOutpoint(TXID, 2))).toEqual({ txid: TXID, vout: 2 });
  });

  it.each([undefined, '', 'nope', `${TXID}:`, `${TXID}:-1`, `${TXID}:1.5`, 'xx:0'])(
    '%s는 못 읽는다', value => { expect(parseOutpoint(value)).toBeNull(); },
  );
});

describe('빠진 태그 감시 (addressable은 덮어쓴다)', () => {
  /**
   * kind 30402는 새 발행이 이전 이벤트를 **덮어쓴다.** 한 번 빠진 태그는
   * 영영 복구되지 않는다 — 라이트닝에서 `payoutSat` 없이 발행해 주문 두 건을
   * 그렇게 잃었다(2026-09-19).
   */
  it('bonded 이후에 에스크로 정보가 없으면 잡아낸다', () => {
    const issues = onchainOrderIssues(base({ state: 'bonded' }));
    expect(issues).toContain('escrow-address');
    expect(issues).toContain('xonly 3종');
    expect(issues).toContain('sponsor');
  });

  it('funded 이후에 가격·outpoint가 없으면 잡아낸다', () => {
    const issues = onchainOrderIssues(base({ state: 'funded' }));
    expect(issues).toContain('funding-outpoint');
    expect(issues).toContain('price-krw');
    expect(issues).toContain('payout-sat');
  });

  it('settling인데 종결 정보가 없으면 잡아낸다', () => {
    expect(onchainOrderIssues(base({ state: 'settling' }))).toContain('settlement-txid');
  });

  it('제대로 찬 오더는 조용하다', () => {
    const full = base({
      state: 'settling', sponsorPubkey: 's',
      customerXonly: XC, sponsorXonly: XS, adminXonly: XA,
      escrowAddress: 'tb1p', timelockBlocks: 8064,
      fundingOutpoint: formatOutpoint(TXID, 0), priceKrw: 1, payoutSat: 1, fundedAt: 1,
      settlementKind: 'release', settlementTxid: TXID,
    });
    expect(onchainOrderIssues(full)).toEqual([]);
  });

  it('listed·cancelled는 에스크로 정보를 요구하지 않는다', () => {
    expect(onchainOrderIssues(base({ state: 'listed' }))).toEqual([]);
    expect(onchainOrderIssues(base({ state: 'cancelled' }))).toEqual([]);
  });
});
