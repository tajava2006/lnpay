/**
 * 온체인 거래 진행도 (고객·후원자 공용) — PLAN-ONCHAIN-TRACK §6.2 · §9
 *
 * 단계는 FSM의 정상 경로를 그대로 따른다:
 *
 *   listed → bonded → funded → presigned → remitted → settling → released
 *
 * 라이트닝판(`order-progress.ts`)과 **모양을 일부러 맞췄다** — 리뷰할 때 두 트랙을
 * 나란히 놓고 볼 수 있어야 한다. 다른 건 내용뿐이다.
 *
 * ⚠️ `bonded` 한 단계가 **"보내기 + 컨펌"을 둘 다** 덮는다. 멤풀 관측은 상태가
 * 아니라 화면 힌트라서(§4.2) 단계를 쪼갤 이유가 없다 — 판정은 "마감 안에 약정
 * 금액이 N컨펌 됐는가" 하나다. 화면은 그 단계 안에서 "멤풀에서 보임 · 컨펌 대기"를
 * 덧붙이면 된다.
 *
 * ── 문구에 무엇을 넣나
 *
 * **몰수의 조건은 반드시 고지한다**(§6.0). 어떤 마감을 어기면 보증금을 잃는지,
 * 그 마감이 언제인지. 설계의 공정성 자체라서, 모르고 잃으면 안 된다.
 *
 * **환불 시 수수료 2회가 고객 부담이라는 것도 고지한다.** 후원자 과실이어도
 * 고객이 문다. 충당은 운영 재량이므로 "보상받는다"가 아니라 **"보장되지 않는다"**
 * 로 적는다 — 약속으로 읽히면 그 순간 권리가 되고, 못 줄 사정이 생기면 새 분쟁이 된다.
 *
 * **몰수금의 행방은 고지하지 않는다.** 보증금은 "트롤하면 이걸 가져간다"는 뜻이고,
 * 몰수됐다는 건 트롤을 했다는 뜻이다.
 */
import type { OnchainState, SettlementKind } from './state-machine';

export type OnchainRole = 'customer' | 'sponsor';
export type StepStatus = 'done' | 'current' | 'upcoming';

/** 이 단계에서 공을 쥔 쪽. `chain`은 아무도 못 움직이고 컨펌만 기다리는 구간. */
export type OnchainStepActor = OnchainRole | 'admin' | 'chain';

export interface StepAction {
  text: string;
  /** 조건부 항목 (설정·상황에 따라 안 나타날 수 있음) */
  optional?: boolean;
}

export interface OnchainProgressStep {
  state: OnchainState;
  title: string;
  /** 정적 기본값. 실제 주체는 `onchainStepActor()`가 문맥까지 반영해 정한다. */
  actor: OnchainStepActor;
  customer: readonly StepAction[];
  sponsor: readonly StepAction[];
}

export interface OnchainProgressContext {
  /** `presigned`에서 고객이 계좌를 이미 보냈는지 — 공이 후원자로 넘어간다 */
  accountInfoSent?: boolean;
  /** `settling`·`refunding`에서 어느 종결인지 — 문구를 고르는 데 쓴다 */
  settlementKind?: SettlementKind;
}

