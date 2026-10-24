/**
 * 온체인 거래 카드에 무엇을 띄울지 — 역할·상태·시각으로 정한다 (라이트닝 `ln/card-view.ts`와 같은 자리)
 *
 * 카드(`components/OnchainOrderCard.tsx`)는 이걸 그리기만 한다. 판단을 여기 모아 표로 테스트한다 — 이 트랙에선
 * 버튼 하나가 엉뚱한 때 열리는 게 곧 돈 문제다(늦은 계좌·늦은 송금은 어드민도 안 받아 원화만 헛되이 나간다).
 */
import { checkCode } from '@sajwo-tracker/shared';
import {
  accountDeadlineOf, canActOnSignRequest, isOnchainTerminal, isPast, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import type { SignRequest } from './sign-request-store';

export type OnchainRole = 'customer' | 'sponsor';

export interface OnchainCardView {
  /**
   * 지금 서명할 수 있는 요청. ⚠️ 저장소에 있다는 것만으로 띄우면 안 된다 — 요청 이벤트는 릴레이에 남아
   * 새로고침마다 다시 배달되므로 로컬에서 지워도 되살아난다. 진실은 FSM이다.
   */
  actionable: SignRequest[];
  /** 정식 분쟁 중(이의 · 확인 마감 초과 · 계좌 이의) — 상세의 "운영자 부르기"를 눈에 띄게 둔다 */
  disputeOpen: boolean;
  /** 상대방 채팅 — 사는 사람이 붙은 뒤(보증금을 낸 `bonded`부터, 지정 거래는 수락부터). 끝난 거래는 읽기만 */
  peer: { pubkey: string; readOnly: boolean } | null;
  /** 고객: 의뢰 내리기 — 후원자가 붙기 전에만 */
  cancel: boolean;
  /** 고객: 입금할 에스크로 주소 */
  escrowAddress: boolean;
  /** 후원자: 사전서명 진행 */
  presignStatus: boolean;
  /** 고객: 계좌 공개 — 폼 · 마감 지남 · 해당 없음 */
  account: 'form' | 'late' | null;
  /** 후원자: 원화 송금 */
  remit: boolean;
  /**
   * 지정 거래면 상대의 확인 코드 — 고객에게만 지정 후원자의 것(만들 때 대조한 그 코드). 후원자는 대조할 일이 없어 빈 코드.
   * 공개 거래는 null
   */
  designated: { counterpartyCode: string } | null;
}

/** 정식 분쟁 중인가 — 상세의 대화(`chat/TradeChat`)가 같은 판단을 쓴다 */
export function isOnchainDisputeOpen(order: OnchainOrder): boolean {
  return order.state === 'disputed' || (order.state === 'refunding' && order.settlementKind === 'refund:account-disputed');
}

/** 상대방 채팅 — 사는 사람이 정해졌으면(오더북에서 내려온 뒤) 반대쪽과 */
export function onchainPeerChat(order: OnchainOrder, role: OnchainRole): OnchainCardView['peer'] {
  if (order.state === 'listed' || !order.sponsorPubkey) return null;
  return { pubkey: role === 'customer' ? order.sponsorPubkey : order.customerPubkey, readOnly: isOnchainTerminal(order.state) };
}

/** `now`는 초 */
export function onchainCardView(
  order: OnchainOrder, role: OnchainRole, now: number, signRequests: readonly SignRequest[],
): OnchainCardView {
  const { state } = order;
  const customer = role === 'customer';
  const sponsor = role === 'sponsor';
  const owesAccount = customer && state === 'presigned' && !order.accountSentAt;
  return {
    actionable: signRequests.filter(r => canActOnSignRequest(state, r.purpose, order.settlementKind)),
    disputeOpen: isOnchainDisputeOpen(order),
    peer: onchainPeerChat(order, role),
    cancel: customer && state === 'listed',
    escrowAddress: customer && state === 'bonded',
    presignStatus: sponsor && state === 'funded' && !order.settlementKind,
    account: owesAccount ? (isPast(accountDeadlineOf(order), now) ? 'late' : 'form') : null,
    remit: sponsor && state === 'presigned',
    designated: order.designatedSponsor
      ? { counterpartyCode: customer ? checkCode(order.designatedSponsor) : '' }
      : null,
  };
}
