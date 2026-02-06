// ============================================================
// 주문 상태 (Order Status)
// ============================================================

/**
 * 주문의 상태를 나타내는 타입
 *
 * 상태 흐름:
 * detected → requested → claimed → selected → paid (최종)
 *    ↓          ↓  ↘        ↓  ↘       ↓  ↘
 *   paid       paid  cancelled paid  cancelled  cancelled
 *                         ↓          ↓
 *                      requested  requested
 *
 * - detected: 주문 감지됨 (무통장입금 주문 발견)
 * - requested: 사줘 요청함 (다른 사람에게 입금 요청 전송)
 * - claimed: 누군가 사주겠다고 응답함
 * - selected: 클레이머 중 한 명을 선택함 (이 사람에게 사달라고 확정)
 * - paid: 입금 완료됨 (최종 상태, 이후 쿠팡 취소 등은 앱에서 관리 안함)
 * - cancelled: 취소됨 (쿠팡에서 주문 자체를 취소, 자동 감지)
 */
export type OrderStatus = 'detected' | 'requested' | 'claimed' | 'selected' | 'paid' | 'cancelled';

/**
 * 허용된 상태 전이 맵
 * key: 현재 상태, value: 전이 가능한 상태 목록
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  detected: ['requested', 'paid', 'cancelled'], // paid: 앱 없이 직접 입금
  requested: ['claimed', 'paid', 'cancelled'], // paid: 사줘 요청 해놓고 본인이 직접 입금해버린 케이스 (병신 시나리오)
  claimed: ['selected', 'paid', 'requested', 'cancelled'], // selected: 클레이머 선택, requested: 클레이머 거절, paid: 클레이머 냅두고 본인이 입금 (병신 시나리오)
  selected: ['paid', 'requested', 'cancelled'], // requested: 특정 조건 하에 재요청 가능
  paid: [], // 최종 상태: 이후 쿠팡 취소 등은 앱에서 관리 안함
  cancelled: [], // 최종 상태
};

// ============================================================
// 추적 주문 (Tracked Order)
// ============================================================

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
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;

  /**
   * Optimistic Locking을 위한 버전 번호
   * 상태 전이 시 현재 버전과 일치해야만 업데이트 가능
   */
  version: number;

  /**
   * 무통장입금 계좌 정보
   * 후원자에게 전달할 입금 정보
   */
  virtualAccount: VirtualAccountInfo;

  /**
   * 사줘 요청을 수락한 사람의 ID (claimed 상태일 때)
   * 레이스 컨디션 방지: 한 명만 claim 가능
   */
  claimedBy?: string;

  /**
   * claim된 시점 (타임아웃 관리용)
   */
  claimedAt?: number;
}

// ============================================================
// Storage 구조
// ============================================================

export interface StorageData {
  orders: Record<string, TrackedOrder>;
}

// ============================================================
// 상태 전이 관련 타입
// ============================================================

/**
 * 상태 전이 결과
 */
export type TransitionResult =
  | { success: true; order: TrackedOrder }
  | { success: false; error: TransitionError };

export type TransitionError =
  | { type: 'ORDER_NOT_FOUND'; orderId: string }
  | { type: 'INVALID_TRANSITION'; from: OrderStatus; to: OrderStatus }
  | { type: 'VERSION_MISMATCH'; expected: number; actual: number }
  | { type: 'ALREADY_CLAIMED'; claimedBy: string };

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
            /** 결제 완료 여부 */
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
