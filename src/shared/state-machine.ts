/**
 * 주문 상태 머신 (State Machine)
 *
 * 상태 전이의 유효성 검사, Optimistic Locking, 레이스 컨디션 방지
 */

import {
  type OrderStatus,
  type TrackedOrder,
  type TransitionResult,
  type TransitionError,
  ALLOWED_TRANSITIONS,
} from './types';
import { getAllOrders, setAllOrders } from './storage';

/**
 * 상태 전이가 허용되는지 확인
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 상태 전이 옵션
 */
export interface TransitionOptions {
  /** claim 시 claimer ID (requested → claimed 전이 시 필수) */
  claimerId?: string;
  /** 강제 전이 (유효성 검사 무시, 위험!) */
  force?: boolean;
}

/**
 * 주문 상태 전이 실행
 *
 * Optimistic Locking:
 * - expectedVersion과 실제 버전이 다르면 실패
 * - 동시에 여러 요청이 들어와도 하나만 성공
 *
 * @param orderId 주문 ID
 * @param toStatus 전이할 상태
 * @param expectedVersion 예상 버전 (현재 주문의 version 값)
 * @param options 전이 옵션
 */
export async function transitionOrder(
  orderId: string,
  toStatus: OrderStatus,
  expectedVersion: number,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  // 1. 현재 저장된 모든 주문 조회
  const orders = await getAllOrders();
  const order = orders[orderId];

  // 2. 주문 존재 확인
  if (!order) {
    return {
      success: false,
      error: { type: 'ORDER_NOT_FOUND', orderId },
    };
  }

  // 3. 버전 확인 (Optimistic Locking)
  if (order.version !== expectedVersion) {
    return {
      success: false,
      error: {
        type: 'VERSION_MISMATCH',
        expected: expectedVersion,
        actual: order.version,
      },
    };
  }

  // 4. 전이 유효성 검사
  if (!options.force && !canTransition(order.status, toStatus)) {
    return {
      success: false,
      error: {
        type: 'INVALID_TRANSITION',
        from: order.status,
        to: toStatus,
      },
    };
  }

  // 5. claimed 전이 시 특별 처리
  if (toStatus === 'claimed') {
    // 이미 다른 사람이 claim한 경우
    if (order.claimedBy && order.claimedBy !== options.claimerId) {
      return {
        success: false,
        error: {
          type: 'ALREADY_CLAIMED',
          claimedBy: order.claimedBy,
        },
      };
    }

    // claimer ID 필수
    if (!options.claimerId) {
      throw new Error('claimerId is required for claimed transition');
    }
  }

  // 6. 새 상태로 업데이트
  const updatedOrder: TrackedOrder = {
    ...order,
    status: toStatus,
    version: order.version + 1,
    updatedAt: Date.now(),
    // claimed 관련 필드
    claimedBy: toStatus === 'claimed' ? options.claimerId : order.claimedBy,
    claimedAt: toStatus === 'claimed' ? Date.now() : order.claimedAt,
  };

  // claimed에서 다른 상태로 전이 시 claim 정보 초기화
  if (order.status === 'claimed' && toStatus !== 'claimed') {
    if (toStatus === 'requested') {
      // requested로 돌아갈 때만 claim 정보 초기화
      updatedOrder.claimedBy = undefined;
      updatedOrder.claimedAt = undefined;
    }
    // paid로 갈 때는 claim 정보 유지 (누가 사줬는지 기록)
  }

  // 7. 저장
  orders[orderId] = updatedOrder;
  await setAllOrders(orders);

  return {
    success: true,
    order: updatedOrder,
  };
}

/**
 * 상태 전이 시도 (재시도 로직 포함)
 *
 * 버전 불일치 시 자동으로 최신 버전을 가져와 재시도
 *
 * @param orderId 주문 ID
 * @param toStatus 전이할 상태
 * @param options 전이 옵션
 * @param maxRetries 최대 재시도 횟수
 */
export async function transitionOrderWithRetry(
  orderId: string,
  toStatus: OrderStatus,
  options: TransitionOptions = {},
  maxRetries: number = 3
): Promise<TransitionResult> {
  let lastError: TransitionError | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 최신 주문 조회
    const orders = await getAllOrders();
    const order = orders[orderId];

    if (!order) {
      return {
        success: false,
        error: { type: 'ORDER_NOT_FOUND', orderId },
      };
    }

    // 전이 시도
    const result = await transitionOrder(orderId, toStatus, order.version, options);

    if (result.success) {
      return result;
    }

    // 버전 불일치면 재시도
    if (result.error.type === 'VERSION_MISMATCH') {
      lastError = result.error;
      // 약간의 지연 후 재시도 (jitter)
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      continue;
    }

    // 다른 에러는 즉시 반환
    return result;
  }

  // 최대 재시도 횟수 초과
  return {
    success: false,
    error: lastError || { type: 'ORDER_NOT_FOUND', orderId },
  };
}

/**
 * 여러 전이를 원자적으로 실행하기 위한 트랜잭션
 *
 * 모든 전이가 성공해야 커밋, 하나라도 실패하면 롤백
 * (현재는 단일 주문만 지원, 확장 가능)
 */
export async function transitionBatch(
  transitions: Array<{
    orderId: string;
    toStatus: OrderStatus;
    options?: TransitionOptions;
  }>
): Promise<
  | { success: true; orders: TrackedOrder[] }
  | { success: false; errors: Array<{ orderId: string; error: TransitionError }> }
> {
  const orders = await getAllOrders();
  const updatedOrders: TrackedOrder[] = [];
  const errors: Array<{ orderId: string; error: TransitionError }> = [];

  // 1. 모든 전이 검증 (dry run)
  for (const { orderId, toStatus, options } of transitions) {
    const order = orders[orderId];

    if (!order) {
      errors.push({ orderId, error: { type: 'ORDER_NOT_FOUND', orderId } });
      continue;
    }

    if (!options?.force && !canTransition(order.status, toStatus)) {
      errors.push({
        orderId,
        error: { type: 'INVALID_TRANSITION', from: order.status, to: toStatus },
      });
      continue;
    }

    if (toStatus === 'claimed' && order.claimedBy && order.claimedBy !== options?.claimerId) {
      errors.push({
        orderId,
        error: { type: 'ALREADY_CLAIMED', claimedBy: order.claimedBy },
      });
      continue;
    }
  }

  // 2. 에러가 있으면 전체 실패
  if (errors.length > 0) {
    return { success: false, errors };
  }

  // 3. 모든 전이 적용
  for (const { orderId, toStatus, options } of transitions) {
    const order = orders[orderId];

    const updatedOrder: TrackedOrder = {
      ...order,
      status: toStatus,
      version: order.version + 1,
      updatedAt: Date.now(),
      claimedBy: toStatus === 'claimed' ? options?.claimerId : order.claimedBy,
      claimedAt: toStatus === 'claimed' ? Date.now() : order.claimedAt,
    };

    orders[orderId] = updatedOrder;
    updatedOrders.push(updatedOrder);
  }

  // 4. 저장
  await setAllOrders(orders);

  return { success: true, orders: updatedOrders };
}
