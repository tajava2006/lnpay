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
      { text: '후원자가 의뢰를 가져갈 때까지 기다립니다.' },
    ],
    sponsor: [
      { text: "'사줄게'를 누르면 이 의뢰를 맡게 됩니다. 먼저 누른 분에게 배정됩니다." },
      { text: 'BTC 받을 인보이스는 지금이 아니라, 고객이 결제를 마친 뒤에 등록합니다.' },
      { text: '장난 의뢰를 막기 위해 보증금이 요구될 수 있습니다. 지금은 보증금 없이 운영 중입니다.', optional: true },
    ],
  },
  {
    state: 'claimed',
    title: '후원자 확정',
    actor: 'admin',
    customer: [
      { text: '어드민이 거래 금액을 확정합니다. 기다리면 됩니다.' },
    ],
    sponsor: [
      { text: '어드민이 거래 금액을 확정할 때까지 기다립니다. 보통 몇 초면 끝납니다.' },
    ],
  },
  {
    state: 'verified',
    title: '고객 결제',
    actor: 'customer',
    customer: [
      { text: "'결제하기'를 눌러 Lightning 인보이스를 결제합니다." },
      { text: '결제한 BTC는 거래가 끝날 때까지 어드민이 맡아둡니다. 원화가 오지 않으면 돌려받습니다.' },
      { text: '지갑에서 "대기 중"으로 남아 있는 것이 정상입니다. 다시 보내지 마세요.' },
    ],
    sponsor: [
      { text: '고객이 어드민에게 에스크로 금액을 맡길 때까지 기다리세요.' },
    ],
  },
  {
    state: 'escrowed',
    title: '후원자 인보이스 등록',
    actor: 'sponsor',
    customer: [
      { text: '후원자가 BTC 받을 인보이스를 등록하기를 기다립니다.' },
      { text: '등록되면 계좌 정보를 보낼 수 있게 됩니다.' },
    ],
    sponsor: [
      { text: '화면에 표시된 금액 그대로 인보이스를 만들어 등록합니다.' },
      { text: '등록해야 고객의 계좌 정보를 받을 수 있습니다. 그 전에는 원화를 보내지 마세요.' },
    ],
  },
  {
    state: 'invoiced',
    title: '계좌 전달 · 원화 송금',
    actor: 'customer',
    customer: [
      { text: "'계좌 정보 전달'로 입금받을 은행·계좌번호·예금주를 보냅니다." },
      { text: '후원자가 원화를 보낼 때까지 기다립니다.' },
    ],
    sponsor: [
      { text: '고객이 보낸 계좌로 의뢰 금액을 원화 송금합니다.' },
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
      { text: '등록한 인보이스로 어드민이 BTC를 보내줍니다.' },
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
  // escrowed는 후원자 차례다(인보이스 등록). 계좌 발행은 invoiced부터라
  // accountInfoSent 분기도 그쪽으로 옮겼다.
  if (state === 'invoiced') return ctx.accountInfoSent ? 'sponsor' : 'customer';
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

/**
 * 계좌 정보를 발행해도 되는 상태인가.
 *
 * **후원자 보호의 핵심 게이트다** (불변조건 I-009). 후원자의 되돌릴 수 없는
 * 행동은 원화 이체이고 그건 계좌번호를 본 직후에 일어난다. 그래서 "받을 준비가
 * 됐음"(= 인보이스 등록 완료)이 확인되기 전에는 계좌가 **릴레이에 존재하지도
 * 않아야** 한다. 가리는 게 아니라 발행하지 않는 것이다.
 *
 * 고객 앱에는 발행 경로가 둘(수동 입력·파싱 주문 자동 전송)이라 판정을 한 곳에
 * 두고 양쪽이 같이 쓴다. 한쪽만 막으면 게이트가 없는 것과 같다.
 */
export function canSendAccountInfo(state: OrderState | undefined): boolean {
  // undefined는 "아직 모른다"이고, 모르면 보내지 않는다.
  // 인자를 필수로 두면 호출부마다 `?? 'requested'` 같은 임시방편이 붙는데,
  // 그 임시방편이 어느 날 `?? 'invoiced'`가 되면 게이트가 사라진다.
  return state === 'invoiced' || state === 'remitted';
}

/**
 * 파싱된 쿠팡 주문을 이 의뢰에 붙여도 되는가.
 *
 * 기준은 하나다 — **계좌가 아직 안 나갔는가.** 나간 뒤에 바꾸면 후원자가 이미
 * 본 계좌와 달라져, 원화가 엉뚱한 곳으로 가거나 입금이 확인되지 않는다.
 *
 * `invoiced`까지 열어두는 이유: 거기가 계좌가 실제로 필요해지는 시점이고,
 * 이 기능이 제일 쓸모 있는 자리이기도 하다(후원자가 붙은 걸 보고 그제야
 * 쿠팡에 주문을 넣는 흐름).
 */
export function canAttachParsedOrder(
  state: OrderState | undefined,
  alreadySentAccountInfo: boolean,
): boolean {
  if (alreadySentAccountInfo) return false;
  return state === 'requested' || state === 'claimed'
    || state === 'verified' || state === 'escrowed' || state === 'invoiced';
}
