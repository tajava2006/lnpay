/**
 * Admin 통합 상태 머신 (FSM)
 *
 * 에스크로 거래의 상태 전이를 중앙에서 관리한다.
 * Admin이 유일한 상태 소유자이므로 이 FSM만이 오더 상태를 변경할 수 있다.
 *
 * 단일 탭 SPA + 동기 localStorage이므로 Optimistic Locking 없이 동기 함수로 구현.
 */

import type { OrderState } from '@sajwo-tracker/shared';

/**
 * 허용된 상태 전이 맵
 *
 * requested ⇄ claimed → verified → escrowed ─→ remitted ─→ paid
 *                                     │                ├──→ sponsor_wins
 *                                     └──→ paid        └──→ customer_wins
 *
 * cancelled: requested, claimed, verified에서만 전이 가능
 *   (escrowed 이후는 상대방이 행동할 수 있는 상태이므로 일방 취소 불가)
 *   (remitted는 반드시 분쟁 판정 경로로 종결: paid / sponsor_wins / customer_wins)
 *
 * 터미널: paid, cancelled, sponsor_wins, customer_wins
 */
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  requested: ['claimed', 'cancelled'],
  claimed: ['requested', 'verified', 'cancelled'],
  verified: ['escrowed', 'cancelled'],
  escrowed: ['remitted', 'paid'],
  remitted: ['paid', 'sponsor_wins', 'customer_wins'],
  paid: [],
  cancelled: [],
  sponsor_wins: [],
  customer_wins: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TransitionResult {
  success: boolean;
  error?: TransitionError;
}

export type TransitionError =
  | { type: 'ORDER_NOT_FOUND'; orderId: string }
  | { type: 'INVALID_TRANSITION'; from: OrderState; to: OrderState };
