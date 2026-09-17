/**
 * 계좌 발행 게이트 (불변조건 I-009)
 *
 * 이 판정이 느슨해지면 **후원자가 원화를 잃는다.** 계좌번호를 본 직후가
 * 되돌릴 수 없는 이체 시점이라, "받을 준비가 됐는가"(= 인보이스 등록)가
 * 확인되기 전에는 계좌가 릴레이에 존재조차 하면 안 된다.
 *
 * 고객 앱에는 발행 경로가 둘(수동 입력·파싱 주문 자동 전송)이고 둘 다 이
 * 함수를 쓴다. 판정이 한 곳이어야 한쪽만 뚫리는 일이 없다.
 */
import { describe, it, expect } from 'vitest';
import { canSendAccountInfo } from '../order-progress';
import type { OrderState } from '../constants';

describe('canSendAccountInfo', () => {
  it('invoiced부터 열린다 — 후원자 인보이스가 검증된 뒤', () => {
    expect(canSendAccountInfo('invoiced')).toBe(true);
  });

  it('remitted에서도 열려 있다 — 재전송·복구 경로가 막히면 안 된다', () => {
    expect(canSendAccountInfo('remitted')).toBe(true);
  });

  /**
   * escrowed가 제일 위험한 경계다. BTC는 잠겼지만 후원자는 아직 받을 곳을
   * 등록하지 않았다. 여기서 계좌가 나가면 후원자가 "돈은 잠겼으니 괜찮겠지"
   * 하고 원화를 보내는데, 정작 자기는 못 받는 상황이 생긴다.
   */
  it('escrowed에서는 막힌다 — 인보이스 없이 계좌가 나가면 안 된다', () => {
    expect(canSendAccountInfo('escrowed')).toBe(false);
  });

  it.each(['requested', 'claimed', 'verified'] as const)(
    '%s에서는 막힌다 — 에스크로조차 없다',
    state => {
      expect(canSendAccountInfo(state)).toBe(false);
    },
  );

  it.each(['paid', 'cancelled', 'sponsor_wins', 'customer_wins'] as const)(
    '%s(종료)에서는 막힌다',
    state => {
      expect(canSendAccountInfo(state)).toBe(false);
    },
  );

  /**
   * 상태를 모를 때 열어주면, 상태가 아직 안 실린 오더에서 계좌가 새어 나간다.
   * 인자를 필수로 두면 호출부마다 기본값을 채우게 되고 그 기본값이 언젠가
   * 위험한 값으로 바뀐다 — 그래서 undefined를 받아 여기서 닫는다.
   */
  it('상태를 모르면 막는다', () => {
    expect(canSendAccountInfo(undefined)).toBe(false);
  });

  it('열려 있는 상태는 정확히 둘뿐이다', () => {
    const ALL: OrderState[] = [
      'requested', 'claimed', 'verified', 'escrowed', 'invoiced',
      'remitted', 'paid', 'cancelled', 'sponsor_wins', 'customer_wins',
    ];

    expect(ALL.filter(canSendAccountInfo)).toEqual(['invoiced', 'remitted']);
  });
});
