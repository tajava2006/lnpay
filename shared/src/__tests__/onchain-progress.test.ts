/**
 * 온체인 배지 + 진행도
 *
 * **FSM을 고치면 다섯이 세트다**: 전이 맵 → 알림 문구 → 문서 → 진행도 → 배지.
 * 타입체커가 안 잡아주는 자리라 라이트닝에서 매번 빠뜨렸다 — `invoiced`를
 * 추가했을 때 다섯 군데 배지 중 넷에서 영어가 그대로 샜다.
 *
 * 여기서는 **상태 목록을 전수로 돌아** 그걸 막는다.
 */
import { describe, it, expect } from 'vitest';
import {
  ONCHAIN_STATES, ONCHAIN_TERMINAL_STATES, canOnchainTransition,
  type OnchainState,
} from '../onchain/state-machine';
import { ONCHAIN_STATE_DISPLAY, onchainStateDisplay } from '../onchain/display';
import type { SettlementKind } from '../onchain/state-machine';
import {
  ONCHAIN_PROGRESS_STEPS, onchainStepActor, resolveOnchainProgress, settlementSummary,
} from '../onchain/progress';

const ALL = Object.values(ONCHAIN_STATES);

describe('배지 전수', () => {
  it('모든 상태에 배지가 있다', () => {
    for (const s of ALL) {
      expect(ONCHAIN_STATE_DISPLAY[s], s).toBeDefined();
    }
    expect(Object.keys(ONCHAIN_STATE_DISPLAY).sort()).toEqual([...ALL].sort());
  });

  /** 영어가 새는 걸 막는다 — 폴백이 걸리면 상태 문자열이 그대로 화면에 뜬다. */
  it('라벨이 전부 한국어다', () => {
    for (const s of ALL) {
      const { label } = ONCHAIN_STATE_DISPLAY[s];
      expect(label, s).toMatch(/[가-힣]/);
      expect(label, s).not.toBe(s);
    }
  });

  it('색이 hex로 채워져 있다', () => {
    for (const s of ALL) {
      expect(ONCHAIN_STATE_DISPLAY[s].color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(ONCHAIN_STATE_DISPLAY[s].bg).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  /** 릴레이에서 온 문자열은 타입 보장이 없다. 진짜 미지의 입력에만 폴백이 걸린다. */
  it('모르는 문자열은 그대로 보여준다', () => {
    expect(onchainStateDisplay('escrowed').label).toBe('escrowed');
    expect(onchainStateDisplay('listed').label).toBe('오더북 등록');
  });
});

describe('진행도 사다리', () => {
  it('정상 경로 7단계', () => {
    expect(ONCHAIN_PROGRESS_STEPS.map(s => s.state)).toEqual([
      'listed', 'bonded', 'funded', 'presigned', 'remitted', 'settling', 'released',
    ]);
  });

  /**
   * 멤풀 관측은 상태가 아니라 화면 힌트다. `bonded` 한 단계가 "보내기 +
   * 컨펌"을 둘 다 덮는다 — 판정이 "마감 안에 N컨펌 됐는가" 하나뿐이라 쪼갤 게 없다.
   */
  it('멤풀 대기용 단계가 따로 없다', () => {
    expect(ONCHAIN_PROGRESS_STEPS.map(s => s.state)).not.toContain('funding');
  });

  /**
   * 사다리는 FSM의 **정상 경로 그 자체**여야 한다. 둘이 갈라지면 화면이
   * 일어날 수 없는 순서를 그린다.
   */
  it('인접한 두 단계가 실제 전이로 이어진다', () => {
    for (let i = 0; i < ONCHAIN_PROGRESS_STEPS.length - 1; i++) {
      const from = ONCHAIN_PROGRESS_STEPS[i]!.state;
      const to = ONCHAIN_PROGRESS_STEPS[i + 1]!.state;
      expect(canOnchainTransition(from, to), `${from} → ${to}`).toBe(true);
    }
  });

  it('양쪽 역할 모두 할 일이 적혀 있다', () => {
    for (const step of ONCHAIN_PROGRESS_STEPS) {
      expect(step.customer.length, step.state).toBeGreaterThan(0);
      expect(step.sponsor.length, step.state).toBeGreaterThan(0);
      expect(step.title).toMatch(/[가-힣]/);
    }
  });

  /** 마감을 어기면 보증금을 잃는 단계는 **반드시 그 사실을 적는다.** */
  it.each(['bonded', 'funded', 'presigned'] as const)('%s 단계가 몰수를 고지한다', state => {
    const step = ONCHAIN_PROGRESS_STEPS.find(s => s.state === state)!;
    const text = [...step.customer, ...step.sponsor].map(a => a.text).join(' ');
    expect(text).toMatch(/내 보증금이 몰수됩니다/);
  });
});

describe('단계별 주체', () => {
  it('presigned는 계좌 전달 전후로 주체가 바뀐다', () => {
    expect(onchainStepActor('presigned')).toBe('customer');
    expect(onchainStepActor('presigned', { accountInfoSent: true })).toBe('sponsor');
  });

  /**
   * `{A,C}` 환불은 어드민 혼자 못 한다. "마감 초과 → 자동 환불"이 진짜 자동이
   * 아니라서, 그 사이 공은 고객에게 있다 — 화면이 그걸 보여줘야 한다.
   */
  it('환불 진행(refunding)은 고객 차례다 — 어드민 혼자 환불 못 한다', () => {
    expect(onchainStepActor('refunding')).toBe('customer');
  });

  it('컨펌 대기 구간은 아무의 차례도 아니다', () => {
    expect(onchainStepActor('settling')).toBe('chain');
    expect(onchainStepActor('released')).toBe('chain');
  });

  /** 펀딩은 보내는 것도 컨펌시키는 것도 고객 책임이라 한 단계 내내 고객 차례다. */
  it('펀딩 단계는 컨펌까지 고객 차례다', () => {
    expect(onchainStepActor('bonded')).toBe('customer');
  });

  it('사다리 밖 상태는 admin (판정 대기)', () => {
    expect(onchainStepActor('disputed')).toBe('admin');
  });
});

describe('진행도 해석', () => {
  it('정상 진행 중에는 현재 단계가 잡힌다', () => {
    const p = resolveOnchainProgress('customer', 'funded');
    expect(p.currentIndex).toBe(2);
    expect(p.steps[2]!.status).toBe('current');
    expect(p.steps[1]!.status).toBe('done');
    expect(p.steps[3]!.status).toBe('upcoming');
    expect(p.terminal).toBeNull();
    expect(p.disputed).toBe(false);
  });

  it('내 차례 판정이 역할을 탄다', () => {
    expect(resolveOnchainProgress('customer', 'bonded').steps[1]!.isMyTurn).toBe(true);
    expect(resolveOnchainProgress('sponsor', 'bonded').steps[1]!.isMyTurn).toBe(false);
    expect(resolveOnchainProgress('sponsor', 'funded').steps[2]!.isMyTurn).toBe(true);
  });

  it('역할에 따라 다른 문구를 준다', () => {
    const c = resolveOnchainProgress('customer', 'bonded').steps[1]!.actions;
    const s = resolveOnchainProgress('sponsor', 'bonded').steps[1]!.actions;
    expect(c).not.toEqual(s);
  });

  it('분쟁 중에는 사다리가 멈추고 remitted까지 완료로 둔다', () => {
    const p = resolveOnchainProgress('customer', 'disputed');
    expect(p.disputed).toBe(true);
    expect(p.terminal).toBeNull();
    expect(p.currentIndex).toBe(-1);
    expect(p.steps.find(s => s.state === 'remitted')!.status).toBe('done');
    expect(p.steps.find(s => s.state === 'released')!.status).toBe('upcoming');
  });

  /**
   * **모르면 추측하지 않는다.** 취소는 펀딩 전이라 어디서 끊겼는지 알 수 없다 —
   * 안 일어난 단계를 완료로 그리면 화면이 거짓말을 한다.
   */
  it('취소는 아무 단계도 완료로 치지 않는다', () => {
    const p = resolveOnchainProgress('customer', 'cancelled');
    expect(p.terminal?.state).toBe('cancelled');
    expect(p.steps.every(s => s.status === 'upcoming')).toBe(true);
  });

  it('환불·타임락 회수는 펀딩 컨펌까지만 완료로 친다', () => {
    for (const state of ['refunded', 'swept'] as const) {
      const p = resolveOnchainProgress('customer', state);
      expect(p.terminal?.state, state).toBe(state);
      expect(p.steps.find(s => s.state === 'bonded')!.status, state).toBe('done');
      expect(p.steps.find(s => s.state === 'presigned')!.status, state).toBe('upcoming');
    }
  });

  it('분쟁 판정은 remitted까지 완료로 친다', () => {
    for (const state of ['sponsor_wins', 'customer_wins'] as const) {
      const p = resolveOnchainProgress('sponsor', state);
      expect(p.steps.find(s => s.state === 'remitted')!.status, state).toBe('done');
      expect(p.currentIndex).toBe(-1);
    }
  });

  it('환불 안내에 수수료 2회 부담이 들어 있다', () => {
    const p = resolveOnchainProgress('customer', 'refunded');
    expect(p.terminal!.description).toMatch(/두 번/);
    expect(p.terminal!.description).toMatch(/보장되지는 않습니다/);
  });

  it('모든 터미널 상태가 사다리에서 안 터진다', () => {
    for (const s of ONCHAIN_TERMINAL_STATES) {
      const p = resolveOnchainProgress('customer', s as OnchainState);
      expect(p.steps).toHaveLength(ONCHAIN_PROGRESS_STEPS.length);
      // released만 사다리 안쪽 종착이고, 나머지는 이탈 종료다
      expect(p.terminal === null).toBe(s === 'released');
    }
  });

  it('released는 마지막 단계가 현재다', () => {
    const p = resolveOnchainProgress('sponsor', 'released');
    expect(p.currentIndex).toBe(ONCHAIN_PROGRESS_STEPS.length - 1);
    expect(p.steps[p.steps.length - 1]!.status).toBe('current');
  });
});

/**
 * 유저 문구는 나·상대방으로 — 고객·후원자는 쿠팡 대리구매 시절 이름이라 온체인에서 안 읽힌다 (2026-09-25).
 * 드릴에서 빼 달라고 한 문구가 다시 들어오지 않게도 묶는다.
 */
describe('유저 문구', () => {
  const all = (role: 'customer' | 'sponsor') =>
    ONCHAIN_PROGRESS_STEPS.flatMap(s => [s.title, ...s[role].map(a => a.text)]).join('\n');

  it.each(['customer', 'sponsor'] as const)('%s 화면에 역할 이름(고객·후원자)이 없다', role => {
    expect(all(role)).not.toMatch(/고객|후원자/);
  });

  it('드릴에서 뺀 문구가 없다', () => {
    const text = all('customer') + all('sponsor');
    expect(text).not.toMatch(/지연 이체|즉시 이체|마감 시계는 멈추지/);
  });

  it('창 길이는 상수에서 온다', () => {
    expect(all('customer')).toContain('**2시간 안에 컨펌까지**');
    expect(all('customer')).toContain('**1시간 안에** 보내야');
  });
});

/** 받을 출력으로 CPFP하는 안내는 받는 쪽에게만 — 환불이면 파는 쪽도 받는다 (2026-09-25) */
describe('종결 대기 — CPFP 안내', () => {
  const cpfp = (role: 'customer' | 'sponsor', settlementKind?: SettlementKind) =>
    resolveOnchainProgress(role, 'settling', { settlementKind }).steps
      .find(s => s.state === 'settling')!.actions.filter(a => /CPFP/.test(a.text));

  it('지급이면 사는 쪽에게만', () => {
    expect(cpfp('sponsor', 'release')).toHaveLength(1);
    expect(cpfp('customer', 'release')).toHaveLength(0);
  });

  it('환불이면 파는 쪽에게만 — 사는 쪽은 받는 게 없다', () => {
    expect(cpfp('customer', 'refund:customer-late')).toHaveLength(1);
    expect(cpfp('sponsor', 'refund:sponsor-timeout')).toHaveLength(0);
    expect(cpfp('customer', 'customer_win')).toHaveLength(1);
    expect(cpfp('sponsor', 'sponsor_win')).toHaveLength(1);
  });

  it('종결 사유를 모르면 양쪽에 조건부로', () => {
    expect(cpfp('customer')[0]?.optional).toBe(true);
    expect(cpfp('sponsor')[0]?.optional).toBe(true);
  });
});

/** 종결 tx 대기 중에도 어떤 종결인지 보인다 — 컨펌 전엔 상태가 settling 하나라 안 보였다 (2026-09-25) */
describe('settlementSummary', () => {
  it('정상 지급과 판정을 가르고, 보는 사람 입장에서 말한다', () => {
    expect(settlementSummary('customer', 'release')).toBe('정상 완료 — 비트코인이 상대방에게 갑니다');
    expect(settlementSummary('sponsor', 'sponsor_win')).toBe('분쟁 판정(송금 인정) — 비트코인이 나에게 옵니다');
    expect(settlementSummary('customer', 'customer_win')).toMatch(/송금 불인정.*나에게 돌아옵니다/);
    expect(settlementSummary('sponsor', 'refund:customer-late')).toMatch(/^환불 — .*상대방에게/);
  });
});
