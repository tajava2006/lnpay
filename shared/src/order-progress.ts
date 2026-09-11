/**
 * 거래 진행도 모델 (고객·후원자 공용)
 *
 * 단계는 Admin FSM의 정상 경로를 그대로 따른다:
 *
 *   requested → claimed → verified → escrowed → remitted → paid
 *
 * 주문 등록(30402 발행 전) 구간은 여기 없다. 고객 클라이언트에만 존재하는
 * 상태라 후원자 쪽에서는 의미가 없고, 상세 화면 자체가 Admin 오더가 생긴
 * 뒤에야 열린다.
 *
 * 이탈 종료(cancelled / sponsor_wins / customer_wins)는 선형 사다리를 깨므로
 * 단계로 넣지 않고 terminal로 따로 돌려준다.
 */
import type { OrderState } from './constants';

export type ProgressRole = 'customer' | 'sponsor';
export type StepStatus = 'done' | 'current' | 'upcoming';

/** 이 단계에서 공을 쥔 쪽. 'admin'은 양쪽 다 기다리는 구간. */
export type StepActor = ProgressRole | 'admin';

export interface StepAction {
  text: string;
  /**
   * 조건부 항목. 보증금은 어드민 설정(퍼센트 0이면 없음)과 hold invoice 생성
   * 성공 여부에 달려 있어, 아직 오지 않은 단계에서는 요구될지 알 수 없다.
   */
  optional?: boolean;
}

export interface ProgressStep {
  state: OrderState;
  title: string;
  /** 정적 기본값. 실제 주체는 stepActor()가 문맥까지 반영해 결정한다. */
  actor: StepActor;
  customer: readonly StepAction[];
  sponsor: readonly StepAction[];
}

/** 진행도 판정에 필요한 부가 문맥 */
export interface ProgressContext {
  /** escrowed 단계에서 고객이 계좌정보를 이미 보냈는지 */
  accountInfoSent?: boolean;
}

export const PROGRESS_STEPS: readonly ProgressStep[] = [
  {
    state: 'requested',
    title: '후원자 찾는 중',
    actor: 'sponsor',
    customer: [
      { text: '후원자가 주문을 가져갈 때까지 기다립니다.' },
    ],
    sponsor: [
      { text: '주문 금액과 같은 금액의 Lightning 인보이스를 본인 지갑에서 만듭니다.' },
      { text: "인보이스를 붙여넣고 '사줄게'를 누릅니다. 유동성 검증용이라 이 시점에 실제 결제는 일어나지 않습니다." },
    ],
  },
  {
    state: 'claimed',
    title: '후원자 확정',
    actor: 'admin',
    customer: [
      { text: '에스크로가 후원자의 Lightning 경로를 검증합니다. 기다리면 됩니다.' },
    ],
    sponsor: [
      { text: '보증금 인보이스가 오면 결제합니다.', optional: true },
      { text: '에스크로의 경로 검증을 기다립니다.' },
    ],
  },
  {
    state: 'verified',
    title: '고객 결제',
    actor: 'customer',
    customer: [
      { text: "'결제하기'를 눌러 Lightning 인보이스를 결제합니다." },
      { text: '결제한 금액은 거래가 끝날 때까지 에스크로가 붙들고 있습니다.' },
    ],
    sponsor: [
      { text: '고객이 결제하기를 기다립니다.' },
    ],
  },
  {
    state: 'escrowed',
    title: '계좌 전달 · 원화 송금',
    actor: 'customer',
    customer: [
      { text: "'계좌 정보 전달'로 입금받을 은행·계좌번호·예금주를 보냅니다." },
      { text: '후원자가 원화를 보낼 때까지 기다립니다.' },
    ],
    sponsor: [
      { text: '고객이 보낸 계좌로 주문 금액을 원화 송금합니다.' },
      { text: "송금을 마쳤으면 '원화 송금했어요'를 누릅니다." },
    ],
  },
  {
    state: 'remitted',
    title: '입금 확인',
    actor: 'customer',
    customer: [
      { text: '내 계좌에 원화가 들어왔는지 확인합니다.' },
      { text: "확인했으면 '입금 컨펌'을 누릅니다. 이때 후원자에게 BTC가 지급됩니다." },
    ],
    sponsor: [
      { text: '고객의 입금 확인을 기다립니다.' },
    ],
  },
  {
    state: 'paid',
    title: '완료',
    actor: 'admin',
    customer: [
      { text: '거래가 끝났습니다.' },
    ],
    sponsor: [
      { text: '에스크로가 처음 제출한 인보이스로 BTC를 보냅니다.' },
    ],
  },
] as const;

