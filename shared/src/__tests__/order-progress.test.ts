import { describe, it, expect } from 'vitest';
import {
  PROGRESS_STEPS,
  resolveProgress,
  stepActor,
  sponsorRelation,
  summarizeProgress,
} from '../index';
import type { OrderState } from '../index';
import { LN_CLOSE_REASON_LABEL } from '../ln';

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
      'upcoming', // invoiced
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

  it('escrowed는 후원자 차례다 — 인보이스를 등록해야 한다', () => {
    // 계좌 전달은 invoiced부터다. escrowed에서는 후원자가 인보이스를 낼 차례.
    expect(stepActor('escrowed')).toBe('sponsor');
    expect(resolveProgress('sponsor', 'escrowed').steps[idx('escrowed')]!.isMyTurn).toBe(true);
    expect(resolveProgress('customer', 'escrowed').steps[idx('escrowed')]!.isMyTurn).toBe(false);
  });

  it('invoiced는 계좌정보 전달 여부로 차례가 넘어간다', () => {
    // 아직 계좌 안 보냄 → 고객 차례
    expect(stepActor('invoiced', { accountInfoSent: false })).toBe('customer');
    expect(resolveProgress('customer', 'invoiced', { accountInfoSent: false })
      .steps[idx('invoiced')]!.isMyTurn).toBe(true);

    // 계좌 보냄 → 후원자 차례
    expect(stepActor('invoiced', { accountInfoSent: true })).toBe('sponsor');
    expect(resolveProgress('sponsor', 'invoiced', { accountInfoSent: true })
      .steps[idx('invoiced')]!.isMyTurn).toBe(true);
    expect(resolveProgress('customer', 'invoiced', { accountInfoSent: true })
      .steps[idx('invoiced')]!.isMyTurn).toBe(false);
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

  it('보증금 안내는 클레임하는 자리(requested)에 붙는다 — 거래 방해 방지·잘못하지 않는 한 전액', () => {
    // 보증금을 내는 시점이 "맡기"를 누를 때라 안내도 거기 있어야 한다.
    // claimed는 에스크로가 금액을 확정하는 대기 구간이라 후원자가 할 일이 없다.
    const requested = resolveProgress('sponsor', 'requested').steps[idx('requested')]!;
    expect(requested.actions.some(a => /보증금을 결제해야.*수수료 포함 전액/.test(a.text))).toBe(true);
  });
});

describe('sponsorRelation', () => {
  const ME = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const THIRD = 'c'.repeat(64);

  it('남이 올린 requested 주문은 열려 있다', () => {
    expect(sponsorRelation({ state: 'requested', customerPubkey: OTHER }, ME)).toBe('open');
  });

  // 앱 통합으로 한 키가 양쪽 역할을 겸하게 되면서 생긴 경우.
  // customerPubkey 검사가 requested 검사보다 먼저 와야 한다 —
  // 안 그러면 내가 올린 주문이 내 오더북에 클레임 가능한 것으로 뜬다.
  it('내가 올린 주문은 상태와 무관하게 own', () => {
    for (const state of ['requested', 'claimed', 'escrowed', 'paid'] as const) {
      expect(sponsorRelation({ state, customerPubkey: ME }, ME)).toBe('own');
    }
  });

  // 핵심 회귀 방지: Admin이 클레임을 철회하면 오더는 requested로 돌아오고
  // sponsorPubkey도 지워지지만, 남이 보낸 클레임 요청는 릴레이에 남는다.
  // 이벤트 존재를 근거로 삼으면 다시 열린 주문을 영영 잠긴 것으로 오판한다.
  it('클레임 철회로 requested로 되돌아온 주문은 다시 열린다', () => {
    const taken = { state: 'claimed' as const, customerPubkey: OTHER, sponsorPubkey: THIRD };
    expect(sponsorRelation(taken, ME)).toBe('taken');

    const reverted = { state: 'requested' as const, customerPubkey: OTHER, sponsorPubkey: undefined };
    expect(sponsorRelation(reverted, ME)).toBe('open');
  });

  it('내가 클레임한 거래는 mine', () => {
    expect(sponsorRelation({ state: 'escrowed', customerPubkey: OTHER, sponsorPubkey: ME }, ME)).toBe('mine');
  });

  it('남이 클레임한 거래는 taken', () => {
    expect(sponsorRelation({ state: 'escrowed', customerPubkey: OTHER, sponsorPubkey: THIRD }, ME)).toBe('taken');
  });

  it('키 로딩 전에는 단정하지 않되 requested는 열어둔다', () => {
    expect(sponsorRelation({ state: 'escrowed', customerPubkey: OTHER, sponsorPubkey: THIRD }, null)).toBe('unknown');
    expect(sponsorRelation({ state: 'requested', customerPubkey: OTHER }, null)).toBe('open');
  });

  it('sponsorPubkey가 없는 비-requested 상태는 안전하게 taken', () => {
    expect(sponsorRelation({ state: 'verified', customerPubkey: OTHER }, ME)).toBe('taken');
  });
});

