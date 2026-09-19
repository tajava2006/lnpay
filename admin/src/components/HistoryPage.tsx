import { useCallback, useEffect, useState } from 'react';
import { idbGetOrdersPage, stateDisplay } from '@sajwo-tracker/shared';
import { SatsAmount } from './SatsAmount';
import type { Order, PriceTracker } from '@sajwo-tracker/shared';

interface Props {
  onSelectOrder: (orderId: string) => void;
  tracker: PriceTracker;
}

const PAGE_SIZE = 20;

export function HistoryPage({ onSelectOrder, tracker }: Props) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(async (cursor?: number) => {
    setLoading(true);
    try {
      const page = await idbGetOrdersPage(cursor, PAGE_SIZE);
      setOrders(prev => cursor ? [...prev, ...page] : page);
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      console.warn('[HistoryPage] IDB load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const loadMore = useCallback(() => {
    const last = orders[orders.length - 1];
    if (loading || !hasMore || !last) return;
    void loadPage(last.createdAt);
  }, [loading, hasMore, orders, loadPage]);

  return (
    <div>
      {orders.length === 0 && !loading && (
        <div style={styles.empty}>거래 이력이 없습니다</div>
      )}

      <div style={styles.list}>
        {orders.map(order => (
          <button
            key={order.orderId}
            style={styles.card}
            onClick={() => onSelectOrder(order.orderId)}
          >
            <div style={styles.top}>
              <div style={styles.orderInfo}>
                <span style={styles.orderId}>#{order.orderId}</span>
                <span style={styles.price}>
                  {order.price.toLocaleString()}원
                </span>
                <SatsAmount krw={order.price} tracker={tracker} />
              </div>
              <span style={{
                ...styles.stateBadge,
                background: stateDisplay(order.state).bg,
                color: stateDisplay(order.state).color,
              }}>
                {stateDisplay(order.state).label}
              </span>
            </div>
            <div style={styles.meta}>
              <span>
                {new Date(order.createdAt * 1000).toLocaleString('ko-KR', {
                  year: 'numeric', month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </span>
              {order.disbursed && (
                <span style={styles.disbursed}>송금 완료</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {hasMore && (
        <button
          style={styles.loadMore}
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? '불러오는 중...' : '더 보기'}
        </button>
      )}
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
  stateBadge: {
    display: 'inline-block',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600 as const,
  },
  meta: {
    display: 'flex',
    gap: 12,
    fontSize: 12,
    color: '#999',
    alignItems: 'center',
  },
  disbursed: {
    color: '#059669',
    fontWeight: 500 as const,
  },
  empty: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#666',
    fontSize: 14,
  },
  loadMore: {
    display: 'block',
    width: '100%',
    padding: '12px 0',
    marginTop: 12,
    fontSize: 13,
    fontWeight: 500 as const,
    color: '#4F46E5',
    background: '#EEF2FF',
    border: '1px solid #C7D2FE',
    borderRadius: 8,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
} as const;
