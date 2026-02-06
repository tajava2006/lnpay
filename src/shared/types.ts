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

export interface TrackedOrder {
  orderId: string;
  productName: string;
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
              deliveryGroupList: Array<{
                groupStatus: {
                  status: string;
                  notPayed: boolean;
                };
                productList: Array<{
                  productName: string;
                  discountedUnitPrice: number;
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
            mainPayType: string;
            totalPayedAmount: number;
            payed: boolean;
            notPayedPayment: {
              virtualAccountPayment?: {
                bankName: string;
                accountNumber: string;
                paymentExpireDate: number;
              };
            } | null;
          }
        >;
      };
    };
  };
}