describe('강제 종결 (admin_closed)', () => {
  /**
   * 분쟁 판정은 FSM상 remitted에서만 오므로 거기까지 완료로 확정할 수 있다.
   * 강제 종결은 escrowed일 수도 invoiced일 수도 있어 **상태만으로 구분되지 않는다.**
   *
   * 처음엔 분쟁과 같은 분기를 타게 해서, escrowed에서 끊은 거래에 "입금 확인"까지
   * 초록 체크가 찍혔다(2026-09-19 관측). 안 일어난 일을 완료로 그리는 화면이었다.
   */
  it('어떤 단계도 완료로 추측하지 않는다', () => {
    const { steps, terminal, currentIndex } = resolveProgress('customer', 'admin_closed');

    expect(terminal?.state).toBe('admin_closed');
    expect(currentIndex).toBe(-1);
    expect(steps.every(s => s.status === 'upcoming')).toBe(true);
  });

  it('분쟁 종료와 달리 remitted를 완료로 치지 않는다', () => {
    const closed = resolveProgress('customer', 'admin_closed');
    const dispute = resolveProgress('customer', 'customer_wins');

    expect(closed.steps[idx('remitted')]!.status).toBe('upcoming');
    expect(dispute.steps[idx('remitted')]!.status).toBe('done');
  });

  it('환불된다는 설명이 붙는다', () => {
    expect(resolveProgress('customer', 'admin_closed').terminal?.description).toContain('환불');
  });
});

/**
 * 후원자 보증금을 기다리는 클레임 (2026-09-24 mainnet 드릴)
 *
 * 상태는 claimed인데 진행도가 "후원자 확정 · 에스크로 대기 중"으로 떴다 — 실제로는 후원자가 보증금을
 * 내야 하고, 안 내면 클레임이 풀린다. 아직 확정이 아니다.
 */
describe('후원자 보증금 대기', () => {
  const pending = { sponsorDepositPending: true };

  it('사다리는 "후원자 찾는 중"에 서고, 후원자 차례다', () => {
    const sponsor = resolveProgress('sponsor', 'claimed', pending);
    expect(sponsor.currentIndex).toBe(idx('requested'));
    expect(sponsor.steps[idx('requested')]!.isMyTurn).toBe(true);
    expect(sponsor.steps[idx('claimed')]!.status).toBe('upcoming');
    expect(resolveProgress('customer', 'claimed', pending).steps[idx('requested')]!.isMyTurn).toBe(false);
  });

  /** 공개 거래의 보증금은 항상 있다(2026-10-22) — "요구될 수 있음" 같은 조건부 표시 없이, 지정 거래에서만 뺀다 */
  it('보증금 안내는 공개 거래면 늘 보이고, 지정 거래면 빠진다', () => {
    const depositLines = (p: ReturnType<typeof resolveProgress>) =>
      p.steps[idx('requested')]!.actions.filter(a => /보증금/.test(a.text));
    expect(depositLines(resolveProgress('sponsor', 'requested'))).toHaveLength(1);
    expect(depositLines(resolveProgress('sponsor', 'claimed', pending))).toHaveLength(1);
    expect(depositLines(resolveProgress('customer', 'requested'))).toHaveLength(1);
    expect(depositLines(resolveProgress('sponsor', 'requested', { designated: true }))).toHaveLength(0);
    expect(depositLines(resolveProgress('customer', 'requested', { designated: true }))).toHaveLength(0);
  });

  /** 취소·만료는 누구 잘못이냐에 따라 보증금이 다르다 — "전부 환불"은 몰수된 쪽에 거짓말이다 */
  it('취소·만료 설명은 에스크로 전액 환불과 보증금(종료 사유 확인)을 가른다', () => {
    for (const state of ['cancelled', 'expired'] as const) {
      const d = resolveProgress('customer', state).terminal!.description;
      expect(d).toMatch(/에스크로로 결제한 BTC는 수수료 포함 전액/);
      expect(d).toMatch(/종료 사유를 확인/);
    }
  });

  it('보증금이 들어왔거나 없으면 "사는 사람 확정"', () => {
    expect(resolveProgress('sponsor', 'claimed').currentIndex).toBe(idx('claimed'));
    expect(summarizeProgress('customer', 'claimed').title).toBe('사는 사람 확정');
    expect(summarizeProgress('customer', 'claimed', pending).title).toBe('사는 사람 찾는 중');
  });

  it('"지금은 보증금 없이 운영 중" 같은 운영값 추측을 박지 않는다 — 설정은 데몬에 있다', () => {
    const texts = PROGRESS_STEPS.flatMap(s => [...s.customer, ...s.sponsor]).map(a => a.text).join('\n');
    expect(texts).not.toMatch(/보증금 없이 운영/);
  });
});

