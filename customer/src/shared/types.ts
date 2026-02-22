// ============================================================
// 추적 주문 (Tracked Order)
// ============================================================

import type { OrderState } from '@sajwo-tracker/shared';

/**
 * 무통장입금 계좌 정보
 */
export interface VirtualAccountInfo {
  /** 은행명 (e.g., "농협은행") */
  bankName: string;
  /** 은행 코드 (e.g., "BK11") */
  bankCode: string;
  /** 계좌번호 */
  accountNumber: string;
  /** 예금주 (e.g., "쿠팡") */
  depositor: string;
  /** 입금해야 할 금액 */
  depositPrice: number;
  /** 입금 기한 (timestamp) */
  expirationDate: number;
}

export interface TrackedOrder {
  orderId: string;
  productName: string;
  /** 총 결제 금액 (쿠폰 할인 등 적용 전) */
  amount: number;
  /** 쿠팡 주문 시각 (milliseconds timestamp) */
  createdAt: number;

  /**
   * Admin의 오더 FSM 상태 (Admin 발행 kind 30402에서 수신).
   * undefined = Admin에 아직 등록되지 않음.
   */
  adminState?: OrderState;

  /**
   * 무통장입금 계좌 정보
   * 후원자에게 전달할 입금 정보
   */
  virtualAccount: VirtualAccountInfo;

  /**
   * 발행된 Nostr 이벤트 원본 (JSON 직렬화).
   * 없으면 아직 요청을 전송하지 않은 상태 (주문 감지만 된 상태).
   * 있으면 kind 1111 요청이 릴레이에 발행됨.
   */
  raw?: string;

  /**
   * Admin이 verified 전이 시 발행한 hold invoice (Customer 결제용).
   * kind 30402 이벤트의 bolt11 태그에서 추출.
   */
  bolt11?: string;
}

// ============================================================
// Storage 구조
// ============================================================

export interface StorageData {
  orders: Record<string, TrackedOrder>;
}

// ============================================================
// 쿠팡 API 응답 타입
// ============================================================

/**
 * 무통장입금 미결제 정보 (notPayedPayment)
 * mainPayType === "VCNT" 일 때만 존재
 */
export interface CoupangNotPayedPayment {
  /** 입금 기한 (timestamp) */
  expirationDate: number;
  /** 은행명 */
  bankName: string;
  /** 은행 코드 */
  bankCode: string;
  /** 계좌번호 */
  accountNumber: string;
  /** 예금주 */
  depositor: string;
  /** 입금해야 할 금액 */
  depositPrice: number;
}

/**
 * 결제 완료 정보 (payedPayment)
 */
export interface CoupangPayedPayment {
  cardPayment: unknown | null;
  virtualAccountPayment: {
    bankName: string;
    payed: boolean;
    payedPrice: number;
    refundPrice: number | null;
  } | null;
  couponPayment: {
    payedPrice: number;
    refundPrice: number | null;
  } | null;
  // 기타 결제 수단들은 필요 시 추가
}

export interface CoupangOrderData {
  pageProps: {
    domains: {
      order: {
        entity: {
          entities: Record<
            string,
            {
              orderId: number;
              title: string;
              orderedAt: number;
              totalProductPrice: number;
              allCanceled: boolean;
              deliveryGroupList: Array<{
                groupStatus: {
                  status: string; // "WAIT_PAYMENT", "PAYMENT_COMPLETE" 등
                  notPayed: boolean;
                  paymentExpiredAt?: number;
                };
                productList: Array<{
                  productName: string;
                  unitPrice: number;
                  discountedUnitPrice: number;
                  quantity: number;
                }>;
              }>;
            }
          >;
        };
      };
      payment: {
        entities: Record<
          string,
          {
            orderId: number;
            /** 결제 수단: "VCNT" = 무통장입금, "CARD" = 카드 등 */
            mainPayType: string;
            /** 이미 결제된 총 금액 */
            totalPayedAmount: number;
            /** 총 주문 금액 */
            totalOrderAmount: number;
            /** 취소된 금액 (전체 취소 시 totalOrderAmount와 동일) */
            totalCancelAmount: number;
            /** 결제 완료 여부 (주의: 취소된 주문도 true가 됨!) */
            payed: boolean;
            /** 미결제 정보 (무통장입금 시 계좌 정보 포함) */
            notPayedPayment: CoupangNotPayedPayment | null;
            /** 결제 완료 정보 */
            payedPayment: CoupangPayedPayment | null;
          }
        >;
      };
    };
  };
}
