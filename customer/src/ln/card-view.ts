/**
 * 라이트닝 의뢰 카드 — 무엇을 보여주고 무엇을 하게 할지 (순수 함수)
 *
 * ── 왜 한 곳인가 (2026-09-24 mainnet 드릴)
 *
 * 같은 의뢰를 탭마다 다른 컴포넌트가 그렸다 — 의뢰하기(표 한 줄), 사주기(오더북 카드), 내 거래·상세
 * (진행도 + 채팅). 그래서 **에스크로 결제는 의뢰하기 탭에서만** 됐고, 보증금은 또 다른 자리에서 됐다.
 * 온체인 트랙은 처음부터 "카드는 목록과 같은 컴포넌트"였다(`OnchainOrderDetail`).
 *
 * 이제 할 일은 **탭이 아니라 데이터로** 정한다 — 역할(pubkey 비교), 공개 오더 상태, 그리고 그 역할만
 * 가진 로컬 기록(고객: 올린 의뢰·보낸 계좌 / 후원자: 보증금 인보이스·받은 계좌·거절 통보). 어느 탭에서
 * 보든 같은 입력이면 같은 카드다.
 */
import {
  canSendAccountInfo, isTerminalState, lnOrderDisplay, summarizeProgress,
  type AccountInfo, type Order, type OrderState, type StateDisplay,
} from '@sajwo-tracker/shared';
import type { CustomerOrder } from '../buyer/types';
import type { SponsorDeposit } from '../sponsor/deposit-store';

export type LnRole = 'customer' | 'sponsor';

export interface LnCardInput {
  orderId: string;
  /** 공개 오더 — 라이브 스토어, 없으면 IDB 사본 */
  order: Order | null;
  /** 내가 올린 의뢰의 로컬 기록 (발행 전 초안은 여기에만 있다) */
  local: CustomerOrder | null;
  myPubkey: string | null;
  /** 후원자: 보증금 인보이스 */
  sponsorDeposit?: SponsorDeposit;
  /** 후원자: 고객이 보낸 계좌 */
  receivedAccount?: AccountInfo;
  /** 후원자: 인보이스 거절 통보 문구 (있으면 다시 내야 한다) */
  invoiceRejection?: string;
  /** 후원자: 어드민이 분쟁 중재로 계좌 공개를 요청했다 */
  revealRequested?: boolean;
  now: number;
}

export type PayPurpose = 'customer-deposit' | 'escrow' | 'sponsor-deposit';

export type LnAction =
  | { kind: 'publish' }
  | { kind: 'pay'; purpose: PayPurpose; bolt11: string }
  | { kind: 'send-account' }
  | { kind: 'confirm-paid' }
  | { kind: 'register-invoice'; notice: string | null }
  | { kind: 'remit'; account: AccountInfo }
  | { kind: 'reveal' };

/** 버튼이 아닌 곳에 두는 것 — 목록 관리와 이탈 */
export interface LnSideActions {
  cancel: boolean;
  /** 로컬 기록 지우기 (초안·종결). 의뢰하기 탭만 쓴다 */
  delete: boolean;
}

export interface LnCardView {
  /** 내 역할. null = 지금은 참여자가 아니다(풀린 클레임) */
  role: LnRole | null;
  /** 오더가 아직 없다(발행 전 · 보증금 대기) */
  draft: boolean;
  state: OrderState | null;
  badge: StateDisplay;
  /** 지금 단계 — 상세의 진행도와 같은 말 */
  title: string;
  isMyTurn: boolean;
  /** 내 차례가 아닐 때 기다리는 쪽 */
  waitingFor: string | null;
  terminal: boolean;
  price: number;
  /** 쿠팡 기한 (0 = 모름) */
  deadline: number;
  closeReason?: string;
  disbursed: boolean;
  /** 지금 할 일 (위에서부터) */
  actions: LnAction[];
  side: LnSideActions;
  /** 상태 안내 한 줄씩 */
  notes: string[];
  /** 진행도 문맥 — 상세의 사다리가 같은 값으로 그린다 */
  progress: { accountInfoSent: boolean; sponsorDepositPending: boolean };
}

