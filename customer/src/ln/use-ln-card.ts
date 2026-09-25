/**
 * 카드 하나가 보는 저장소를 모은다 — 어느 탭에서 불러도 같은 입력
 *
 * 공개 오더는 오더북 스토어(모든 30402)가 진실이고, 보존이 끝나 거기서 빠진 건 부르는 쪽이 IDB 사본을
 * `archived`로 넘긴다. 역할별 로컬 기록(고객 의뢰, 후원자 보증금·계좌·거절·공개 요청)은 역할과 상관없이
 * 다 읽어 `lnCardView`에 넘긴다 — 무엇을 쓸지는 거기서 역할로 정한다.
 */
import { useSyncExternalStore } from 'react';
import { useNow, type Order } from '@sajwo-tracker/shared';
import { useMyPubkey } from '../hooks';
import { subscribe as subscribeLocal, getSnapshot as getLocalSnapshot } from '../buyer/order-store';
import type { CustomerOrder } from '../buyer/types';
import { subscribe as subscribeOrders, getSnapshot as getOrderSnapshot } from '../sponsor/order-store';
import { subscribe as subscribeDeposits, getSnapshot as getDepositSnapshot } from '../sponsor/deposit-store';
import { subscribeAccountInfo, getAccountInfoSnapshot } from '../sponsor/account-store';
import { subscribeClaimErrors, getClaimErrorSnapshot, rejectReasonText } from '../sponsor/claim-error-store';
import { subscribeRevealRequests, getRevealRequestSnapshot } from '../sponsor/reveal-request-store';
import { lnCardView, type LnCardView } from './card-view';

export interface LnCardData {
  view: LnCardView;
  order: Order | null;
  local: CustomerOrder | null;
  myPubkey: string | null;
  /** 이 카드가 판단에 쓴 지금 (초) */
  now: number;
}

export function useLnCard(orderId: string, archived?: Order | null): LnCardData {
  const live = useSyncExternalStore(subscribeOrders, getOrderSnapshot)[orderId];
  const local = useSyncExternalStore(subscribeLocal, getLocalSnapshot)[orderId] ?? null;
  const deposit = useSyncExternalStore(subscribeDeposits, getDepositSnapshot)[orderId];
  const account = useSyncExternalStore(subscribeAccountInfo, getAccountInfoSnapshot)[orderId];
  const claimError = useSyncExternalStore(subscribeClaimErrors, getClaimErrorSnapshot)[orderId];
  const revealRequested = useSyncExternalStore(subscribeRevealRequests, getRevealRequestSnapshot)[orderId] !== undefined;
  const myPubkey = useMyPubkey();
  const now = useNow();

  const order = live ?? archived ?? null;
  const view = lnCardView({
    orderId, order, local, myPubkey, now,
    ...(deposit ? { sponsorDeposit: deposit } : {}),
    ...(account ? { receivedAccount: account } : {}),
    ...(claimError ? { invoiceRejection: rejectReasonText(claimError) } : {}),
    revealRequested,
  });
  return { view, order, local, myPubkey, now };
}
