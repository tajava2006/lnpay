import { useSyncExternalStore } from 'react';
import {
  subscribe as claimSubscribe,
  getSnapshot as claimSnapshot,
} from '../claim-store';
import {
  subscribe as orderSubscribe,
  getSnapshot as orderSnapshot,
} from '../order-store';
import type { PriceTracker } from '@sajwo-tracker/shared';
import type { LightningAdapter } from '../lightning';
import type { ClaimEvent } from '../types';
import { ClaimCard } from './ClaimCard';
import { SatsAmount } from './SatsAmount';

interface Props {
  orderId: string;
  onBack: () => void;
  tracker: PriceTracker;
  lnAdapter: LightningAdapter | null;
}

export function OrderClaimList({ orderId, onBack, tracker, lnAdapter }: Props) {
  const claims = useSyncExternalStore(claimSubscribe, claimSnapshot);
  const orders = useSyncExternalStore(orderSubscribe, orderSnapshot);

  const order = orders[orderId];

  // 해당 주문의 클레임만 필터 + 정렬 (pending 먼저, 최신순)
  const claimList = Object.values(claims)
    .filter((c): c is ClaimEvent => c.orderId === orderId)
    .sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return b.createdAt - a.createdAt;
    });

  const pendingCount = claimList.filter(c => c.status === 'pending').length;

  return (
    <div>
      <button style={styles.backBtn} onClick={onBack}>
        ← 주문 목록
      </button>

      <div style={styles.orderHeader}>
        <div style={styles.orderTop}>
          <span style={styles.orderId}>#{orderId}</span>
          {order && (
            <>
              <span style={styles.price}>
                {order.price.toLocaleString()}
                {order.currency === 'KRW' ? '원' : ` ${order.currency}`}
              </span>
              {order.currency === 'KRW' && (
                <SatsAmount krw={order.price} tracker={tracker} />
              )}
            </>
          )}
        </div>
        {order?.expiresAt && (
          <div style={styles.orderMeta}>
            만료: {new Date(order.expiresAt * 1000).toLocaleString('ko-KR', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
          </div>
        )}
      </div>

      <div style={styles.stats}>
        대기 {pendingCount}건 / 클레임 {claimList.length}건
      </div>

      {claimList.length === 0 ? (
        <div style={styles.empty}>이 주문에 대한 클레임이 없습니다</div>
      ) : (
        <div style={styles.list}>
          {claimList.map(claim => (
            <ClaimCard key={claim.id} claim={claim} order={order} tracker={tracker} lnAdapter={lnAdapter} />
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#4F46E5',
    fontSize: 14,
    cursor: 'pointer',
    padding: '4px 0',
    marginBottom: 16,
    fontFamily: 'inherit',
  },
  orderHeader: {
    background: '#F9FAFB',
    borderRadius: 8,
    padding: '16px 20px',
    marginBottom: 16,
  },
  orderTop: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
  },
  orderId: {
    fontSize: 18,
    fontWeight: 600 as const,
    color: '#333',
  },
  price: {
    fontSize: 22,
    fontWeight: 700 as const,
    color: '#4F46E5',
  },
  orderMeta: {
    fontSize: 12,
    color: '#999',
    marginTop: 6,
  },
  stats: {
    fontSize: 13,
    color: '#666',
    marginBottom: 12,
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  empty: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#666',
    fontSize: 14,
  },
};
