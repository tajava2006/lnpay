import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getSyncedSnapshot } from '../order-store';
import type { SajwoRequest } from '../types';
import { OrderCard } from './OrderCard';

export function OrderBook() {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const synced = useSyncExternalStore(subscribe, getSyncedSnapshot);

  // 매초 갱신하여 남은 시간 자동 업데이트 + 만료 주문 자동 제거
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // 만료되지 않은 요청만 필터링, 만료 임박순 (expiresAt 없으면 맨 뒤)
  const activeRequests = Object.values(orders)
    .filter((r: SajwoRequest) => !r.expiresAt || r.expiresAt > now)
    .sort((a: SajwoRequest, b: SajwoRequest) => {
      if (!a.expiresAt && !b.expiresAt) return 0;
      if (!a.expiresAt) return 1;
      if (!b.expiresAt) return -1;
      return a.expiresAt - b.expiresAt;
    });

  if (activeRequests.length === 0 && !synced) {
    return <div style={styles.message}>릴레이에서 사줘 요청을 불러오는 중...</div>;
  }

  if (activeRequests.length === 0) {
    return <div style={styles.message}>현재 활성 사줘 요청이 없습니다</div>;
  }

  return (
    <div>
      {!synced && <div style={styles.syncBadge}>동기화 중...</div>}
      <div style={styles.list}>
        {activeRequests.map((request: SajwoRequest) => (
          <OrderCard key={request.orderId} request={request} now={now} />
        ))}
      </div>
    </div>
  );
}

const styles = {
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  message: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#666',
    fontSize: 14,
  },
  syncBadge: {
    textAlign: 'center' as const,
    padding: '6px 0',
    marginBottom: 12,
    fontSize: 12,
    color: '#999',
  },
};
