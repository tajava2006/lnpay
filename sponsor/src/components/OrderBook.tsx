import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getSyncedSnapshot } from '../order-store';
import type { Order } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { OrderCard } from './OrderCard';

interface Props {
  tracker: PriceTracker;
}

const TERMINAL_STATES = new Set(['paid', 'cancelled']);

export function OrderBook({ tracker }: Props) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const synced = useSyncExternalStore(subscribe, getSyncedSnapshot);

  // 매초 갱신하여 남은 시간 자동 업데이트
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // 활성 오더만 표시 (만료 안 된 + 비종료 상태), 만료 임박순
  const activeOrders = Object.values(orders)
    .filter((o: Order) =>
      !TERMINAL_STATES.has(o.state)
      && (o.expiration === 0 || o.expiration > now),
    )
    .sort((a: Order, b: Order) => {
      if (a.expiration === 0 && b.expiration === 0) return 0;
      if (a.expiration === 0) return 1;
      if (b.expiration === 0) return -1;
      return a.expiration - b.expiration;
    });

  if (activeOrders.length === 0 && !synced) {
    return <div style={styles.message}>릴레이에서 오더를 불러오는 중...</div>;
  }

  if (activeOrders.length === 0) {
    return <div style={styles.message}>현재 활성 오더가 없습니다</div>;
  }

  return (
    <div>
      {!synced && <div style={styles.syncBadge}>동기화 중...</div>}
      <div style={styles.list}>
        {activeOrders.map((order: Order) => (
          <OrderCard key={order.orderId} order={order} now={now} tracker={tracker} />
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
