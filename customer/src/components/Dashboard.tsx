import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, clearDeletableOrders } from '../order-store';
import { isFinal, isDeletable } from '../order-states';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { OrderForm } from './OrderForm';
import { OrderTable } from './OrderTable';
import { BtcPrice } from './BtcPrice';
import { ToastContainer } from './Toast';
import type { CustomerOrder } from '../types';

interface Props {
  tracker: PriceTracker;
}

export function Dashboard({ tracker }: Props) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const orderArray = Object.values(orders);

  const activeCount = orderArray.filter((o: CustomerOrder) => !isFinal(o)).length;
  const completedCount = orderArray.filter((o: CustomerOrder) => isFinal(o)).length;

  function handleClearAll() {
    if (!confirm('모든 주문을 삭제하시겠습니까?')) return;
    const ok = clearDeletableOrders(isDeletable);
    if (!ok) alert('거래 진행 중인 주문이 있어 전체 삭제할 수 없습니다.');
  }

  return (
    <>
      <div className="header">
        <h1>사줘 트래커</h1>
        <button className="btn btn-secondary" onClick={handleClearAll}>전체 삭제</button>
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="stat-label">활성 주문</div>
          <div className="stat-value pending">{activeCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">완료</div>
          <div className="stat-value paid">{completedCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">전체</div>
          <div className="stat-value">{orderArray.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">BTC/KRW</div>
          <BtcPrice tracker={tracker} />
        </div>
      </div>

      <OrderForm />

      <h2 className="section-title">주문 목록</h2>
      <OrderTable />

      <ToastContainer />
    </>
  );
}
