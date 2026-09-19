/**
 * FSM 전이 + 금액 규칙
 *
 * 돈 경로의 순서를 고정한다. 여기 있는 항목 하나하나가
 * docs/DESIGN-LATE-INVOICE.md의 공격 분석에 대응한다 — 전이 맵이 느슨해지면
 * 그 공격이 다시 열린다는 뜻이다.
 */
import { describe, it, expect } from 'vitest';
import type { OrderState } from '@sajwo-tracker/shared';
import {
  canTransition, computePayoutSat, computeEscrowSat, isPayoutAmountExact,
} from '../state-machine';

const ALL: OrderState[] = [
  'requested', 'claimed', 'verified', 'escrowed', 'invoiced',
  'remitted', 'paid', 'cancelled', 'sponsor_wins', 'customer_wins', 'admin_closed',
];

describe('정상 경로', () => {
  it.each([
    ['requested', 'claimed'],
    ['claimed', 'verified'],
    ['claimed', 'requested'],
    ['verified', 'escrowed'],
    ['escrowed', 'invoiced'],
    ['invoiced', 'remitted'],
    ['invoiced', 'paid'],
    ['remitted', 'paid'],
    ['remitted', 'sponsor_wins'],
    ['remitted', 'customer_wins'],
  ] as const)('%s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });
});

describe('순서 건너뛰기 차단', () => {
  /**
   * 공격 D. 후원자가 에스크로 전에 인보이스를 내밀어 계좌 관문을 미리 여는 것.
   * 핸들러의 if가 아니라 전이 맵이 막아야 한다 — 그래야 새 경로가 생겨도 안전하다.
   */
  it('verified → invoiced 불가 (에스크로 없이 인보이스 접수 금지)', () => {
    expect(canTransition('verified', 'invoiced')).toBe(false);
  });

  it('escrowed → remitted 불가 (인보이스 없이 송금 주장 금지)', () => {
    expect(canTransition('escrowed', 'remitted')).toBe(false);
  });

  /**
   * 공격 F / 불변조건 I-010. 지급 대상 없이 settle하면 BTC가 어드민에 묶인다.
   * 예전에 있던 지름길이라 되살아나기 쉽다.
   */
  it('escrowed → paid 불가 (지급 대상 없이 settle 금지)', () => {
    expect(canTransition('escrowed', 'paid')).toBe(false);
  });

  it('claimed/verified → remitted·paid 불가', () => {
    for (const from of ['claimed', 'verified'] as const) {
      expect(canTransition(from, 'remitted')).toBe(false);
      expect(canTransition(from, 'paid')).toBe(false);
    }
  });
});

describe('에스크로 이후 일방 취소 차단 (T-001 ~ T-003)', () => {
  /**
   * 공격 G. escrowed에서는 계좌가 안 나갔으니 안전해 보이지만, 고객이 계좌를
   * 미리 뿌리고 후원자가 고친 코드로 송금하면 선취적 취소가 부활한다.
   */
  it.each(['escrowed', 'invoiced', 'remitted'] as const)('%s → cancelled 불가', from => {
    expect(canTransition(from, 'cancelled')).toBe(false);
  });

  it('requested/claimed/verified에서는 취소 가능', () => {
    for (const from of ['requested', 'claimed', 'verified'] as const) {
      expect(canTransition(from, 'cancelled')).toBe(true);
    }
  });
});

describe('터미널 상태', () => {
  it.each(['paid', 'cancelled', 'sponsor_wins', 'customer_wins'] as const)(
    '%s에서는 어디로도 못 간다',
    from => {
      for (const to of ALL) expect(canTransition(from, to)).toBe(false);
    },
  );
});

describe('자기 자신으로의 전이 금지', () => {
  // 릴레이 재전송으로 같은 요청이 반복 도착한다. 자기 전이가 열려 있으면
  // 같은 사건이 몇 번이고 다시 처리된다.
  it.each(ALL)('%s → 같은 상태 불가', state => {
    expect(canTransition(state, state)).toBe(false);
  });
});

// ── 금액 규칙 ────────────────────────────────────────

describe('payout 산출', () => {
  it('KRW / 시세로 sat을 구한다', () => {
    // 1,000,000원 / 1억원 per BTC = 0.01 BTC = 1,000,000 sat
    expect(computePayoutSat(1_000_000, 100_000_000)).toBe(1_000_000);
  });

  it.each([
    ['가격 0', 1000, 0],
    ['가격 음수', 1000, -1],
    ['주문액 0', 0, 100_000_000],
    ['NaN', NaN, 100_000_000],
  ])('%s이면 null — 조용히 0을 내지 않는다', (_label, krw, price) => {
    expect(computePayoutSat(krw, price)).toBeNull();
  });

  it('1 sat 미만으로 떨어지면 null', () => {
    expect(computePayoutSat(0.0001, 100_000_000)).toBeNull();
  });
});

describe('에스크로 금액 파생', () => {
  /**
   * 파생 방향이 뒤집히면(에스크로 먼저, payout을 역산) 반올림이 어긋나
   * 정확 일치 검증이 깨진다. 그래서 항상 payout이 기준이다.
   */
  it('payout보다 항상 크다 — 마진이 최소 1 sat', () => {
    for (const payout of [1, 2, 99, 100, 1171, 1_000_000]) {
      expect(computeEscrowSat(payout)).toBeGreaterThan(payout);
    }
  });

  it('0.5%를 올림한다', () => {
    expect(computeEscrowSat(1_000_000)).toBe(1_005_000);
    expect(computeEscrowSat(1171)).toBe(1177); // 1176.855 → 올림
  });
});

describe('인보이스 금액 정확 일치 (불변조건 I-011)', () => {
  it('정확히 같아야 통과', () => {
    expect(isPayoutAmountExact(1171, 1171)).toBe(true);
  });

  /**
   * 공격 B. 예전 ±5% 범위 검사였다면 1229까지 통과했다.
   * 금액을 정한 게 우리인 이상 근사를 허용할 이유가 없다.
   */
  it.each([1170, 1172, 1229, 1112])('%d은 거절 — 1 sat만 달라도 안 된다', amount => {
    expect(isPayoutAmountExact(1171, amount)).toBe(false);
  });

  it('payout이 정해지지 않았으면 무조건 거절', () => {
    expect(isPayoutAmountExact(undefined, 1171)).toBe(false);
    expect(isPayoutAmountExact(0, 0)).toBe(false);
  });
});

describe('어드민 강제 종결 (admin_closed)', () => {
  /**
   * 방치된 거래의 홀드 인보이스가 CLTV 타임아웃까지 유동성을 붙들고, 그 채널로
   * 나가는 **다른 결제까지 막는다**(2026-09-19 실측). 끊을 길이 필요했다.
   */
  it('에스크로가 잡힌 두 상태에서만 갈 수 있다', () => {
    expect(canTransition('escrowed', 'admin_closed')).toBe(true);
    expect(canTransition('invoiced', 'admin_closed')).toBe(true);
  });

  /**
   * 그 앞은 `cancelled`가 이미 담당하고, `remitted`는 분쟁 경로가 있다.
   * 여기를 넓히면 "어드민이 아무 때나 끊을 수 있는" 상태가 되어 FSM이 의미를 잃는다.
   */
  it.each(['requested', 'claimed', 'verified', 'remitted'] as const)(
    '%s에서는 못 간다',
    from => {
      expect(canTransition(from, 'admin_closed')).toBe(false);
    },
  );

  it('터미널이다 — 어디로도 못 나간다', () => {
    for (const to of ALL) expect(canTransition('admin_closed', to)).toBe(false);
  });

  /**
   * `escrowed → cancelled`를 여는 대신 새 상태를 만든 이유가 이것이다.
   * 그 경로를 열면 고객이 후원자의 송금 직전에 선취적으로 취소할 수 있다(T-003).
   */
  it('일방 취소 경로는 여전히 닫혀 있다', () => {
    expect(canTransition('escrowed', 'cancelled')).toBe(false);
    expect(canTransition('invoiced', 'cancelled')).toBe(false);
  });
});
