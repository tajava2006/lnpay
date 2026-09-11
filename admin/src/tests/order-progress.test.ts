import { describe, it, expect } from 'vitest';
import {
  PROGRESS_STEPS,
  resolveProgress,
  stepActor,
  sponsorRelation,
} from '@sajwo-tracker/shared';
import type { OrderState } from '@sajwo-tracker/shared';

const idx = (state: OrderState) => PROGRESS_STEPS.findIndex(s => s.state === state);

describe('resolveProgress', () => {
  it('정상 경로에서 현재 단계 앞은 완료, 뒤는 예정으로 표시한다', () => {
    const { steps, currentIndex, terminal } = resolveProgress('customer', 'verified');

    expect(terminal).toBeNull();
    expect(currentIndex).toBe(idx('verified'));
    expect(steps.map(s => s.status)).toEqual([
      'done',     // requested
      'done',     // claimed
      'current',  // verified
      'upcoming', // escrowed
      'upcoming', // remitted
      'upcoming', // paid
    ]);
  });

  it('role에 따라 같은 단계에서 다른 할 일을 돌려준다', () => {
    const customer = resolveProgress('customer', 'requested').steps[0]!;
    const sponsor = resolveProgress('sponsor', 'requested').steps[0]!;

    expect(customer.actions).not.toEqual(sponsor.actions);
    // requested는 후원자가 움직일 차례
    expect(sponsor.isMyTurn).toBe(true);
    expect(customer.isMyTurn).toBe(false);
  });

  it('escrowed는 계좌정보 전달 여부로 차례가 넘어간다', () => {
    // 아직 계좌 안 보냄 → 고객 차례
    expect(stepActor('escrowed', { accountInfoSent: false })).toBe('customer');
    expect(resolveProgress('customer', 'escrowed', { accountInfoSent: false })
      .steps[idx('escrowed')]!.isMyTurn).toBe(true);

    // 계좌 보냄 → 후원자 차례
    expect(stepActor('escrowed', { accountInfoSent: true })).toBe('sponsor');
    expect(resolveProgress('sponsor', 'escrowed', { accountInfoSent: true })
      .steps[idx('escrowed')]!.isMyTurn).toBe(true);
    expect(resolveProgress('customer', 'escrowed', { accountInfoSent: true })
      .steps[idx('escrowed')]!.isMyTurn).toBe(false);
  });

  it('claimed는 어느 쪽도 내 차례가 아니다 (에스크로 검증 대기)', () => {
    for (const role of ['customer', 'sponsor'] as const) {
      const step = resolveProgress(role, 'claimed').steps[idx('claimed')]!;
      expect(step.status).toBe('current');
      expect(step.isMyTurn).toBe(false);
      expect(step.actor).toBe('admin');
    }
  });

  it('분쟁 종료는 remitted까지 완료로 확정하고 terminal을 돌려준다', () => {
    for (const state of ['sponsor_wins', 'customer_wins'] as const) {
      const { steps, currentIndex, terminal } = resolveProgress('sponsor', state);

      expect(terminal?.state).toBe(state);
      expect(currentIndex).toBe(-1);
      // FSM상 remitted에서만 올 수 있으므로 거기까지는 확정적으로 완료
      expect(steps[idx('remitted')]!.status).toBe('done');
      expect(steps[idx('escrowed')]!.status).toBe('done');
      // paid에는 도달하지 못했다
      expect(steps[idx('paid')]!.status).toBe('upcoming');
      expect(steps.some(s => s.status === 'current')).toBe(false);
    }
  });

  it('취소는 어디서 끊겼는지 알 수 없으므로 어떤 단계도 완료로 추측하지 않는다', () => {
    const { steps, currentIndex, terminal } = resolveProgress('customer', 'cancelled');

    expect(terminal?.state).toBe('cancelled');
    expect(currentIndex).toBe(-1);
    expect(steps.every(s => s.status === 'upcoming')).toBe(true);
  });

  it('paid는 이전 단계가 모두 완료된 마지막 단계다', () => {
    const { steps, terminal } = resolveProgress('sponsor', 'paid');

    expect(terminal).toBeNull();
    expect(steps.slice(0, -1).every(s => s.status === 'done')).toBe(true);
    expect(steps[steps.length - 1]!.status).toBe('current');
  });

  it('보증금 항목은 조건부로 표시된다', () => {
    const claimed = resolveProgress('sponsor', 'claimed').steps[idx('claimed')]!;
    expect(claimed.actions.some(a => a.optional)).toBe(true);
  });
});

describe('sponsorRelation', () => {
  const ME = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);

  it('requested는 내 키를 몰라도 항상 열려 있다', () => {
    expect(sponsorRelation({ state: 'requested' }, null)).toBe('open');
    expect(sponsorRelation({ state: 'requested', sponsorPubkey: OTHER }, ME)).toBe('open');
  });

  // 핵심 회귀 방지: Admin이 클레임을 철회하면 오더는 requested로 돌아오고
  // sponsorPubkey도 지워지지만, 남이 보낸 kind 1111 클레임 이벤트는 릴레이에 남는다.
  // 이벤트 존재를 근거로 삼으면 다시 열린 주문을 영영 잠긴 것으로 오판한다.
  it('클레임 철회로 requested로 되돌아온 주문은 다시 열린다', () => {
    const taken = { state: 'claimed' as const, sponsorPubkey: OTHER };
    expect(sponsorRelation(taken, ME)).toBe('taken');

    const reverted = { state: 'requested' as const, sponsorPubkey: undefined };
    expect(sponsorRelation(reverted, ME)).toBe('open');
  });

  it('내가 클레임한 거래는 mine', () => {
    expect(sponsorRelation({ state: 'escrowed', sponsorPubkey: ME }, ME)).toBe('mine');
  });

  it('남이 클레임한 거래는 taken', () => {
    expect(sponsorRelation({ state: 'escrowed', sponsorPubkey: OTHER }, ME)).toBe('taken');
  });

  it('키 로딩 전에는 남의 거래로 단정하지 않는다', () => {
    expect(sponsorRelation({ state: 'escrowed', sponsorPubkey: OTHER }, null)).toBe('unknown');
  });

  it('sponsorPubkey가 없는 비-requested 상태는 안전하게 taken', () => {
    expect(sponsorRelation({ state: 'verified' }, ME)).toBe('taken');
  });
});