export const ONCHAIN_PROGRESS_STEPS: readonly OnchainProgressStep[] = [
  {
    state: 'listed',
    title: '후원자 찾는 중',
    actor: 'sponsor',
    customer: [
      { text: '후원자가 나타날 때까지 기다립니다. 알림을 켜두면 붙는 즉시 알려드립니다.' },
      { text: '의뢰는 최대 7일간 오더북에 떠 있습니다. 그 안에 아무도 안 붙으면 취소되고 보증금은 돌려받습니다.' },
      { text: '최저가를 걸어두면 그보다 낮은 시세에서는 체결되지 않습니다.', optional: true },
    ],
    sponsor: [
      { text: "'사줄게'를 누르면 보증금 인보이스가 발행됩니다." },
      { text: '**결제한 분이 가져갑니다.** 여러 명이 동시에 시도해도 되고, 결제 전에는 아무도 이 의뢰를 붙잡지 않습니다.' },
      { text: '받을 비트코인 주소와 희망 수수료율을 이때 함께 등록합니다.' },
    ],
  },
  {
    state: 'bonded',
    title: '고객 펀딩 (컨펌까지)',
    actor: 'customer',
    customer: [
      { text: '화면의 에스크로 주소로 **정확한 수량**을 보냅니다. 금액이 다르면 처리되지 않습니다.' },
      { text: '앱이 그 주소를 내 키로 직접 다시 만들어 대조합니다. **경고가 뜨면 절대 보내지 마세요.**' },
      { text: '**6시간 안에 컨펌까지** 끝나야 합니다. 보내는 것만으로는 부족하니 수수료를 넉넉히 잡으세요.' },
      { text: '늦으면 거래가 취소되고 **보증금을 잃습니다.** 안 잡히면 RBF·CPFP로 수수료를 올릴 수 있습니다.' },
      { text: '펀딩 트랜잭션 수수료는 내 지갑이 정하고 내가 냅니다.' },
    ],
    sponsor: [
      { text: '고객이 펀딩을 컨펌시킬 때까지 기다립니다. 보통 10~60분입니다.' },
      { text: '**컨펌될 때까지 원화를 보내지 마세요.** 멤풀에 보이는 것은 되돌려질 수 있습니다.' },
      { text: '**가격은 아직 정해지지 않았습니다** — 컨펌되는 시점의 시세로 정해집니다.' },
    ],
  },
  {
    state: 'funded',
    title: '가격 확정 · 후원자 서명',
    actor: 'sponsor',
    customer: [
      { text: '컨펌 시점 시세로 받을 원화가 확정됐습니다.' },
      { text: '후원자가 서명할 때까지 기다립니다. 15분이 지나면 환불 경로로 넘어갑니다.' },
    ],
    sponsor: [
      { text: '앱이 펀딩 트랜잭션을 확인하고 **자동으로 사전서명**합니다. 고민할 것은 없습니다.' },
      { text: '**15분 안에** 앱이 깨어나야 합니다. 넘기면 거래가 환불되고 **보증금을 잃습니다.**' },
      { text: '받을 sats = 판매 수량 − 네트워크 수수료입니다. 수수료율은 내가 정했고 내가 부담합니다.' },
    ],
  },
  {
    state: 'presigned',
    title: '계좌 전달 · 원화 송금',
    actor: 'customer',
    customer: [
      { text: "'계좌 정보 전달'로 입금받을 은행·계좌번호·예금주를 보냅니다." },
      { text: '**15분 안에** 보내야 합니다. 넘기면 거래가 취소되고 **보증금을 잃습니다.**' },
      { text: '후원자가 원화를 보낼 때까지 기다립니다(계좌 전달 후 30분).' },
    ],
    sponsor: [
      { text: '계좌가 도착하면 **30분 안에** 원화를 보냅니다. 시계는 계좌가 도착한 시점부터 갑니다.' },
      { text: '**즉시 이체만 사용하세요.** 지연 이체는 시간 안에 도착하지 않아 보증금을 잃습니다.' },
      { text: "송금을 마쳤으면 '원화 송금했어요'를 누릅니다." },
      { text: '계좌를 쓸 수 없으면 증거와 함께 이의를 제기합니다. **마감 시계는 멈추지 않습니다.**' },
    ],
  },
  {
    state: 'remitted',
    title: '입금 확인 · 릴리스 서명',
    actor: 'customer',
    customer: [
      { text: '내 계좌에 원화가 들어왔는지 확인합니다.' },
      { text: '확인했으면 서명합니다. **이때 비트코인이 후원자에게 넘어갑니다.**' },
      { text: '**24시간 안에** 확인도 이의제기도 없으면 분쟁으로 넘어갑니다. 동의를 묻지 않습니다.' },
      { text: '입금이 없으면 서명하지 말고 이의를 제기하세요. 계좌 내역을 준비해 두면 판정이 빨라집니다.' },
    ],
    sponsor: [
      { text: '고객의 확인을 기다립니다.' },
      { text: '고객이 응답하지 않으면 24시간 뒤 자동으로 분쟁이 열립니다. 이체 내역 원본을 준비해 두세요.' },
    ],
  },
  {
    state: 'settling',
    title: '종결 트랜잭션 컨펌',
    actor: 'chain',
    customer: [
      { text: '종결 트랜잭션이 블록에 들어가기를 기다립니다.' },
      { text: '이 단계에서는 되돌릴 수 없습니다. 멤풀에서 사라지면 같은 트랜잭션을 다시 뿌립니다.' },
    ],
    sponsor: [
      { text: '종결 트랜잭션이 블록에 들어가기를 기다립니다.' },
      { text: '수수료가 낮아 안 잡히면 **받을 출력으로 CPFP**해서 올릴 수 있습니다.', optional: true },
    ],
  },
  {
    state: 'released',
    title: '완료',
    actor: 'chain',
    customer: [
      { text: '거래가 끝났습니다.' },
    ],
    sponsor: [
      { text: '비트코인이 등록한 주소로 들어왔습니다.' },
    ],
  },
] as const;

