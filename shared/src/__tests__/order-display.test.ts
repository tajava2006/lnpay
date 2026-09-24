/**
 * 상태 배지가 FSM을 따라온다
 *
 * 이 표가 다섯 군데에 복붙돼 있었고, `invoiced`를 추가했을 때 한 곳만 고쳐서
 * 나머지 넷에서 영어 "invoiced"가 그대로 떴다(2026-09-19). `TERMINAL_STATES`가
 * 다섯 군데 갈라져 종결 의뢰가 오더북에 남았던 것과 같은 사고다.
 *
 * 1차 방어는 타입이다 — `Record<OrderState, ...>`라 상태를 추가하면 빌드가 깨진다.
 * 여기서는 타입이 못 보는 것을 본다: 문구가 비어 있진 않은지, 색이 진짜 색인지.
 */
import { describe, it, expect } from 'vitest';
import {
  ORDER_STATES, SPONSOR_DEPOSIT_PENDING_DISPLAY, STATE_DISPLAY, lnOrderDisplay, stateDisplay, type OrderState,
} from '@sajwo-tracker/shared';

const ALL = Object.values(ORDER_STATES) as OrderState[];

describe('모든 상태에 배지가 있다', () => {
  it.each(ALL)('%s', state => {
    expect(STATE_DISPLAY[state]).toBeDefined();
  });

  it('키 집합이 ORDER_STATES와 정확히 같다', () => {
    expect(new Set(Object.keys(STATE_DISPLAY))).toEqual(new Set(ALL));
  });
});

describe('배지 내용이 쓸 만하다', () => {
  /** 빈 문자열이면 배지가 투명해진다 — 타입은 이걸 못 잡는다. */
  it.each(ALL)('%s는 한국어 문구를 가진다', state => {
    const { label } = STATE_DISPLAY[state];
    expect(label.trim().length).toBeGreaterThan(0);
    expect(label).not.toBe(state); // 영어 상태명이 새어나온 것
  });

  it.each(ALL)('%s는 유효한 색을 가진다', state => {
    const { color, bg } = STATE_DISPLAY[state];
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  /** 같은 문구가 둘이면 화면에서 두 상태를 구분할 수 없다. */
  it('문구가 서로 겹치지 않는다', () => {
    const labels = ALL.map(s => STATE_DISPLAY[s].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('모르는 상태 폴백', () => {
  /**
   * 릴레이에서 오는 문자열은 타입 보장이 없다(구 클라이언트, 손상된 이벤트).
   * 여기서 던지면 오더북 전체가 빈 화면이 된다.
   */
  it('처음 보는 값이면 그 문자열을 그대로 보여준다', () => {
    expect(stateDisplay('made_up').label).toBe('made_up');
    expect(stateDisplay('made_up').color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('아는 상태는 폴백을 타지 않는다', () => {
    for (const state of ALL) {
      expect(stateDisplay(state)).toEqual(STATE_DISPLAY[state]);
    }
  });
});

describe('라이트닝 배지 — 후원자 보증금 대기', () => {
  it('claimed + 대기면 "보증금 대기", 아니면 상태 배지 그대로', () => {
    expect(lnOrderDisplay({ state: 'claimed', sponsorDepositPending: true })).toBe(SPONSOR_DEPOSIT_PENDING_DISPLAY);
    expect(lnOrderDisplay({ state: 'claimed' })).toEqual(STATE_DISPLAY.claimed);
    // 다른 상태에 표시가 남아 있어도(옛 이벤트) 배지는 상태를 따른다
    expect(lnOrderDisplay({ state: 'verified', sponsorDepositPending: true })).toEqual(STATE_DISPLAY.verified);
  });
});
