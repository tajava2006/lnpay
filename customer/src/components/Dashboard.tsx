import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, clearDeletableOrders } from '../order-store';
import { isDeletable } from '../order-states';
import { BtcPrice } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { OrderForm } from './OrderForm';
import { OrderTable } from './OrderTable';
import { ParsedOrdersSection } from './ParsedOrdersSection';
import { UserscriptGuide } from './UserscriptGuide';
import { ToastContainer } from './Toast';

interface Props {
  tracker: PriceTracker;
}

export function Dashboard({ tracker }: Props) {
  useSyncExternalStore(subscribe, getSnapshot);

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

      <BtcPrice tracker={tracker} />

      <ParsedOrdersSection />
      <OrderForm />

      <h2 className="section-title">주문 목록</h2>
      <OrderTable tracker={tracker} />

      <UserscriptGuide />

      <ToastContainer />
    </>
  );
}
