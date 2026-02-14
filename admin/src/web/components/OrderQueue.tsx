import { useSyncExternalStore } from 'react';
import {
  subscribe as claimSubscribe,
  getSnapshot as claimSnapshot,
  getSyncedSnapshot,
} from '../claim-store';
import {
  subscribe as orderSubscribe,
  getSnapshot as orderSnapshot,
} from '../order-store';
import type { ClaimEvent, OrderRef } from '../types';

interface OrderSummary {
  orderId: string;
  order: OrderRef | undefined;
  claims: ClaimEvent[];
  pendingCount: number;
  latestClaimAt: number;
}

interface Props {
  onSelectOrder: (orderId: string) => void;
}

export function OrderQueue({ onSelectOrder }: Props) {
  const claims = useSyncExternalStore(claimSubscribe, claimSnapshot);
  const synced = useSyncExternalStore(claimSubscribe, getSyncedSnapshot);
  const orders = useSyncExternalStore(orderSubscribe, orderSnapshot);

  // 클레임을 주문 단위로 그루핑
  const orderMap = new Map<string, ClaimEvent[]>();
  for (const claim of Object.values(claims)) {
    const list = orderMap.get(claim.orderId) ?? [];
    list.push(claim);
    orderMap.set(claim.orderId, list);
  }

  // OrderSummary 생성 + 정렬 (pending 있는 주문 먼저, 그 안에서 최신 클레임순)
  const summaries: OrderSummary[] = Array.from(orderMap.entries())
    .map(([orderId, claimList]) => ({
      orderId,
      order: orders[orderId],
      claims: claimList,
      pendingCount: claimList.filter(c => c.status === 'pending').length,
      latestClaimAt: Math.max(...claimList.map(c => c.createdAt)),
    }))
    .sort((a, b) => {
      if (a.pendingCount > 0 && b.pendingCount === 0) return -1;
      if (a.pendingCount === 0 && b.pendingCount > 0) return 1;
      return b.latestClaimAt - a.latestClaimAt;
    });

  const totalPending = summaries.reduce((sum, s) => sum + s.pendingCount, 0);

  if (summaries.length === 0 && !synced) {
    return <div style={styles.message}>릴레이에서 클레임을 불러오는 중...</div>;
  }

  if (summaries.length === 0) {
    return <div style={styles.message}>수신된 클레임이 없습니다</div>;
  }

  return (
    <div>
      {!synced && <div style={styles.syncBadge}>동기화 중...</div>}
      <div style={styles.stats}>
        대기 {totalPending}건 / 주문 {summaries.length}건
      </div>
      <div style={styles.list}>
        {summaries.map(s => (
          <button
            key={s.orderId}
            style={styles.card}
            onClick={() => onSelectOrder(s.orderId)}
          >
            <div style={styles.top}>
              <div style={styles.orderInfo}>
                <span style={styles.orderId}>#{s.orderId}</span>
                {s.order && (
                  <span style={styles.price}>
                    {s.order.price.toLocaleString()}
                    {s.order.currency === 'KRW' ? '원' : ` ${s.order.currency}`}
                  </span>
                )}
              </div>
              <span style={styles.arrow}>→</span>
            </div>
            <div style={styles.meta}>
              <span>클레임 {s.claims.length}건</span>
              {s.pendingCount > 0 && (
                <span style={styles.pendingBadge}>대기 {s.pendingCount}</span>
              )}
              {s.order?.expiresAt && (
                <span style={styles.expiry}>
                  만료: {new Date(s.order.expiresAt * 1000).toLocaleString('ko-KR', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const styles = {
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  card: {
    display: 'block',
    width: '100%',
    background: '#fff',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    padding: '14px 20px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    transition: 'background 0.15s',
    fontFamily: 'inherit',
  },
  top: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  orderInfo: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
  },
  orderId: {
    fontSize: 15,
    fontWeight: 600 as const,
    color: '#333',
  },
  price: {
    fontSize: 18,
    fontWeight: 700 as const,
    color: '#4F46E5',
  },
  arrow: {
    fontSize: 18,
    color: '#999',
  },
  meta: {
    display: 'flex',
    gap: 12,
    fontSize: 12,
    color: '#999',
    alignItems: 'center',
  },
  pendingBadge: {
    background: '#FEF3C7',
    color: '#D97706',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 600 as const,
  },
  expiry: {
    color: '#999',
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
  stats: {
    fontSize: 13,
    color: '#666',
    marginBottom: 16,
  },
};
