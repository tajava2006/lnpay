/**
 * 온체인 워처 — 체인과 시계가 미는 전이 (프론트 시절 `onchain-watcher` 테스트를 데몬으로)
 *
 * 판단 자체는 `oc-decide.test.ts`(순수 함수)가 전수로 본다. 여기는 **집행**을 본다 — 판단한 대로 장부가
 * 바뀌는지, 옛 판단으로 새 상태를 덮지 않는지.
 */
import { describe, expect, it } from 'vitest';
import {
  FUNDING_WINDOW_SEC, buildSettlementTx, finalizeSettlement, signSettlement, type AddressFunds, type ChainQuery,
} from '@sajwo-tracker/shared/onchain';
import { openAlerts } from '../admin/alerts';
import { deriveOnchainAdminKey } from '../derive';
import { AMOUNT, FUND_TXID, PAYOUT, SK_S, claimOc, createOcHarness, descriptorOf, fundOc, openOc, presignOc } from './oc-fakes';

describe('fund — 가격 고정', () => {
  it('outpoint·컨펌·가격·payout·수수료를 한 번에 박는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    const o = h.row(orderId)!.order;
    expect(o).toMatchObject({ state: 'funded', fundingOutpoint: `${FUND_TXID}:0`, fundingConfs: 3 });
    expect(o.fundedAt).toBeDefined();
    expect(o.releaseFeeSat).toBeGreaterThan(0);
  });

  it('신선한 시세가 없으면 가격을 고정하지 않고 기다린다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    h.price.value = null;
    await fundOc(h, orderId);
    expect(h.row(orderId)!.order.state).toBe('bonded');
    h.price.value = 150_000_000;
    await h.run();
    expect(h.row(orderId)!.order.state).toBe('funded');
  });
});

describe('fold — 가격을 고정하지 않고 접는다', () => {
  it('후원자 보증금이 죽었으면 funded를 거치지 않고 환불을 결정한다 (O-015)', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    // 보증금 HTLC가 만기로 돌아갔다 — 노드가 스스로 취소
    h.node.holds.get(h.row(orderId)!.order.sponsorDepositHash!)!.state = 'cancelled';
    await h.run(1);
    await fundOc(h, orderId);
    const o = h.row(orderId)!.order;
    expect(o).toMatchObject({ state: 'refunding', settlementKind: 'refund:bond-expired', fundingOutpoint: `${FUND_TXID}:0` });
    expect(o.priceKrw).toBeUndefined();
  });

  it('시세가 고객 최저가 미만이면 무과실 환불 (양쪽 보증금 환불)', async () => {
    const h = await createOcHarness();
    const market = Math.round((AMOUNT / 1e8) * 150_000_000);
    const orderId = await openOc(h, { reserveKrw: Math.round(market * 0.9) });
    await claimOc(h, orderId);
    h.price.value = 120_000_000; // 20% 빠졌다
    await fundOc(h, orderId);
    const o = h.row(orderId)!.order;
    expect(o.settlementKind).toBe('refund:reserve');
    expect(h.node.stateOf(o.customerDepositHash!)).toBe('cancelled');
    expect(h.node.stateOf(o.sponsorDepositHash!)).toBe('cancelled');
  });
});

describe('cancel — 사유가 곧 보증금 처리다', () => {
  it('의뢰 만료는 무과실 (고객 보증금 환불)', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h, { listingSec: 3600 });
    h.advance(3601);
    await h.run();
    const o = h.row(orderId)!.order;
    expect(o.state).toBe('cancelled');
    expect(h.node.stateOf(o.customerDepositHash!)).toBe('cancelled');
  });

  it('재시작 직후(워밍업)에는 마감으로 닫지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    h.advance(FUNDING_WINDOW_SEC + 1);
    await h.daemon.stop();
    const again = h.start(h.ln.db);
    await h.settle(again);
    expect(h.row(orderId)!.order.state).toBe('bonded');
    h.advance(3 * 60);
    await h.settle(again);
    await h.settle(again);
    expect(h.row(orderId)!.order.state).toBe('cancelled');
  });
});

describe('reorg — 가격 고정을 실제로 지운다 (O-008)', () => {
  it('funded-era 필드가 비워지고, 펀딩 마감을 다시 찍고, 사람에게 알린다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    h.advance(90 * 60); // 원래 펀딩 마감은 30분 남짓 남았다 — 리오그는 새로 2시간을 준다
    h.chain.confirm(FUND_TXID, 0); // 멤풀로 내려갔다
    await h.run();
    const o = h.row(orderId)!.order;
    expect(o.state).toBe('bonded');
    for (const k of ['fundingOutpoint', 'fundedAt', 'priceKrw', 'payoutSat', 'releaseFeeSat', 'presignedAt'] as const) {
      expect(o[k], k).toBeUndefined();
    }
    expect(o.fundingDeadline).toBeGreaterThan(h.sec() + FUNDING_WINDOW_SEC - 60);
    expect(openAlerts(h.ln).some(a => a.orderId === orderId && /리오그/.test(a.message))).toBe(true);
  });
});

describe('소모 관측', () => {
  it('장부에 없는 어드민 리프 소모는 사람을 부른다 (어드민 키 유출 의심)', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    // 누군가 어드민 키와 후원자 키로 {A,S}를 썼다 — 판정한 적 없다
    const tx = buildSettlementTx({
      descriptor: descriptorOf(h, orderId), input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'sponsor-win', destination: PAYOUT, feeSat: 500,
    });
    signSettlement(tx, SK_S);
    signSettlement(tx, deriveOnchainAdminKey(new Uint8Array(32).fill(7), orderId));
    finalizeSettlement(tx, 'sponsor-win');
    h.chain.inject(tx, 1);
    await h.run();
    expect(h.row(orderId)!.order.state).toBe('funded');
    expect(openAlerts(h.ln).some(a => a.level === 'anomaly' && /어드민 키 유출/.test(a.message))).toBe(true);
  });
});

describe('옛 판단으로 새 상태를 덮지 않는다', () => {
  it('조회하는 사이 오더가 바뀌었으면(버전이 다르면) 아무것도 하지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    const stale = h.row(orderId)!.version;
    await fundOc(h, orderId);
    const before = h.row(orderId)!;
    // bonded 시절에 모은 사실 — 지금(funded) 그대로 적용하면 "펀딩이 사라졌다"로 읽혀 bonded로 되돌린다
    const empty: ChainQuery<AddressFunds> = { known: true, value: { confirmed: [], mempool: [] } };
    h.ln.db.tx(() => h.daemon.onchain!.watcher.apply(orderId, stale, { funds: empty, pinned: { status: 'gone' } }));
    expect(h.row(orderId)!.version).toBe(before.version);
    expect(h.row(orderId)!.order.state).toBe('funded');
  });
});
