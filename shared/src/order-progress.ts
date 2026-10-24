/**
 * 거래 진행도 모델 (고객·후원자 공용)
 *
 * 단계는 Admin FSM의 정상 경로를 그대로 따른다:
 *
 *   requested → claimed → verified → escrowed → remitted → paid
 *
 * 주문 등록(오더 발행 전) 구간은 여기 없다. 고객 클라이언트에만 존재하는
 * 상태라 후원자 쪽에서는 의미가 없고, 상세 화면 자체가 Admin 오더가 생긴
 * 뒤에야 열린다.
 *
 * 이탈 종료(cancelled / sponsor_wins / customer_wins)는 선형 사다리를 깨므로
 * 단계로 넣지 않고 terminal로 따로 돌려준다.
 *
 * **후원자 보증금을 기다리는 `claimed`는 아직 "후원자 찾는 중"이다** (2026-09-24 mainnet 드릴).
 * 상태는 claimed지만 보증금을 안 내면 클레임이 풀려 다른 후원자에게 간다 — 확정이 아니다.
 * 그래서 오더의 `sponsorDepositPending`이 있으면 사다리를 한 칸 앞에 세운다.
 *
 * **지정 거래는 보증금이 없고 지정된 사람만 맡는다**(LN-TRACK §7). 보증금·"먼저 누른 분" 줄은 `designated`에 지정
 * 거래용 문구를 두고(`null`이면 뺀다), 문맥(`designated`)이 켜져 있으면 그걸 쓴다 — 온체인 `progress.ts`와 같은 방식.
 */
import type { OrderState } from './constants';
import { BUTTON, STEP_TEXT } from './copy';

export type ProgressRole = 'customer' | 'sponsor';
export type StepStatus = 'done' | 'current' | 'upcoming';

/** 이 단계에서 공을 쥔 쪽. 'admin'은 양쪽 다 기다리는 구간. */
export type StepActor = ProgressRole | 'admin';

export interface StepAction {
  text: string;
  /**
   * 지정 거래에서 대신 쓸 문구 — `null`이면 지정 거래에선 뺀다. 없으면 같은 문구.
   *
   * 공개 거래의 보증금은 **항상 있다**(2026-10-22 운영 결정 — 유저가 없을 때도 트롤이 찜하고 거래를 깼다). 예전의 "요구될
   * 수 있음" 조건부 표시는 없앴다. 보증금이 없는 건 지정 거래뿐이고 그건 이 칸이 맡는다.
   */
  designated?: string | null;
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
  /** claimed인데 후원자 보증금이 아직이다 — 사다리는 "후원자 찾는 중"에 선다 */
  sponsorDepositPending?: boolean;
  /** 지정 거래 — 보증금이 없고 지정된 사람만 맡는다 */
  designated?: boolean;
}

