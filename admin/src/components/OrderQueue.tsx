import { useSyncExternalStore } from 'react';
import {
  subscribe as requestSubscribe,
  getSnapshot as requestSnapshot,
  getSyncedSnapshot,
} from '../request-store';
import {
  subscribe as orderSubscribe,
  getSnapshot as orderSnapshot,
} from '../order-store';
import type { PriceTracker, Order } from '@sajwo-tracker/shared';
import { SatsAmount } from './SatsAmount';

interface OrderSummary {
  order: Order;
  requestCount: number;
}

interface Props {
  onSelectOrder: (orderId: string) => void;
  tracker: PriceTracker;
}

const TERMINAL_STATES = new Set(['paid', 'cancelled', 'sponsor_wins', 'customer_wins']);

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

export function OrderQueue({ onSelectOrder, tracker }: Props) {
  const requests = useSyncExternalStore(requestSubscribe, requestSnapshot);
  const synced = useSyncExternalStore(requestSubscribe, getSyncedSnapshot);
  const orders = useSyncExternalStore(orderSubscribe, orderSnapshot);

  // 요청을 주문별로 카운팅
  const requestCountMap = new Map<string, number>();
  for (const req of Object.values(requests)) {
    requestCountMap.set(req.orderId, (requestCountMap.get(req.orderId) ?? 0) + 1);
  }

  // OrderSummary 생성 + 정렬 (활성 주문 먼저, 그 안에서 최신순)
  const summaries: OrderSummary[] = Object.values(orders)
    .map((order) => ({
      order,
      requestCount: requestCountMap.get(order.orderId) ?? 0,
    }))
    .sort((a, b) => {
      const aTerminal = TERMINAL_STATES.has(a.order.state);
      const bTerminal = TERMINAL_STATES.has(b.order.state);
      if (!aTerminal && bTerminal) return -1;
      if (aTerminal && !bTerminal) return 1;
      return b.order.updatedAt - a.order.updatedAt;
    });

  const activeCount = summaries.filter(s => !TERMINAL_STATES.has(s.order.state)).length;

  if (summaries.length === 0 && !synced) {
    return <div style={styles.message}>릴레이에서 오더를 불러오는 중...</div>;
  }

  if (summaries.length === 0) {
    return <div style={styles.message}>수신된 오더가 없습니다</div>;
  }

  return (
    <div>
      {!synced && <div style={styles.syncBadge}>동기화 중...</div>}
      <div style={styles.stats}>
        활성 {activeCount}건 / 전체 {summaries.length}건
      </div>
      <div style={styles.list}>
        {summaries.map(s => {
          const now = Math.floor(Date.now() / 1000);
          const expired = s.order.expiration > 0 && s.order.expiration <= now;

          return (
            <button
              key={s.order.orderId}
              style={{
                ...styles.card,
                ...(expired ? styles.cardExpired : undefined),
              }}
              onClick={() => onSelectOrder(s.order.orderId)}
            >
              <div style={styles.top}>
                <div style={styles.orderInfo}>
                  <span style={styles.orderId}>#{s.order.orderId}</span>
                  <span style={styles.price}>
                    {s.order.price.toLocaleString()}원
                  </span>
                  <SatsAmount krw={s.order.price} tracker={tracker} />
                </div>
                <span style={{
                  ...styles.stateBadge,
                  background: stateBg[s.order.state] ?? '#F3F4F6',
                  color: stateColor[s.order.state] ?? '#666',
                }}>
                  {stateLabel[s.order.state] ?? s.order.state}
                </span>
              </div>
              <div style={styles.meta}>
                <span>요청 {s.requestCount}건</span>
                {s.order.expiration > 0 && (
                  <span style={expired ? styles.expiryExpired : styles.expiry}>
                    {expired ? '만료됨' : `만료: ${new Date(s.order.expiration * 1000).toLocaleString('ko-KR', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}`}
                  </span>
                )}
              </div>
            </button>
          );
        })}
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
  cardExpired: {
    opacity: 0.5,
  },
  expiry: {
    color: '#999',
  },
  expiryExpired: {
    color: '#DC2626',
    fontWeight: 500 as const,
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
