import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, clearDeletableOrders } from '../order-store';
import { isDeletable } from '../order-states';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { OrderForm } from './OrderForm';
import { OrderTable } from './OrderTable';
import { ParsedOrdersSection } from './ParsedOrdersSection';
import { UserscriptGuide } from './UserscriptGuide';
import { ToastContainer } from '../../components/Toast';

interface Props {
  tracker: PriceTracker;
}

export function Dashboard({ tracker }: Props) {
  useSyncExternalStore(subscribe, getSnapshot);

  function handleClearAll() {
    if (!confirm('모든 의뢰를 삭제하시겠습니까?')) return;
    const ok = clearDeletableOrders(isDeletable);
    if (!ok) alert('거래 진행 중인 의뢰가 있어 전체 삭제할 수 없습니다.');
  }

  return (
    <>
      {/* 제목과 시세는 App 셸이 그린다 — 탭 전환과 무관하게 늘 떠 있어야 하므로 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-secondary" onClick={handleClearAll}>전체 삭제</button>
      </div>

      <ParsedOrdersSection />
      <OrderForm />

      <h2 className="section-title">의뢰 목록</h2>
      <OrderTable tracker={tracker} />

      <UserscriptGuide />

      <ToastContainer />
    </>
  );
}
