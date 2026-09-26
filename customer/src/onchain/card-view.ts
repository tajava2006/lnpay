/**
 * 온체인 거래 카드에 무엇을 띄울지 — 역할·상태·시각으로 정한다 (라이트닝 `ln/card-view.ts`와 같은 자리)
 *
 * 카드(`components/OnchainOrderCard.tsx`)는 이걸 그리기만 한다. 판단을 여기 모아 표로 테스트한다 — 이 트랙에선
 * 버튼 하나가 엉뚱한 때 열리는 게 곧 돈 문제다(늦은 계좌·늦은 송금은 어드민도 안 받아 원화만 헛되이 나간다).
 */
import {
  accountDeadlineOf, canActOnSignRequest, isPast, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import type { SignRequest } from './sign-request-store';

export type OnchainRole = 'customer' | 'sponsor';

export interface OnchainCardView {
  /**
   * 지금 서명할 수 있는 요청. ⚠️ 저장소에 있다는 것만으로 띄우면 안 된다 — 요청 이벤트는 릴레이에 남아
   * 새로고침마다 다시 배달되므로 로컬에서 지워도 되살아난다. 진실은 FSM이다.
   */
  actionable: SignRequest[];
  /** 에스크로 채팅 — 계좌가 나간 뒤부터 분쟁까지 */
  chatOpen: boolean;
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
    chatOpen: (state === 'presigned' && order.accountSentAt !== undefined)
      || state === 'remitted' || state === 'disputed'
      || (state === 'refunding' && order.settlementKind === 'refund:account-disputed'),
    cancel: customer && state === 'listed',
    escrowAddress: customer && state === 'bonded',
    presignStatus: sponsor && state === 'funded' && !order.settlementKind,
    account: owesAccount ? (isPast(accountDeadlineOf(order), now) ? 'late' : 'form') : null,
    remit: sponsor && state === 'presigned',
  };
}
