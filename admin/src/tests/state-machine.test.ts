import { describe, it, expect } from 'vitest';
import { canTransition, isInvoiceAmountValid } from '../state-machine';

// ── FSM 전이 ────────────────────────────────────────

describe('canTransition — 정상 경로', () => {
  it('requested → claimed', () => expect(canTransition('requested', 'claimed')).toBe(true));
  it('requested → cancelled', () => expect(canTransition('requested', 'cancelled')).toBe(true));
  it('claimed → verified', () => expect(canTransition('claimed', 'verified')).toBe(true));
  it('claimed → requested (Sponsor 이탈)', () => expect(canTransition('claimed', 'requested')).toBe(true));
  it('claimed → cancelled', () => expect(canTransition('claimed', 'cancelled')).toBe(true));
  it('verified → escrowed', () => expect(canTransition('verified', 'escrowed')).toBe(true));
  it('verified → cancelled', () => expect(canTransition('verified', 'cancelled')).toBe(true));
  it('escrowed → remitted', () => expect(canTransition('escrowed', 'remitted')).toBe(true));
  it('escrowed → paid (Customer 직접 확인)', () => expect(canTransition('escrowed', 'paid')).toBe(true));
  it('remitted → paid', () => expect(canTransition('remitted', 'paid')).toBe(true));
  it('remitted → sponsor_wins', () => expect(canTransition('remitted', 'sponsor_wins')).toBe(true));
  it('remitted → customer_wins', () => expect(canTransition('remitted', 'customer_wins')).toBe(true));
});

describe('canTransition — 불허 전이 (건너뜀/역방향)', () => {
  it('requested → paid 직접 불가', () => expect(canTransition('requested', 'paid')).toBe(false));
  it('requested → verified 건너뜀 불가', () => expect(canTransition('requested', 'verified')).toBe(false));
  it('requested → escrowed 건너뜀 불가', () => expect(canTransition('requested', 'escrowed')).toBe(false));
  it('verified → claimed 역방향 불가', () => expect(canTransition('verified', 'claimed')).toBe(false));
  it('escrowed → cancelled 불가 (에스크로 후 일방 취소 금지)', () => expect(canTransition('escrowed', 'cancelled')).toBe(false));
  it('remitted → cancelled 불가', () => expect(canTransition('remitted', 'cancelled')).toBe(false));
  it('remitted → escrowed 역방향 불가', () => expect(canTransition('remitted', 'escrowed')).toBe(false));
});

describe('canTransition — 터미널 상태', () => {
  const terminals = ['paid', 'cancelled', 'sponsor_wins', 'customer_wins'] as const;
  const allStates = ['requested', 'claimed', 'verified', 'escrowed', 'remitted', 'paid', 'cancelled', 'sponsor_wins', 'customer_wins'] as const;

  for (const terminal of terminals) {
    it(`${terminal}에서 어떤 상태로도 전이 불가`, () => {
      for (const to of allStates) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    });
  }
});

// ── 인보이스 금액 검증 ───────────────────────────────

describe('isInvoiceAmountValid', () => {
  // 100만 KRW 주문, BTC 가격 1억 KRW → 기대 sat = 1,000,000
  // (1_000_000 / 100_000_000) * 1e8 = 1_000_000 sat
  const orderPrice = 1_000_000;
  const btcPrice = 100_000_000;
  const expectedSat = 1_000_000;

  it('정확한 금액 허용', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, expectedSat)).toBe(true);
  });

  it('+4% 허용 (±5% 이내)', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, Math.round(expectedSat * 1.04))).toBe(true);
  });

  it('-4% 허용 (±5% 이내)', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, Math.round(expectedSat * 0.96))).toBe(true);
  });

  it('+5% 경계값 허용', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, Math.round(expectedSat * 1.05))).toBe(true);
  });

  it('-5% 경계값 허용', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, Math.round(expectedSat * 0.95))).toBe(true);
  });

  it('+5% 초과 거부', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, Math.round(expectedSat * 1.051))).toBe(false);
  });

  it('-5% 미만 거부', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, Math.round(expectedSat * 0.949))).toBe(false);
  });

  it('amountSat=0 거부', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, 0)).toBe(false);
  });

  it('amountSat 음수 거부', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, -1)).toBe(false);
  });

  it('amountSat NaN 거부', () => {
    expect(isInvoiceAmountValid(orderPrice, btcPrice, NaN)).toBe(false);
  });

  it('btcPrice=0 거부', () => {
    expect(isInvoiceAmountValid(orderPrice, 0, expectedSat)).toBe(false);
  });

  it('btcPrice 음수 거부', () => {
    expect(isInvoiceAmountValid(orderPrice, -1, expectedSat)).toBe(false);
  });

  it('orderPrice=0 거부', () => {
    expect(isInvoiceAmountValid(0, btcPrice, expectedSat)).toBe(false);
  });
});
