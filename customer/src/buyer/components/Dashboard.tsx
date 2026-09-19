import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, clearDeletableOrders } from '../order-store';
import { isDeletable } from '../order-states';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { OrderForm } from './OrderForm';
import { OrderTable } from './OrderTable';
import { ParsedOrdersSection } from './ParsedOrdersSection';
import { UserscriptGuide, canInstallUserscript } from './UserscriptGuide';
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

      {/*
        설치할 수 없는 환경에서는 통째로 숨긴다. 접어두는 것도 아니고 아예 안 낸다 —
        접힌 안내는 "열어보면 방법이 있나" 하고 열어보게 만든다.

        게이트를 컴포넌트 안이 아니라 여기 두는 이유: 안에서 조기 반환하면 훅보다
        앞서게 되어 훅 규칙을 어긴다. 무엇을 보여줄지는 부모가 정하는 게 맞다.
      */}
      {canInstallUserscript() && <UserscriptGuide />}

      <ToastContainer />
    </>
  );
}
