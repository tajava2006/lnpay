/**
 * 온체인 오더 스토어 (PLAN-ONCHAIN-TRACK §1.1)
 *
 * 라이트닝 스토어와 **다른 키를 쓰는지**, 그리고 **전이와 필드 갱신이 한 번에
 * 일어나는지**를 본다. 둘을 갈라 두면 "전이는 됐는데 그 상태가 요구하는 값이
 * 아직 없는" 순간이 생기고, 그 사이 발행이 나가면 태그가 빠진 채로 덮어쓴다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
import {
  _resetForTesting, applyOnchainTransition, getOnchainOrder, getSnapshot,
  subscribe, upsertOnchainOrder,
} from '../onchain/order-store';

function order(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'o-1', state: 'listed', status: 'active',
    customerPubkey: 'cust', amountSat: 500_000,
    createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
    expiration: 1_700_600_000, network: 'signet', raw: {},
    ...over,
  };
}

beforeEach(() => _resetForTesting());

describe('저장', () => {
  it('넣고 꺼낸다', () => {
    upsertOnchainOrder(order());
    expect(getOnchainOrder('o-1')?.state).toBe('listed');
    expect(Object.keys(getSnapshot())).toEqual(['o-1']);
  });

  /** 라이트닝 트랙을 건드리지 않고 붙였다 뗐다 할 수 있어야 한다(§1.2). */
  it('라이트닝과 다른 저장 키를 쓴다', () => {
    upsertOnchainOrder(order());
    expect(localStorage.getItem('admin:onchain-orders')).toContain('o-1');
    expect(localStorage.getItem('admin:orders')).toBeNull();
  });

  it('더 오래된 에코는 무시한다', () => {
    upsertOnchainOrder(order({ state: 'bonded', updatedAt: 200 }));
    upsertOnchainOrder(order({ state: 'listed', updatedAt: 100 }));
    expect(getOnchainOrder('o-1')?.state).toBe('bonded');
  });

  it('같은 시각이면 덮어쓴다 (릴레이 에코로 같은 내용이 다시 온다)', () => {
    upsertOnchainOrder(order({ state: 'bonded', updatedAt: 200 }));
    upsertOnchainOrder(order({ state: 'bonded', updatedAt: 200, escrowAddress: 'tb1p' }));
    expect(getOnchainOrder('o-1')?.escrowAddress).toBe('tb1p');
  });

  it('구독자에게 알린다', () => {
    let hits = 0;
    const off = subscribe(() => hits++);
    upsertOnchainOrder(order());
    applyOnchainTransition('o-1', { state: 'bonded' });
    off();
    upsertOnchainOrder(order({ orderId: 'o-2' }));
    expect(hits).toBe(2);
  });
});

describe('전이', () => {
  beforeEach(() => upsertOnchainOrder(order()));

  it('전이와 필드 갱신이 한 번에 간다', () => {
    const r = applyOnchainTransition('o-1', {
      state: 'bonded', sponsorPubkey: 's', escrowAddress: 'tb1p', timelockBlocks: 8064,
    });
    expect(r.success).toBe(true);
    const after = getOnchainOrder('o-1')!;
    expect(after.state).toBe('bonded');
    expect(after.escrowAddress).toBe('tb1p');
  });

  it('규칙에 없는 전이는 아무것도 바꾸지 않는다', () => {
    const r = applyOnchainTransition('o-1', { state: 'remitted', escrowAddress: 'tb1p' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatch(/INVALID_TRANSITION/);
    expect(getOnchainOrder('o-1')!.escrowAddress).toBeUndefined();
  });

  it('상태를 안 바꾸고 필드만 갱신할 수 있다', () => {
    const r = applyOnchainTransition('o-1', { fundingDeadline: 123 });
    expect(r.success).toBe(true);
    expect(getOnchainOrder('o-1')!.state).toBe('listed');
    expect(getOnchainOrder('o-1')!.fundingDeadline).toBe(123);
  });

  it('없는 오더는 실패한다', () => {
    const r = applyOnchainTransition('nope', { state: 'bonded' });
    expect(r.success).toBe(false);
  });

  it('터미널이면 status가 sold가 된다', () => {
    applyOnchainTransition('o-1', { state: 'cancelled' });
    expect(getOnchainOrder('o-1')!.status).toBe('sold');
  });

  /**
   * 같은 초에 두 번 갱신되면 릴레이·스토어가 나중 것을 버린다.
   * updatedAt은 **항상 앞으로만** 간다.
   */
  it('updatedAt이 항상 증가한다', () => {
    const before = getOnchainOrder('o-1')!.updatedAt;
    applyOnchainTransition('o-1', { state: 'bonded' });
    const mid = getOnchainOrder('o-1')!.updatedAt;
    applyOnchainTransition('o-1', { escrowAddress: 'x' });
    const after = getOnchainOrder('o-1')!.updatedAt;
    expect(mid).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(mid);
  });
});
