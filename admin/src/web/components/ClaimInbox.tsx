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
import type { ClaimEvent } from '../types';
import { ClaimCard } from './ClaimCard';

export function ClaimInbox() {
  const claims = useSyncExternalStore(claimSubscribe, claimSnapshot);
  const synced = useSyncExternalStore(claimSubscribe, getSyncedSnapshot);
  const orders = useSyncExternalStore(orderSubscribe, orderSnapshot);

  // pending 먼저, 그 안에서 최신순
  const claimList = Object.values(claims).sort((a: ClaimEvent, b: ClaimEvent) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return b.createdAt - a.createdAt;
  });

  const pendingCount = claimList.filter(c => c.status === 'pending').length;

  if (claimList.length === 0 && !synced) {
    return <div style={styles.message}>릴레이에서 클레임을 불러오는 중...</div>;
  }

  if (claimList.length === 0) {
    return <div style={styles.message}>수신된 클레임이 없습니다</div>;
  }

  return (
    <div>
      {!synced && <div style={styles.syncBadge}>동기화 중...</div>}
      <div style={styles.stats}>
        대기 {pendingCount}건 / 전체 {claimList.length}건
      </div>
      <div style={styles.list}>
        {claimList.map((claim: ClaimEvent) => (
          <ClaimCard
            key={claim.id}
            claim={claim}
            order={orders[claim.orderId]}
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
  stats: {
    fontSize: 13,
    color: '#666',
    marginBottom: 16,
  },
};
