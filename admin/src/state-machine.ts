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
 * requested → claimed → verified → escrowed → paid
 *                                       ↘ cancelled
 */
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  requested: ['claimed', 'cancelled'],
  claimed: ['verified', 'requested'],
  verified: ['escrowed', 'cancelled'],
  escrowed: ['paid', 'cancelled'],
  paid: [],
  cancelled: [],
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
