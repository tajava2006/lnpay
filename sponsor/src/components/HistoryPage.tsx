import { useCallback, useEffect, useState } from 'react';
import { idbGetOrdersPage } from '../idb-store';
import type { Order, PriceTracker } from '@sajwo-tracker/shared';

interface Props {
  onSelectOrder: (orderId: string) => void;
  tracker: PriceTracker;
}

const PAGE_SIZE = 20;

const stateLabel: Record<string, string> = {
  requested: '요청됨',
  claimed: '클레임됨',
  verified: '검증됨',
  escrowed: '에스크로',
  remitted: '송금 주장',
  paid: '완료',
  cancelled: '취소',
  sponsor_wins: '후원자 승리',
  customer_wins: '고객 승리',
};

const stateColor: Record<string, string> = {
  requested: '#D97706',
  claimed: '#2563EB',
  verified: '#4F46E5',
  escrowed: '#7C3AED',
  remitted: '#BE185D',
  paid: '#059669',
  cancelled: '#6B7280',
  sponsor_wins: '#0F766E',
  customer_wins: '#0E7490',
};

const stateBg: Record<string, string> = {
  requested: '#FEF3C7',
  claimed: '#DBEAFE',
  verified: '#E0E7FF',
  escrowed: '#EDE9FE',
  remitted: '#FCE7F3',
  paid: '#D1FAE5',
  cancelled: '#F3F4F6',
  sponsor_wins: '#CCFBF1',
  customer_wins: '#CFFAFE',
};

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

  // BTC 시세로 sats 환산
  const snap = tracker.getSnapshot();
  const btcPrice = snap.price;

  return (
    <div>
      {orders.length === 0 && !loading && (
        <div style={styles.empty}>거래 이력이 없습니다</div>
      )}

      <div style={styles.list}>
        {orders.map(order => {
          const sats = btcPrice !== null && btcPrice > 0
            ? Math.round((order.price / btcPrice) * 1e8)
            : null;

          return (
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
                  {sats !== null && (
                    <span style={styles.sats}>~{sats.toLocaleString()} sats</span>
                  )}
                </div>
                <span style={{
                  ...styles.stateBadge,
                  background: stateBg[order.state] ?? '#F3F4F6',
                  color: stateColor[order.state] ?? '#666',
                }}>
                  {stateLabel[order.state] ?? order.state}
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
          );
        })}
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
    cursor: 'pointer' as const,
    textAlign: 'left' as const,
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
  sats: {
    fontSize: 12,
    color: '#999',
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
