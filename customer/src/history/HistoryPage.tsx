/**
 * 내 거래 — 내가 고객이거나 후원자인 라이트닝 의뢰 전부
 *
 * 진행 중인 것은 위(라이브 스토어), 지난 것은 아래(IDB — 릴레이가 보존 끝에 지워도 남는다). 둘 다 어느
 * 탭에서나 같은 `LnOrderCard`다 — 여기서도 결제·인보이스·송금·컨펌이 된다(2026-09-24 드릴: 예전엔
 * 여기서 들어간 상세에 할 일이 없었다).
 *
 * 역할은 칼럼 없이 pubkey 비교로 유도한다 — 오더의 customerPubkey/sponsorPubkey는 APP이 서명한 값이다.
 * 한 주문에서 둘 다 참일 수 있는 경로는 자기 클레임뿐인데 데몬이 막는다.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { idbGetOrdersPage, isTerminalState, type Order, type PriceTracker } from '@sajwo-tracker/shared';
import { subscribe as subscribeOrders, getSnapshot as getOrderSnapshot } from '../sponsor/order-store';
import { LnOrderCard } from '../ln/LnOrderCard';
import { useMyPubkey } from '../hooks';

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

interface Props {
  onSelectOrder: (orderId: string) => void;
  tracker: PriceTracker;
}

const PAGE_SIZE = 20;

export function HistoryPage({ onSelectOrder, tracker }: Props) {
  const [past, setPast] = useState<Order[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const myPubkey = useMyPubkey();
  const live = useSyncExternalStore(subscribeOrders, getOrderSnapshot);

  const loadPage = useCallback(async (cursor?: number) => {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await idbGetOrdersPage(cursor, PAGE_SIZE);
      setPast(prev => (cursor ? [...prev, ...page] : page));
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      console.warn('[HistoryPage] IDB load failed:', err);
      setLoadError('지난 거래를 불러오지 못했습니다. 이 앱이 열린 다른 탭을 닫고 새로고침해 주세요.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const loadMore = useCallback(() => {
    const last = past[past.length - 1];
    if (loading || !hasMore || !last) return;
    void loadPage(last.createdAt);
  }, [loading, hasMore, past, loadPage]);

  const keep = useCallback(
    (o: Order) => (filter === 'all' ? true : roleOf(o, myPubkey) === filter),
    [filter, myPubkey],
  );

  // 진행 중 — 라이브 스토어의 내 의뢰, 기한 임박순
  const active = useMemo(() => Object.values(live)
    .filter(o => roleOf(o, myPubkey) !== null && !isTerminalState(o.state) && keep(o))
    .sort((a, b) => (a.expiration || Infinity) - (b.expiration || Infinity)),
  [live, myPubkey, keep]);

  const activeIds = useMemo(() => new Set(active.map(o => o.orderId)), [active]);
  const done = useMemo(() => past.filter(o => !activeIds.has(o.orderId) && keep(o)), [past, activeIds, keep]);

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

      {active.length > 0 && (
        <>
          <h2 className="section-title">진행 중</h2>
          <div style={{ ...styles.list, marginBottom: 24 }}>
            {active.map(o => <LnOrderCard key={o.orderId} orderId={o.orderId} tracker={tracker} onOpen={onSelectOrder} />)}
          </div>
        </>
      )}

      {done.length > 0 && <h2 className="section-title">지난 거래</h2>}
      {loadError && <div style={styles.error}>{loadError}</div>}
      {active.length === 0 && done.length === 0 && !loading && !loadError && (
        <div style={styles.empty}>
          {past.length === 0 ? '거래 이력이 없습니다' : '이 조건에 맞는 거래가 없습니다'}
        </div>
      )}
      <div style={styles.list}>
        {done.map(o => (
          <LnOrderCard key={o.orderId} orderId={o.orderId} archived={o} tracker={tracker} onOpen={onSelectOrder} />
        ))}
      </div>

      {hasMore && !loadError && (
        <button style={styles.loadMore} onClick={loadMore} disabled={loading}>
          {loading ? '불러오는 중...' : '더 보기'}
        </button>
      )}
    </div>
  );
}

const styles = {
  filterRow: { display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' as const },
  chip: {
    padding: '6px 12px', borderRadius: 999, border: '1px solid #E5E7EB', background: '#fff', color: '#6B7280',
    fontSize: 13, fontWeight: 500 as const, cursor: 'pointer' as const, fontFamily: 'inherit',
  },
  chipOn: { background: '#4F46E5', borderColor: '#4F46E5', color: '#fff', fontWeight: 600 as const },
  list: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  empty: { textAlign: 'center' as const, padding: 48, color: '#666', fontSize: 14 },
  error: { padding: 12, marginBottom: 12, fontSize: 13, color: '#991B1B', background: '#FEF2F2', borderRadius: 8 },
  loadMore: {
    display: 'block', width: '100%', marginTop: 12, padding: '10px 0', fontSize: 13, fontWeight: 500 as const,
    color: '#4F46E5', background: '#fff', border: '1px solid #C7D2FE', borderRadius: 8, cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
