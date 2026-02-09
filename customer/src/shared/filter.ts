import type { CoupangOrderData, VirtualAccountInfo } from './types';

/** 무통장입금 결제 타입 코드 */
const VIRTUAL_ACCOUNT_PAY_TYPE = 'VCNT';

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
 * - 무통장입금 주문만 대상 (mainPayType === "VCNT")
 * - 아직 결제되지 않은 주문만 (payed === false)
 */
export function isTargetOrder(orderData: CoupangOrderData, orderId: string): boolean {
  const payment = getPaymentEntity(orderData, orderId);
  if (!payment) return false;

  // 무통장입금이고 아직 미결제인 경우만 대상
  return payment.mainPayType === VIRTUAL_ACCOUNT_PAY_TYPE && !payment.payed;
}

/**
 * 주문 데이터에서 상품명 추출
 */
export function extractProductName(orderData: CoupangOrderData, orderId: string): string {
  const order = getOrderEntity(orderData, orderId);
  return order?.title ?? '상품명 없음';
}

/**
 * 주문 데이터에서 입금해야 할 금액 추출
 * notPayedPayment.depositPrice 사용 (쿠폰 할인 등 적용된 실제 입금 금액)
 */
export function extractAmount(orderData: CoupangOrderData, orderId: string): number {
  const payment = getPaymentEntity(orderData, orderId);
  return payment?.notPayedPayment?.depositPrice ?? 0;
}

/**
 * 주문 데이터에서 무통장입금 계좌 정보 추출
 */
export function extractVirtualAccount(
  orderData: CoupangOrderData,
  orderId: string
): VirtualAccountInfo | null {
  const payment = getPaymentEntity(orderData, orderId);
  const notPayed = payment?.notPayedPayment;

  if (!notPayed) return null;

  return {
    bankName: notPayed.bankName,
    bankCode: notPayed.bankCode,
    accountNumber: notPayed.accountNumber,
    depositor: notPayed.depositor,
    depositPrice: notPayed.depositPrice,
    expirationDate: notPayed.expirationDate,
  };
}

/**
 * 주문이 입금 완료 상태인지 확인
 */
export function isPaid(orderData: CoupangOrderData, orderId: string): boolean {
  const payment = getPaymentEntity(orderData, orderId);
  return payment?.payed === true;
}

/**
 * 주문이 취소된 상태인지 확인
 * TODO: 실제 취소 샘플 데이터 확보 후 정확한 조건 구현
 */
export function isCancelled(orderData: CoupangOrderData, orderId: string): boolean {
  const order = getOrderEntity(orderData, orderId);
  // allCanceled 필드 또는 groupStatus.status 확인 필요
  return order?.allCanceled === true;
}
