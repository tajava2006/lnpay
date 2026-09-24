/**
 * 온체인 보증금 (PLAN-ONCHAIN-TRACK §4.1 · §6.0) — 표를 그대로 집행하는가, CLTV가 거래 전체를 덮는가
 */
import { describe, expect, it } from 'vitest';
import { MAX_ORDER_EXPIRY_SEC, MAX_TRADE_DURATION_SEC, OUTCOME_RULES, type OnchainOutcome } from '@sajwo-tracker/shared/onchain';
import { CLTV_MAX_BLOCKS } from '../ln/timing';
import { applyOutcome } from '../onchain/bonds';
import { depositCltvBlocks, depositFloorSat, depositSat, minTradeSat } from '../onchain/deposit';
import { claimOc, createOcHarness, openOc, type OcHarness } from './oc-fakes';

async function bonded(): Promise<{ h: OcHarness; orderId: string }> {
  const h = await createOcHarness();
  const orderId = await openOc(h);
  await claimOc(h, orderId);
  return { h, orderId };
}

describe('표를 그대로 집행한다', () => {
  const cases = Object.entries(OUTCOME_RULES) as Array<[OnchainOutcome, typeof OUTCOME_RULES[OnchainOutcome]]>;
  const expectOf = (d: string) => (d === 'refund' ? 'cancelled' : d === 'forfeit' ? 'settled' : 'accepted');

  it.each(cases)('%s', async (outcome, rule) => {
    const { h, orderId } = await bonded();
    const order = h.row(orderId)!.order;
    h.ln.db.tx(() => applyOutcome(h.oc, order, outcome));
    await h.run(2);
    expect(h.node.stateOf(order.customerDepositHash!), 'customer').toBe(expectOf(rule.customerBond));
    // `none`은 후원자가 없는 단계의 사유다 — 여기선 붙어 있으므로 손대지 않는 것과 같다
    expect(h.node.stateOf(order.sponsorDepositHash!), 'sponsor').toBe(expectOf(rule.sponsorBond));
  });

  it('두 번 불러도 한 번만 처리한다 — 받은 것만 건드린다', async () => {
    const { h, orderId } = await bonded();
    const order = h.row(orderId)!.order;
    h.ln.db.tx(() => applyOutcome(h.oc, order, 'refund:sponsor-timeout'));
    await h.run(2);
    h.ln.db.tx(() => applyOutcome(h.oc, order, 'refund:customer-late'));
    await h.run(2);
    expect(h.node.stateOf(order.sponsorDepositHash!)).toBe('settled');
    expect(h.node.stateOf(order.customerDepositHash!)).toBe('cancelled');
  });
});

describe('보증금 크기 (§6.0)', () => {
  it('비율과 하한 중 큰 쪽 — 최소 거래액에서 실효 보증금이 3%를 안 넘는다', () => {
    const floor = depositFloorSat(169 * 20);
    expect(floor).toBe(169 * 20 * 4);
    const min = minTradeSat(floor);
    expect(depositSat(min, 3, floor) / min).toBeLessThanOrEqual(0.0301);
    expect(depositSat(10_000_000, 3, floor)).toBe(300_000);
  });
});

describe('보증금 CLTV가 거래 전체를 덮는가 (O-F1)', () => {
  const now = 1_800_000_000;

  it('만료 직전에 클레임돼도 거래 최악 소요를 덮는다', () => {
    const blocks = depositCltvBlocks(now + 3600, now);
    expect(blocks * 600).toBeGreaterThanOrEqual(3600 + MAX_TRADE_DURATION_SEC);
  });

  it('최장 의뢰(7일)에서도 우리 CLTV 상한 안이다', () => {
    expect(depositCltvBlocks(now + MAX_ORDER_EXPIRY_SEC, now)).toBeLessThanOrEqual(CLTV_MAX_BLOCKS);
  });

  it('이미 만료된 의뢰는 거부한다', () => {
    expect(() => depositCltvBlocks(now - 1, now)).toThrow();
  });
});
