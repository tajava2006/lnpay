import { useEffect, useState, useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getSyncedSnapshot } from '../order-store';
import type { Order } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { getUserPubkey, storage } from '@sajwo-tracker/shared';
import { OrderCard } from './OrderCard';

interface Props {
  tracker: PriceTracker;
  onSelectOrder: (orderId: string) => void;
}

const TERMINAL_STATES = new Set(['paid', 'cancelled', 'sponsor_wins', 'customer_wins']);

export function OrderBook({ tracker, onSelectOrder }: Props) {
  const orders = useSyncExternalStore(subscribe, getSnapshot);
  const synced = useSyncExternalStore(subscribe, getSyncedSnapshot);

  // 내 pubkey — 남의 거래인지 판정하는 데 쓴다. 로딩 전엔 null로 두어
  // '다른 후원자가 진행 중'이 깜빡였다 바뀌는 일이 없게 한다.
  const [myPubkey, setMyPubkey] = useState<string | null>(null);
  useEffect(() => {
    void getUserPubkey(storage).then(setMyPubkey);
  }, []);

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
    return <div style={styles.message}>의뢰를 불러오는 중...</div>;
  }

  if (activeOrders.length === 0) {
    return <div style={styles.message}>지금 올라온 의뢰가 없습니다</div>;
  }

  return (
    <div>
      {!synced && <div style={styles.syncBadge}>동기화 중...</div>}
      <div style={styles.list}>
        {activeOrders.map((order: Order) => (
          <OrderCard
            key={order.orderId}
            order={order}
            now={now}
            tracker={tracker}
            myPubkey={myPubkey}
            onSelectOrder={onSelectOrder}
          />
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