const STEP_INDEX: ReadonlyMap<OrderState, number> = new Map(
  PROGRESS_STEPS.map((s, i) => [s.state, i]),
);

export interface TerminalInfo {
  state: 'cancelled' | 'sponsor_wins' | 'customer_wins';
  label: string;
  description: string;
}

const TERMINALS: Record<TerminalInfo['state'], Omit<TerminalInfo, 'state'>> = {
  cancelled: {
    label: '취소됨',
    description: '거래가 취소되었습니다. 결제한 금액이 있다면 환불됩니다.',
  },
  sponsor_wins: {
    label: '후원자 승리',
    description: '분쟁 판정 결과 후원자의 송금이 인정되어 BTC가 후원자에게 지급되었습니다.',
  },
  customer_wins: {
    label: '고객 승리',
    description: '분쟁 판정 결과 송금이 확인되지 않아 고객에게 환불되었습니다.',
  },
};

/**
 * 해당 단계에서 실제로 움직여야 하는 쪽.
 *
 * escrowed는 한 상태 안에 두 사람의 차례가 순서대로 들어있다 —
 * 고객이 계좌를 보내야 후원자가 송금할 수 있다.
 */
export function stepActor(state: OrderState, ctx: ProgressContext = {}): StepActor {
  if (state === 'escrowed') return ctx.accountInfoSent ? 'sponsor' : 'customer';
  const idx = STEP_INDEX.get(state);
  return idx === undefined ? 'admin' : PROGRESS_STEPS[idx]!.actor;
}

export interface ResolvedStep {
  index: number;
  state: OrderState;
  title: string;
  status: StepStatus;
  actor: StepActor;
  /** 이 단계에서 내가 움직여야 하는가 */
  isMyTurn: boolean;
  actions: readonly StepAction[];
}

export interface Progress {
  steps: ResolvedStep[];
  /** 현재 단계 인덱스. 이탈 종료면 -1 */
  currentIndex: number;
  /** 정상 경로를 벗어나 끝난 경우에만 채워진다 */
  terminal: TerminalInfo | null;
  /** 전체 단계 수 */
  total: number;
}

/**
 * 주어진 상태를 단계 사다리로 펼친다.
 *
 * 이탈 종료 처리:
 * - sponsor_wins / customer_wins 는 FSM상 remitted에서만 올 수 있으므로
 *   remitted까지는 완료로 확정할 수 있다.
 * - cancelled 는 requested / claimed / verified 어디서든 올 수 있어
 *   어디까지 진행됐는지 알 수 없다. 추측하지 않고 전부 미진행으로 둔다.
 */
export function resolveProgress(
  role: ProgressRole,
  state: OrderState,
  ctx: ProgressContext = {},
): Progress {
  const terminal: TerminalInfo | null =
    state === 'cancelled' || state === 'sponsor_wins' || state === 'customer_wins'
      ? { state, ...TERMINALS[state] }
      : null;

  // 이탈 종료일 때 완료로 볼 수 있는 마지막 단계
  const doneThrough = terminal
    ? terminal.state === 'cancelled'
      ? -1
      : STEP_INDEX.get('remitted')!
    : STEP_INDEX.get(state) ?? -1;

  const currentIndex = terminal ? -1 : doneThrough;

  const steps = PROGRESS_STEPS.map((step, index): ResolvedStep => {
    const status: StepStatus =
      index < doneThrough ? 'done'
      : index === currentIndex ? 'current'
      : terminal && index <= doneThrough ? 'done'
      : 'upcoming';

    const actor = stepActor(step.state, ctx);

    return {
      index,
      state: step.state,
      title: step.title,
      status,
      actor,
      isMyTurn: status === 'current' && actor === role,
      actions: role === 'customer' ? step.customer : step.sponsor,
    };
  });

  return { steps, currentIndex, terminal, total: PROGRESS_STEPS.length };
}
