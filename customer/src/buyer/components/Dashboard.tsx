import { useSyncExternalStore } from 'react';
import { isTerminalState, type PriceTracker } from '@sajwo-tracker/shared';
import { subscribe, getSnapshot, getSyncedSnapshot, clearDeletableOrders } from '../order-store';
import type { CustomerOrder } from '../types';
import { LnOrderCard } from '../../ln/LnOrderCard';
import { OrderForm } from './OrderForm';
import { ParsedOrdersSection } from './ParsedOrdersSection';
import { UserscriptGuide, canInstallUserscript } from './UserscriptGuide';
import { ToastContainer } from '../../components/Toast';

interface Props {
  tracker: PriceTracker;
  /** 카드의 "진행 상황 · 채팅" — 상세 화면으로 */
  onSelectOrder: (orderId: string) => void;
}

/** 지워도 되는 로컬 기록 — 아직 오더가 안 된 것(초안)과 끝난 것. 진행 중인 건 취소가 먼저다 */
function isClearable(o: CustomerOrder): boolean {
  return !o.adminState || isTerminalState(o.adminState);
}

/** 진행 중 먼저(기한 임박순), 끝난 건 뒤로(최근 것 먼저) */
function byUrgency(a: CustomerOrder, b: CustomerOrder): number {
  const doneA = !!a.adminState && isTerminalState(a.adminState);
  const doneB = !!b.adminState && isTerminalState(b.adminState);
  if (doneA !== doneB) return doneA ? 1 : -1;
  if (doneA) return b.createdAt - a.createdAt;
  if (a.expiration === 0 || b.expiration === 0) return b.expiration - a.expiration;
  return a.expiration - b.expiration;
}

export function Dashboard({ tracker, onSelectOrder }: Props) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const synced = useSyncExternalStore(subscribe, getSyncedSnapshot);
  const sorted = Object.values(orders).sort(byUrgency);

  function handleClearAll() {
    if (!confirm('끝난 의뢰와 오더가 되지 않은 의뢰를 모두 지우시겠습니까? 진행 중인 의뢰는 남습니다.')) return;
    if (clearDeletableOrders(isClearable) === 0) alert('지울 의뢰가 없습니다.');
  }

  return (
    <>
      {/* 제목과 시세는 App 셸이 그린다 — 탭 전환과 무관하게 늘 떠 있어야 하므로 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-secondary" onClick={handleClearAll}>끝난 의뢰 지우기</button>
      </div>

      <ParsedOrdersSection />
      <OrderForm />

      <h2 className="section-title">내 의뢰</h2>
      {!synced && <p style={styles.syncing}>릴레이에서 상태를 불러오는 중...</p>}
      {sorted.length === 0 ? (
        <div className="empty-state">등록한 의뢰가 없습니다</div>
      ) : (
        <div style={styles.list}>
          {sorted.map(o => (
            <LnOrderCard key={o.orderId} orderId={o.orderId} tracker={tracker} onOpen={onSelectOrder} allowDelete />
          ))}
        </div>
      )}

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

const styles = {
  list: { display: 'flex', flexDirection: 'column' as const, gap: 12, marginBottom: 24 },
  syncing: { padding: '8px 12px', fontSize: 13, color: '#999', background: '#fefce8', borderRadius: 6, margin: '0 0 12px' },
};