const STEP_INDEX: ReadonlyMap<OnchainState, number> = new Map(
  ONCHAIN_PROGRESS_STEPS.map((s, i) => [s.state, i]),
);

export interface OnchainTerminalInfo {
  state: 'cancelled' | 'refunded' | 'sponsor_wins' | 'customer_wins' | 'swept';
  label: string;
  description: string;
}

const TERMINALS: Record<OnchainTerminalInfo['state'], Omit<OnchainTerminalInfo, 'state'>> = {
  cancelled: {
    label: '취소됨',
    description: '거래가 시작되기 전에 취소되었습니다. 온체인 트랜잭션은 없습니다.',
  },
  refunded: {
    label: '환불됨',
    description:
      '에스크로가 고객에게 돌아갔습니다. 되돌아가는 경로라 온체인 수수료가 두 번(펀딩·환불) '
      + '들었고, 그 부담은 고객 몫입니다. 상대 과실로 환불된 경우 운영자가 보전할 수 있지만 '
      + '보장되지는 않습니다.',
  },
  sponsor_wins: {
    label: '후원자 승리',
    description: '분쟁 판정 결과 후원자의 송금이 인정되어 비트코인이 후원자에게 갔습니다.',
  },
  customer_wins: {
    label: '고객 승리',
    description: '분쟁 판정 결과 송금이 확인되지 않아 에스크로가 고객에게 돌아갔습니다.',
  },
  swept: {
    label: '타임락 회수',
    description:
      '운영자가 응답하지 않아 고객이 타임락으로 직접 회수했습니다. '
      + '양쪽 보증금은 자체 만료로 환불됩니다.',
  },
};

function isTerminalWithInfo(state: OnchainState): state is OnchainTerminalInfo['state'] {
  return state === 'cancelled' || state === 'refunded' || state === 'sponsor_wins'
    || state === 'customer_wins' || state === 'swept';
}

/**
 * 이 단계에서 실제로 움직여야 하는 쪽.
 *
 * `presigned`는 한 상태 안에 두 사람의 차례가 순서대로 들어있다 —
 * 고객이 계좌를 보내야 후원자가 송금할 수 있다(라이트닝의 `invoiced`와 같은 모양).
 */
export function onchainStepActor(
  state: OnchainState,
  ctx: OnchainProgressContext = {},
): OnchainStepActor {
  // 환불이 결정됐다 — `{A,C}`라 어드민 혼자 못 한다(§5.2 R1-M4). 고객이 안 오면 안 끝난다.
  if (state === 'refunding') return 'customer';
  if (state === 'presigned') return ctx.accountInfoSent ? 'sponsor' : 'customer';
  const idx = STEP_INDEX.get(state);
  return idx === undefined ? 'admin' : ONCHAIN_PROGRESS_STEPS[idx]!.actor;
}

export interface ResolvedOnchainStep {
  index: number;
  state: OnchainState;
  title: string;
  status: StepStatus;
  actor: OnchainStepActor;
  /** 이 단계에서 내가 움직여야 하는가 */
  isMyTurn: boolean;
  actions: readonly StepAction[];
}

export interface OnchainProgress {
  steps: ResolvedOnchainStep[];
  /** 현재 단계 인덱스. 사다리 밖(분쟁·이탈 종료)이면 -1 */
  currentIndex: number;
  /** 정상 경로를 벗어나 끝난 경우에만 채워진다 */
  terminal: OnchainTerminalInfo | null;
  /** 분쟁 중 — 종결은 아니지만 사다리도 멈춘다. 어드민 판정을 기다린다 */
  disputed: boolean;
  /** 환불이 결정됐다 — 거래는 끝났고 고객의 환불 서명을 기다린다 */
  refunding: OnchainRefundingInfo | null;
  total: number;
}

export interface OnchainRefundingInfo {
  label: string;
  description: string;
}

/**
 * 환불 사유별 안내. **몰수의 조건은 반드시 고지한다**(§6.0) — 그런데 몰수금의
 * 행방과 보상은 약속하지 않는다.
 */