export const PROGRESS_STEPS: readonly ProgressStep[] = [
  {
    state: 'requested',
    title: '사는 사람 찾는 중',
    actor: 'sponsor',
    customer: [
      { text: '사는 사람이 붙을 때까지 기다립니다.', designated: '지정한 상대가 수락할 때까지 기다립니다.' },
      {
        text: '사는 사람이 보증금을 내야 확정됩니다. 제한 시간 안에 안 내면 다른 사람을 다시 기다립니다.',
        designated: null,
      },
    ],
    sponsor: [
      {
        text: "'사기'를 누르면 이 판매가 나에게 배정됩니다. 먼저 누른 분에게 갑니다.",
        designated: "'수락'을 누르면 이 판매가 나에게 배정됩니다. 나를 지정한 판매라 다른 사람은 살 수 없습니다.",
      },
      {
        text: '보증금을 결제해야 배정이 확정됩니다. 제한 시간 안에 안 내면 다른 사람에게 넘어갑니다(낸 게 없으니 잃는 것도 '
          + '없습니다). 보증금은 거래 방해를 막기 위한 것이라, 받을 인보이스를 등록하지 않고 떠나거나 분쟁에서 지지 않는 한 '
          + '수수료 포함 전액 돌아옵니다.',
        designated: null,
      },
      { text: 'BTC 받을 인보이스는 지금이 아니라, 파는 사람이 에스크로 결제를 마친 뒤에 등록합니다.' },
    ],
  },
  {
    state: 'claimed',
    title: '사는 사람 확정',
    actor: 'admin',
    customer: [
      { text: '에스크로가 지금 시세로 거래 금액을 확정합니다. 보통 몇 초면 끝납니다.' },
    ],
    sponsor: [
      { text: '에스크로가 지금 시세로 거래 금액을 확정합니다. 보통 몇 초면 끝납니다.' },
    ],
  },
  {
    state: 'verified',
    title: '에스크로 결제',
    actor: 'customer',
    customer: [
      { text: "'결제하기'를 눌러 Lightning 인보이스를 결제합니다." },
      { text: '결제한 BTC는 거래가 끝날 때까지 에스크로가 맡아둡니다. 원화가 오지 않으면 수수료 포함 전액 돌려받습니다.' },
      { text: '지갑에서 "대기 중"으로 남아 있는 것이 정상입니다. 다시 보내지 마세요.' },
    ],
    sponsor: [
      { text: '파는 사람이 에스크로 결제를 마칠 때까지 기다립니다.' },
    ],
  },
  {
    state: 'escrowed',
    title: '사는 사람 인보이스 등록',
    actor: 'sponsor',
    customer: [
      { text: '사는 사람이 BTC 받을 인보이스를 등록하기를 기다립니다.' },
      { text: '등록되면 계좌 정보를 보낼 수 있게 됩니다.' },
    ],
    sponsor: [
      { text: '화면에 표시된 금액 그대로 인보이스를 만들어 등록합니다.' },
      { text: '등록해야 파는 사람의 계좌 정보를 받을 수 있습니다. 그 전에는 원화를 보내지 마세요.' },
    ],
  },
  {
    state: 'invoiced',
    title: '계좌 전달 · 원화 송금',
    actor: 'customer',
    customer: [
      { text: STEP_TEXT.sendAccount },
      { text: '사는 사람이 원화를 보낼 때까지 기다립니다.' },
    ],
    sponsor: [
      { text: '파는 사람이 보낸 계좌로 거래 금액을 원화 송금합니다.' },
      { text: STEP_TEXT.pressRemitted },
    ],
  },
  {
    state: 'remitted',
    title: '입금 확인',
    actor: 'customer',
    customer: [
      { text: STEP_TEXT.checkDeposit },
      { text: `확인했으면 '${BUTTON.confirmPaid}'을 누릅니다. 이때 사는 사람에게 BTC가 지급됩니다.` },
    ],
    sponsor: [
      { text: '파는 사람의 입금 확인을 기다립니다.' },
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
      { text: '등록한 인보이스로 BTC가 지급됩니다.' },
    ],
  },
] as const;

const STEP_INDEX: ReadonlyMap<OrderState, number> = new Map(
  PROGRESS_STEPS.map((s, i) => [s.state, i]),
);

export interface TerminalInfo {
  state: 'cancelled' | 'sponsor_wins' | 'customer_wins' | 'admin_closed' | 'expired';
  label: string;
  description: string;
}