describe('summarizeProgress', () => {
  it('종결이면 종결 이름, 차례 없음', () => {
    expect(summarizeProgress('customer', 'expired')).toEqual({ title: '기한 만료', terminal: true, isMyTurn: false, actor: null });
  });

  it('진행 중이면 현재 단계와 누구 차례인지', () => {
    expect(summarizeProgress('customer', 'verified')).toMatchObject({ title: '에스크로 결제', isMyTurn: true, actor: 'customer' });
    expect(summarizeProgress('sponsor', 'verified')).toMatchObject({ isMyTurn: false, actor: 'customer' });
  });
});

/** 지정 거래는 보증금이 없고 지정된 사람만 맡는다(LN-TRACK §7) — 사다리가 보증금·"먼저 누른 분"을 말하면 안 된다 */
describe('지정 거래 사다리', () => {
  const texts = (role: 'customer' | 'sponsor', designated: boolean) =>
    resolveProgress(role, 'requested', { designated }).steps.flatMap(s => s.actions.map(a => a.text));

  it('보증금 줄과 "먼저 누른 분"이 없다 — 대신 지정 거래 문구', () => {
    for (const role of ['customer', 'sponsor'] as const) {
      const t = texts(role, true);
      expect(t.filter(x => /보증금|몰수|먼저 누른 분/.test(x)), role).toEqual([]);
    }
    expect(texts('sponsor', true)).toContain("'수락'을 누르면 이 판매가 나에게 배정됩니다. 나를 지정한 판매라 다른 사람은 살 수 없습니다.");
  });

  it('공개 거래는 그대로', () => {
    expect(texts('sponsor', false).some(x => /먼저 누른 분/.test(x))).toBe(true);
    expect(texts('customer', false).some(x => /보증금/.test(x))).toBe(true);
  });
});

/**
 * 유저 문구는 파는 사람·사는 사람·판매로 (2026-10-24 피드백) — 고객·후원자·의뢰는 쿠팡 대리결제 시절 이름이라 온체인과
 * 말이 갈렸다(온체인 `onchain-progress.test.ts`의 같은 가드). 종료 사유는 유저 앱 카드에도 뜬다.
 */
describe('유저 문구 — 옛 이름이 없다', () => {
  const OLD = /고객|후원자|의뢰|맡기/;
  const stepTexts = PROGRESS_STEPS.flatMap(s => [
    s.title,
    ...[...s.customer, ...s.sponsor].flatMap(a => [a.text, ...(typeof a.designated === 'string' ? [a.designated] : [])]),
  ]);
  const terminals = (['cancelled', 'sponsor_wins', 'customer_wins', 'admin_closed', 'expired'] as const)
    .flatMap(state => {
      const t = resolveProgress('customer', state).terminal!;
      return [t.label, t.description];
    });

  it('진행도 단계·종결 문구', () => {
    expect([...stepTexts, ...terminals].filter(t => OLD.test(t))).toEqual([]);
  });

  it('종료 사유', () => {
    expect(Object.values(LN_CLOSE_REASON_LABEL).filter(t => OLD.test(t))).toEqual([]);
  });
});
