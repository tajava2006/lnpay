import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getSyncedSnapshot } from '../order-store';
import { isFinal } from '../order-states';
import { OrderRow } from './OrderRow';
import type { CustomerOrder } from '../types';
import type { PriceTracker } from '@sajwo-tracker/shared';

interface Props {
  tracker: PriceTracker;
}

export function OrderTable({ tracker }: Props) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const synced = useSyncExternalStore(subscribe, getSyncedSnapshot);

  const orderArray = Object.values(orders)
    .sort((a: CustomerOrder, b: CustomerOrder) => {
      // 만료 임박순
      if (a.expiration === 0 && b.expiration === 0) return b.createdAt - a.createdAt;
      if (a.expiration === 0) return 1;
      if (b.expiration === 0) return -1;
      return a.expiration - b.expiration;
    });

  // 비최종 상태를 먼저, 최종 상태를 뒤에
  const sorted = [
    ...orderArray.filter(o => !isFinal(o)),
    ...orderArray.filter(o => isFinal(o)),
  ];

  return (
    <div className="order-table">
      {!synced && (
        <div style={{ padding: '8px 16px', fontSize: 13, color: '#999', background: '#fefce8' }}>
          릴레이에서 상태를 불러오는 중...
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>주문번호</th>
            <th>메모</th>
            <th>금액</th>
            <th>상태</th>
            <th>등록일</th>
            <th>관리</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty-state">추적 중인 주문이 없습니다</td>
            </tr>
          ) : (
            sorted.map(order => (
              <OrderRow key={order.orderId} order={order} tracker={tracker} />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
