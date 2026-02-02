// 주문 상태
export type OrderStatus = 'pending' | 'paid';

// 추적 중인 주문 정보
export interface TrackedOrder {
  orderId: string;
  productName: string; // 상품명
  amount: number; // 입금해야 할 금액
  status: OrderStatus;
  createdAt: number; // 최초 저장 시점
  updatedAt: number; // 상태 변경 시점
}

// Storage 구조
export interface StorageData {
  orders: Record<string, TrackedOrder>;
}

// 쿠팡 API 응답 타입 (실제 구조 기반)
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
