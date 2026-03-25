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

/**
 * Sponsor 청구 인보이스 금액이 허용 범위 내인지 검증한다.
 *
 * @param orderPriceKrw - 오더의 KRW 금액
 * @param btcPriceKrw   - 현재 BTC/KRW 가격
 * @param amountSat     - Sponsor 인보이스 금액 (satoshi)
 * @returns 허용 범위(±5%) 내이면 true
 */
export function isInvoiceAmountValid(
  orderPriceKrw: number,
  btcPriceKrw: number,
  amountSat: number,
): boolean {
  if (!Number.isFinite(orderPriceKrw) || orderPriceKrw <= 0) return false;
  if (!Number.isFinite(btcPriceKrw) || btcPriceKrw <= 0) return false;
  if (!Number.isFinite(amountSat) || amountSat <= 0) return false;
  const expectedSat = Math.round((orderPriceKrw / btcPriceKrw) * 1e8);
  const ratio = amountSat / expectedSat;
  return ratio >= 0.95 && ratio <= 1.05;
}

export interface TransitionResult {
  success: boolean;
  error?: TransitionError;
}

export type TransitionError =
  | { type: 'ORDER_NOT_FOUND'; orderId: string }
  | { type: 'INVALID_TRANSITION'; from: OrderState; to: OrderState };
