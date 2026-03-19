import { useSyncExternalStore } from 'react';
import type { PriceTracker } from '../price';

interface Props {
  tracker: PriceTracker;
}

export function BtcPrice({ tracker }: Props) {
  const snap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);

  const connectedCount = snap.exchanges.filter(e => e.connected).length;

  return (
    <div style={styles.container}>
      <span style={styles.label}>BTC</span>
      {snap.price !== null ? (
        <span style={styles.price}>
          {snap.price.toLocaleString('ko-KR')}
          <span style={styles.unit}>원</span>
        </span>
      ) : (
        <span style={styles.loading}>연결 중...</span>
      )}
      <span style={styles.dot(connectedCount > 0)} />
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#F59E0B',
  },
  price: {
    fontSize: 13,
    fontWeight: 500 as const,
    color: '#333',
  },
  unit: {
    fontSize: 11,
    color: '#666',
    marginLeft: 2,
  },
  loading: {
    fontSize: 12,
    color: '#999',
  },
  dot: (connected: boolean) => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: connected ? '#22C55E' : '#D1D5DB',
    flexShrink: 0,
  }),
};
