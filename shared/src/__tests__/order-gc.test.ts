import { describe, it, expect } from 'vitest';
import { isAbandonedOrder } from '../index';
import type { Order, Request, OrderState } from '../index';

const NOW = 1_700_000_000;

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: 'order-1',
    status: 'active',
    state: 'requested',
    customerPubkey: 'c'.repeat(64),
    price: 50_000,
    createdAt: NOW - 86_400,
    updatedAt: NOW - 86_400,
    expiration: NOW - 60, // 이미 만료
    raw: {},
    ...overrides,
  };
}

function makeRequest(action: string): Request {
  return {
    eventId: `event-${action}`,
    orderId: 'order-1',
    pubkey: 'p'.repeat(64),
    action,
    createdAt: NOW - 3600,
    expiration: NOW - 60,
    raw: {},
  } as Request;
}

describe('isAbandonedOrder', () => {
  it('만료 + requested + 최초 등록뿐이면 방치된 것', () => {
    expect(isAbandonedOrder(makeOrder(), [makeRequest('order-request')], NOW)).toBe(true);
  });

  it('요청이 아예 없어도 방치된 것', () => {
    expect(isAbandonedOrder(makeOrder(), [], NOW)).toBe(true);
  });

  it('파싱 주문도 최초 등록으로 친다', () => {
    expect(isAbandonedOrder(makeOrder(), [makeRequest('parsed-order')], NOW)).toBe(true);
  });

  it('아직 만료 전이면 대상이 아니다', () => {
    const order = makeOrder({ expiration: NOW + 3600 });
    expect(isAbandonedOrder(order, [makeRequest('order-request')], NOW)).toBe(false);
  });

  it('만료 시각이 없으면(0) 대상이 아니다', () => {
    const order = makeOrder({ expiration: 0 });
    expect(isAbandonedOrder(order, [], NOW)).toBe(false);
  });

  // 핵심 회귀 방지: FSM에 claimed → requested 역전이가 있다(revertClaim).
  // 상태만 보면 되돌아온 오더가 "아무도 안 건드린 것"으로 잘못 분류되어
  // 후원자가 붙었던 기록과 보증금 흔적이 함께 지워진다.
  it('클레임됐다가 철회되어 requested로 돌아온 오더는 지우지 않는다', () => {
    const requests = [makeRequest('order-request'), makeRequest('claim')];
    expect(isAbandonedOrder(makeOrder(), requests, NOW)).toBe(false);
  });

  it('진행 흔적이 있으면 어떤 종류든 지우지 않는다', () => {
    for (const action of ['claim', 'account-info', 'remit-request', 'payment-confirm', 'dispute-message']) {
      const requests = [makeRequest('order-request'), makeRequest(action)];
      expect(isAbandonedOrder(makeOrder(), requests, NOW)).toBe(false);
    }
  });

  it('requested가 아닌 상태는 만료됐어도 지우지 않는다', () => {
    const states: OrderState[] = ['claimed', 'verified', 'escrowed', 'remitted', 'paid', 'cancelled'];
    for (const state of states) {
      expect(isAbandonedOrder(makeOrder({ state }), [], NOW)).toBe(false);
    }
  });
});