const ACTOR_LABEL: Record<string, string> = { customer: '고객', sponsor: '후원자', admin: '에스크로' };

const DRAFT_BADGE = {
  unpublished: { label: '올리기 전', color: '#3730A3', bg: '#E0E7FF' },
  pending: { label: '등록 중', color: '#A16207', bg: '#FEF9C3' },
  deposit: { label: '보증금 대기', color: '#C2410C', bg: '#FFF7ED' },
  dead: { label: '등록 안 됨', color: '#6B7280', bg: '#F3F4F6' },
} satisfies Record<string, StateDisplay>;

const DEPOSIT_STATUS_TEXT = { accepted: '맡김', cancelled: '돌려받음', settled: '몰수됨' } as const;

export function roleOf(order: Order | null, local: CustomerOrder | null, myPubkey: string | null): LnRole | null {
  if (order && myPubkey) {
    if (order.customerPubkey === myPubkey) return 'customer';
    if (order.sponsorPubkey === myPubkey) return 'sponsor';
    return null;
  }
  return local ? 'customer' : null;
}

export function lnCardView(input: LnCardInput): LnCardView {
  const { order, local, now } = input;
  const state = order?.state ?? local?.adminState ?? null;
  if (!state) return draftView(input);

  const role = roleOf(order, local, input.myPubkey);
  const sponsorPubkey = order?.sponsorPubkey ?? local?.sponsorPubkey;
  const deadline = order?.expiration ?? local?.expiration ?? 0;
  const pastDeadline = deadline > 0 && deadline <= now;
  const sponsorDepositPending = state === 'claimed' && !!order?.sponsorDepositPending;
  const accountInfoSent = role === 'customer' ? !!local?.accountInfo : !!input.receivedAccount;
  const progress = { accountInfoSent, sponsorDepositPending };
  const summary = summarizeProgress(role ?? 'sponsor', state, progress);
  const terminal = isTerminalState(state);

  const actions: LnAction[] = [];
  const notes: string[] = [];
  const side: LnSideActions = { cancel: false, delete: false };

  if (role === 'customer') {
    const bolt11 = order?.bolt11 ?? local?.bolt11;
    if (state === 'verified' && bolt11 && !pastDeadline) actions.push({ kind: 'pay', purpose: 'escrow', bolt11 });

    if (canSendAccountInfo(state) && sponsorPubkey) {
      if (local?.accountInfo) notes.push('계좌 정보를 보냈습니다.');
      else if (local?.fixedAccountInfo) notes.push('계좌 정보를 자동으로 보내는 중…');
      // 보낸 기록이 이 기기에 없으면 버튼을 열지 않는다 — 다른 기기에서 이미 보냈다면 두 번째 계좌가 나간다
      else if (local) actions.push({ kind: 'send-account' });
      else notes.push('이 기기에는 의뢰 기록이 없습니다. 계좌 정보는 의뢰를 올린 기기에서 보내세요.');
    }
    if ((canSendAccountInfo(state) && !!local?.accountInfo) || state === 'remitted') actions.push({ kind: 'confirm-paid' });

    side.cancel = state === 'requested' || state === 'claimed' || state === 'verified';
    side.delete = !!local && terminal;
    if (local?.depositBolt11 && local.depositStatus) notes.push(`보증금: ${DEPOSIT_STATUS_TEXT[local.depositStatus]}`);
  }

  if (role === 'sponsor') {
    const dep = input.sponsorDeposit;
    if (state === 'claimed' && !order?.sponsorDepositPaymentHash) {
      if (dep?.bolt11 && !dep.status) actions.push({ kind: 'pay', purpose: 'sponsor-deposit', bolt11: dep.bolt11 });
      else if (sponsorDepositPending) notes.push('보증금 인보이스를 기다리는 중…');
    }
    if (dep?.status) notes.push(`보증금: ${DEPOSIT_STATUS_TEXT[dep.status]}`);

    // 인보이스: escrowed가 제자리. 그 뒤에도 거절 통보가 왔으면 다시 낸다 — 지급 직전 만료(L-5)
    const rejected = input.invoiceRejection ?? null;
    const resubmit = rejected !== null && (
      state === 'invoiced' || state === 'remitted'
      || ((state === 'paid' || state === 'sponsor_wins') && !order?.disbursed)
    );
    if (state === 'escrowed' || resubmit) actions.push({ kind: 'register-invoice', notice: rejected });

    if (state === 'invoiced') {
      if (input.receivedAccount) actions.push({ kind: 'remit', account: input.receivedAccount });
      else notes.push('고객의 계좌 정보를 기다리는 중…');
    }
    if (input.revealRequested && input.receivedAccount) actions.push({ kind: 'reveal' });
  }

  if (role === null && order) notes.push('내 클레임이 풀린 의뢰입니다. 지금은 참여하고 있지 않습니다.');

  return {
    role, draft: false, state,
    badge: lnOrderDisplay({ state, sponsorDepositPending }),
    title: summary.title,
    isMyTurn: role !== null && summary.isMyTurn,
    waitingFor: (role === null || !summary.isMyTurn) && summary.actor ? ACTOR_LABEL[summary.actor] ?? null : null,
    terminal,
    price: order?.price ?? local?.price ?? 0,
    deadline,
    ...(order?.closeReason ?? local?.closeReason ? { closeReason: order?.closeReason ?? local?.closeReason } : {}),
    disbursed: !!order?.disbursed,
    actions, side, notes, progress,
  };
}

