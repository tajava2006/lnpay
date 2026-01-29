// 주문 상태
export type OrderStatus = 'pending' | 'paid';

// 추적 중인 주문 정보
export interface TrackedOrder {
  orderId: string;
  amount: number; // 입금해야 할 금액
  status: OrderStatus;
  createdAt: number; // 최초 저장 시점
  updatedAt: number; // 상태 변경 시점
}

// Storage 구조
export interface StorageData {
  orders: Record<string, TrackedOrder>;
}

// 쿠팡 API 응답에서 추출할 주문 데이터 (필요한 필드만)
export interface CoupangOrderData {
  orderId: string;
  // TODO: 실제 API 응답 구조 확인 후 추가
  [key: string]: unknown;
}
