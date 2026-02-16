/**
 * 주문 상태 머신 (State Machine)
 *
 * 상태 전이의 유효성 검사와 중앙 관리.
 *
 * 후원자앱은 단일 탭 SPA + 동기 localStorage이므로
 * JS 이벤트 루프 특성상 경쟁 상태가 구조적으로 발생하지 않는다.
 * → Optimistic Locking(version/retry) 없이 동기 함수로 구현.
 */

import {
  type SponsorOrderStatus,
  type TransitionResult,
  SPONSOR_TRANSITIONS,
} from './types';
import { getSnapshot, _mutateOrder } from './order-store';

/**
 * 상태 전이가 허용되는지 확인
 */
export function canTransition(from: SponsorOrderStatus, to: SponsorOrderStatus): boolean {
  return SPONSOR_TRANSITIONS[from].includes(to);
}

/**
 * 주문 상태 전이 실행
 *
 * 1. 스토어에서 주문 조회
 * 2. 전이 유효성 검사 (SPONSOR_TRANSITIONS)
 * 3. 상태 변경 + 저장 + 리스너 통지
 */
export function transitionOrder(
  orderId: string,
  toStatus: SponsorOrderStatus,
): TransitionResult {
  const orders = getSnapshot();
  const order = orders[orderId];

  if (!order) {
    return {
      success: false,
      error: { type: 'ORDER_NOT_FOUND', orderId },
    };
  }

  if (!canTransition(order.status, toStatus)) {
    return {
      success: false,
      error: {
        type: 'INVALID_TRANSITION',
        from: order.status,
        to: toStatus,
      },
    };
  }

  const updated = _mutateOrder(orderId, (o) => ({ ...o, status: toStatus }));

  // _mutateOrder는 주문이 없을 때만 null을 반환하는데, 위에서 이미 확인했으므로 도달 불가
  return {
    success: true,
    order: updated!,
  };
}