/** 오더가 아직 없다 — 내 기기에만 있는 의뢰 */
function draftView(input: LnCardInput): LnCardView {
  const local = input.local;
  const base = {
    role: 'customer' as const, draft: true, state: null, terminal: false,
    price: local?.price ?? 0, deadline: local?.expiration ?? 0, disbursed: false,
    progress: { accountInfoSent: false, sponsorDepositPending: false },
  };
  if (!local) {
    return {
      ...base, role: null, badge: DRAFT_BADGE.dead, title: '의뢰를 찾을 수 없음', isMyTurn: false, waitingFor: null,
      actions: [], side: { cancel: false, delete: false }, notes: [],
    };
  }
  const expired = local.expiration > 0 && local.expiration <= input.now;
  const side = { cancel: false, delete: true };

  if (!local.raw) {
    return {
      ...base, badge: DRAFT_BADGE.unpublished, title: '의뢰 올리기 전', isMyTurn: !expired, waitingFor: null,
      actions: expired ? [] : [{ kind: 'publish' }], side,
      notes: expired ? ['기한이 지나 올릴 수 없습니다.'] : [],
    };
  }
  if (local.depositStatus === 'cancelled' || local.depositStatus === 'settled' || expired) {
    return {
      ...base, badge: DRAFT_BADGE.dead, title: '등록 안 됨', isMyTurn: false, waitingFor: null, actions: [], side,
      notes: [expired ? '기한이 지났습니다.' : '보증금을 제때 내지 않아 의뢰가 등록되지 않았습니다.'],
    };
  }
  if (local.depositBolt11 && !local.depositStatus) {
    return {
      ...base, badge: DRAFT_BADGE.deposit, title: '보증금 결제', isMyTurn: true, waitingFor: null,
      actions: [{ kind: 'pay', purpose: 'customer-deposit', bolt11: local.depositBolt11 }], side,
      notes: ['보증금을 내면 의뢰가 오더북에 올라갑니다.'],
    };
  }
  return {
    ...base, badge: DRAFT_BADGE.pending, title: '등록 확인 중', isMyTurn: false, waitingFor: '에스크로',
    actions: [], side, notes: [],
  };
}
