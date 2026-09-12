import { useCallback, useEffect, useMemo, useState } from 'react';
import { idbGetOrdersPage, getUserPubkey, storage } from '@sajwo-tracker/shared';
import type { Order, PriceTracker } from '@sajwo-tracker/shared';

/**
 * 내가 이 주문에 어느 역할로 참여했는가.
 *
 * 별도 칼럼을 두지 않는다 — Order가 customerPubkey/sponsorPubkey를 둘 다
 * 들고 있고, 그 값은 Admin이 서명한 kind 30402에서 온 권위 있는 값이다.
 * 칼럼은 쓰는 시점에 틀리거나 낡을 수 있지만 이건 그럴 수 없다.
 *
 * 한 주문에서 둘 다 참일 수 있는 경로는 자기 클레임뿐인데 Admin FSM이
 * 막으므로(handleClaim), 이 판정은 항상 하나로 떨어진다.
 */
type Role = 'buyer' | 'sponsor' | null;

function roleOf(order: Order, myPubkey: string | null): Role {
  if (!myPubkey) return null;
  if (order.customerPubkey === myPubkey) return 'buyer';
  if (order.sponsorPubkey === myPubkey) return 'sponsor';
  return null;
}

type Filter = 'all' | 'buyer' | 'sponsor';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'buyer', label: '내가 산 것' },
  { key: 'sponsor', label: '내가 사준 것' },
];

const ROLE_BADGE: Record<Exclude<Role, null>, { label: string; bg: string; color: string }> = {
  buyer: { label: '샀음', bg: '#EEF2FF', color: '#4338CA' },
  sponsor: { label: '사줬음', bg: '#ECFDF5', color: '#047857' },
};

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
  const [myPubkey, setMyPubkey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    void getUserPubkey(storage).then(setMyPubkey);
  }, []);

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

  const visible = useMemo(
    () => (filter === 'all' ? orders : orders.filter(o => roleOf(o, myPubkey) === filter)),
    [orders, filter, myPubkey],
  );

  return (
    <div>
      <div style={styles.filterRow}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={filter === f.key ? { ...styles.chip, ...styles.chipOn } : styles.chip}
          >
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 && !loading && (
        <div style={styles.empty}>
          {orders.length === 0 ? '거래 이력이 없습니다' : '이 조건에 맞는 거래가 없습니다'}
        </div>
      )}

      <div style={styles.list}>
        {visible.map(order => {
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
                <span style={styles.badgeGroup}>
                  {(() => {
                    const role = roleOf(order, myPubkey);
                    if (!role) return null;
                    const meta = ROLE_BADGE[role];
                    return (
                      <span style={{ ...styles.roleBadge, background: meta.bg, color: meta.color }}>
                        {meta.label}
                      </span>
                    );
                  })()}
                  <span style={{
                    ...styles.stateBadge,
                    background: stateBg[order.state] ?? '#F3F4F6',
                    color: stateColor[order.state] ?? '#666',
                  }}>
                    {stateLabel[order.state] ?? order.state}
                  </span>
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
  filterRow: {
    display: 'flex',
    gap: 6,
    marginBottom: 12,
    flexWrap: 'wrap' as const,
  },
  chip: {
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid #E5E7EB',
    background: '#fff',
    color: '#6B7280',
    fontSize: 13,
    fontWeight: 500 as const,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  chipOn: {
    background: '#4F46E5',
    borderColor: '#4F46E5',
    color: '#fff',
    fontWeight: 600 as const,
  },
  badgeGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  roleBadge: {
    display: 'inline-block',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 700 as const,
    whiteSpace: 'nowrap' as const,
  },
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