function refundingInfo(role: OnchainRole, kind: SettlementKind | undefined): OnchainRefundingInfo {
  const why: Partial<Record<SettlementKind, string>> = {
    'refund:reserve': '컨펌 시점 시세가 최저가보다 낮아 거래가 성립하지 않았습니다. 양쪽 보증금은 돌려받습니다.',
    'refund:bond-expired': '후원자 보증금이 먼저 만료돼 거래를 이어갈 수 없었습니다.',
    'refund:sponsor-timeout': '후원자가 마감 안에 서명이나 원화 송금을 마치지 않았습니다. 후원자 보증금은 몰수됐습니다.',
    'refund:customer-late': '고객이 마감 안에 계좌를 보내지 않았습니다. 고객 보증금은 몰수됐습니다.',
    'refund:account-disputed': '후원자가 계좌를 쓸 수 없다고 이의를 냈습니다. 누구 과실인지 운영자가 판정하고, 그때 보증금이 처리됩니다.',
  };
  const reason = (kind && why[kind]) ?? '마감을 넘겨 거래가 환불로 넘어갔습니다.';
  return {
    label: '환불 진행 중',
    description: role === 'customer'
      ? `${reason} 에스크로를 돌려받으려면 환불 서명이 필요합니다 — 운영자 혼자서는 환불할 수 없습니다. `
        + '되돌아가는 경로라 온체인 수수료는 두 번(펀딩·환불) 들고, 그 부담은 고객 몫입니다.'
      : `${reason} 원화를 보내지 마세요. 이 거래는 더 진행되지 않습니다.`,
  };
}

/**
 * 상태를 단계 사다리로 펼친다.
 *
 * 이탈 종료 처리 — **모르면 추측하지 않는다.** 안 일어난 단계를 완료로 그리면
 * 화면이 거짓말을 한다.
 *
 * - `sponsor_wins`/`customer_wins`는 FSM상 `remitted` 유래 분쟁에서만 오므로
 *   `remitted`까지는 완료로 확정할 수 있다.
 * - `refunded`는 `refunding`을 거쳐서만 온다(`bonded`에서 접은 경우 포함). 다만
 *   **펀딩은 확실히 컨펌됐다**(환불 tx가 에스크로를 소모하므로) → `bonded`까지 완료.
 * - `cancelled`는 펀딩이 컨펌되기 전이라 아무것도 확정할 수 없다 → 전부 미진행.
 * - `swept`도 펀딩 컨펌 이후 어느 상태에서든 관측될 수 있다 → `bonded`까지 완료.
 */
export function resolveOnchainProgress(
  role: OnchainRole,
  state: OnchainState,
  ctx: OnchainProgressContext = {},
): OnchainProgress {
  const terminal: OnchainTerminalInfo | null = isTerminalWithInfo(state)
    ? { state, ...TERMINALS[state] }
    : null;

  const disputed = state === 'disputed';
  const refunding = state === 'refunding' ? refundingInfo(role, ctx.settlementKind) : null;

  // 환불은 에스크로를 소모하므로 펀딩 컨펌까지는 확실하다(`bonded`에서 접은 경우 포함).
  const doneThrough = terminal
    ? terminalDoneThrough(terminal.state)
    : disputed
      ? STEP_INDEX.get('remitted')!
      : refunding
        ? STEP_INDEX.get('bonded')!
        : STEP_INDEX.get(state) ?? -1;

  const offLadder = Boolean(terminal || disputed || refunding);
  const currentIndex = offLadder ? -1 : doneThrough;

  const steps = ONCHAIN_PROGRESS_STEPS.map((step, index): ResolvedOnchainStep => {
    const status: StepStatus =
      index < doneThrough ? 'done'
      : index === currentIndex ? 'current'
      : offLadder && index <= doneThrough ? 'done'
      : 'upcoming';

    const actor = onchainStepActor(step.state, ctx);

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

  return { steps, currentIndex, terminal, disputed, refunding, total: ONCHAIN_PROGRESS_STEPS.length };
}

function terminalDoneThrough(state: OnchainTerminalInfo['state']): number {
  switch (state) {
    // 펀딩 전 취소 — 어디서 끊겼는지 알 수 없다
    case 'cancelled': return -1;
    // 에스크로를 소모하는 종결이므로 펀딩 컨펌까지는 확실하다
    case 'refunded':
    case 'swept': return STEP_INDEX.get('bonded')!;
    // 분쟁 판정은 remitted 유래다
    case 'sponsor_wins':
    case 'customer_wins': return STEP_INDEX.get('remitted')!;
  }
}
