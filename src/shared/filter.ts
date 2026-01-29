import type { CoupangOrderData } from './types';

/**
 * 추적 대상 주문인지 판별
 * - 무통장입금 주문만 대상
 * - 이미 완료된 주문은 제외
 *
 * TODO: 실제 API 응답 구조 확인 후 구현
 * 현재는 무조건 true 반환
 */
export function isTargetOrder(orderData: CoupangOrderData): boolean {
  // TODO: 실제 필터링 로직 구현
  // 예시:
  // - orderData.paymentMethod === 'BANK_TRANSFER'
  // - orderData.status !== 'COMPLETED'
  return true;
}

/**
 * 주문 데이터에서 입금 금액 추출
 *
 * TODO: 실제 API 응답 구조 확인 후 구현
 * 현재는 0 반환
 */
export function extractAmount(orderData: CoupangOrderData): number {
  // TODO: 실제 금액 추출 로직 구현
  // 예시: return orderData.payment?.amount ?? 0;
  return 0;
}

/**
 * 주문이 입금 완료 상태인지 확인
 *
 * TODO: 실제 API 응답 구조 확인 후 구현
 * 현재는 false 반환
 */
export function isPaid(orderData: CoupangOrderData): boolean {
  // TODO: 실제 입금 완료 판별 로직 구현
  // 예시: return orderData.paymentStatus === 'PAID';
  return false;
}
