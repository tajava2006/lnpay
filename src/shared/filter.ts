import type { CoupangOrderData } from './types';

/**
 * 주문 데이터에서 orderId로 주문 엔티티 가져오기
 */
function getOrderEntity(orderData: CoupangOrderData, orderId: string) {
  return orderData.pageProps?.domains?.order?.entity?.entities?.[orderId];
}

/**
 * 주문 데이터에서 orderId로 결제 엔티티 가져오기
 */
function getPaymentEntity(orderData: CoupangOrderData, orderId: string) {
  return orderData.pageProps?.domains?.payment?.entities?.[orderId];
}

/**
 * 추적 대상 주문인지 판별
 * - 무통장입금 주문만 대상
 * - 이미 완료된 주문은 제외
 *
 * TODO: 무통장입금 샘플 데이터 확보 후 정확한 조건 구현
 * 현재는 무조건 true 반환 (테스트용)
 */
export function isTargetOrder(orderData: CoupangOrderData, orderId: string): boolean {
  // TODO: 실제 필터링 로직 구현
  // const payment = getPaymentEntity(orderData, orderId);
  // return payment?.mainPayType === 'VIRTUAL_ACCOUNT' && !payment?.payed;
  return true;
}

/**
 * 주문 데이터에서 상품명 추출
 */
export function extractProductName(orderData: CoupangOrderData, orderId: string): string {
  const order = getOrderEntity(orderData, orderId);
  return order?.title ?? '상품명 없음';
}

/**
 * 주문 데이터에서 입금 금액 추출
 */
export function extractAmount(orderData: CoupangOrderData, orderId: string): number {
  const payment = getPaymentEntity(orderData, orderId);
  return payment?.totalPayedAmount ?? 0;
}

/**
 * 주문이 입금 완료 상태인지 확인
 *
 * TODO: 무통장입금 샘플 데이터 확보 후 정확한 조건 구현
 * 현재는 false 반환 (테스트용)
 */
export function isPaid(orderData: CoupangOrderData, orderId: string): boolean {
  // TODO: 실제 입금 완료 판별 로직 구현
  // const payment = getPaymentEntity(orderData, orderId);
  // return payment?.payed === true;
  return false;
}