const TERMINALS: Record<TerminalInfo['state'], Omit<TerminalInfo, 'state'>> = {
  // 취소·만료는 누구 잘못으로 닫혔느냐에 따라 보증금이 다르다(`outcomes.ts`) — "전부 환불"이라고 하면 몰수된 쪽에 거짓말이다.
  // 사유는 카드의 "종료 사유" 줄이 말한다
  cancelled: {
    label: '취소됨',
    description: '거래가 취소되었습니다. 에스크로로 결제한 BTC는 수수료 포함 전액 돌려받습니다. 보증금은 내 쪽 잘못으로 '
      + '닫힌 경우가 아니면 전액 돌아옵니다 — 카드의 종료 사유를 확인하세요.',
  },
  sponsor_wins: {
    label: '판정: 송금 인정',
    description: '분쟁 판정 결과 사는 사람의 송금이 인정되어 BTC가 사는 사람에게 지급되었습니다.',
  },
  customer_wins: {
    label: '판정: 송금 불인정',
    description: '분쟁 판정 결과 송금이 확인되지 않아 파는 사람에게 환불되었습니다.',
  },
  admin_closed: {
    label: '강제 종결',
    description: '거래가 오래 멈춰 있어 에스크로가 정리했습니다. 결제한 금액은 환불됩니다.',
  },
  expired: {
    label: '기한 만료',
    description: '입금 기한이 지나 거래가 끝났습니다. 에스크로로 결제한 BTC는 수수료 포함 전액 돌려받습니다. 보증금은 내 쪽 '
      + '잘못으로 닫힌 경우가 아니면 전액 돌아옵니다 — 카드의 종료 사유를 확인하세요.',
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

/** 사다리에서 설 자리 — 보증금을 기다리는 클레임은 아직 확정이 아니다 */
function ladderState(state: OrderState, ctx: ProgressContext): OrderState {
  return state === 'claimed' && ctx.sponsorDepositPending ? 'requested' : state;
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
    state === 'cancelled' || state === 'sponsor_wins'
    || state === 'customer_wins' || state === 'admin_closed' || state === 'expired'
      ? { state, ...TERMINALS[state] }
      : null;

  // 이탈 종료일 때 완료로 볼 수 있는 마지막 단계.
  //
  // 분쟁 판정(sponsor_wins/customer_wins)은 FSM상 remitted에서만 오므로 거기까지
  // 확정적으로 완료다. 반면 **취소와 강제 종결은 어디서 끊겼는지 알 수 없다** —
  // 강제 종결은 escrowed일 수도 invoiced일 수도 있고, 상태만으로는 구분되지 않는다.
  // 모르면 추측하지 않는다. 안 일어난 단계를 완료로 그리면 화면이 거짓말을 한다.
  const doneThrough = terminal
    ? (terminal.state === 'cancelled' || terminal.state === 'admin_closed' || terminal.state === 'expired')
      ? -1
      : STEP_INDEX.get('remitted')!
    : STEP_INDEX.get(ladderState(state, ctx)) ?? -1;

  const currentIndex = terminal ? -1 : doneThrough;

  const steps = PROGRESS_STEPS.map((step, index): ResolvedStep => {
    const status: StepStatus =
      index < doneThrough ? 'done'
      : index === currentIndex ? 'current'
      : terminal && index <= doneThrough ? 'done'
      : 'upcoming';

    const actor = stepActor(step.state, ctx);
    const actions = (role === 'customer' ? step.customer : step.sponsor)
      .filter(a => !(ctx.designated && a.designated === null))
      .map(a => (ctx.designated && typeof a.designated === 'string' ? { ...a, text: a.designated } : a));

    return {
      index,
      state: step.state,
      title: step.title,
      status,
      actor,
      isMyTurn: status === 'current' && actor === role,
      actions,
    };
  });

  return { steps, currentIndex, terminal, total: PROGRESS_STEPS.length };
}

/** 목록 카드 한 줄 — 지금 어느 단계이고 누구 차례인가. 상세의 사다리와 같은 말을 쓴다 */
export interface ProgressSummary {
  title: string;
  terminal: boolean;
  isMyTurn: boolean;
  /** 지금 움직여야 하는 쪽. 종결이면 null */
  actor: StepActor | null;
}

export function summarizeProgress(
  role: ProgressRole,
  state: OrderState,
  ctx: ProgressContext = {},
): ProgressSummary {
  const { steps, currentIndex, terminal } = resolveProgress(role, state, ctx);
  if (terminal) return { title: terminal.label, terminal: true, isMyTurn: false, actor: null };
  const step = steps[currentIndex];
  if (!step) return { title: state, terminal: false, isMyTurn: false, actor: null };
  return { title: step.title, terminal: false, isMyTurn: step.isMyTurn, actor: step.actor };
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
