import { useSyncExternalStore } from 'react';
import type { NodeTracker } from '../lightning';

interface Props {
  tracker: NodeTracker;
}

function shortenPubkey(pk: string): string {
  return pk.slice(0, 8) + '…';
}

export function NodeStatus({ tracker }: Props) {
  const snap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);

  return (
    <div style={styles.container}>
      <span style={styles.label}>LN</span>
      {snap.status === 'connected' && snap.info ? (
        <span style={styles.info}>
          {snap.info.alias || shortenPubkey(snap.info.pubkey)}
          <span style={styles.channels}>
            {snap.info.activeChannelsCount}ch
          </span>
        </span>
      ) : snap.status === 'error' ? (
        <span
          style={styles.errorText}
          onClick={() => tracker.refresh()}
          title={snap.error ?? ''}
        >
          연결 오류 ↻
        </span>
      ) : snap.status === 'connecting' ? (
        <span style={styles.loading}>연결 중...</span>
      ) : null}
      <span style={styles.dot(snap.status === 'connected')} />
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#8B5CF6',
  },
  info: {
    fontSize: 13,
    fontWeight: 500 as const,
    color: '#333',
  },
  channels: {
    fontSize: 11,
    color: '#666',
    marginLeft: 4,
  },
  loading: {
    fontSize: 12,
    color: '#999',
  },
  errorText: {
    fontSize: 12,
    color: '#DC2626',
    cursor: 'pointer',
  },
  dot: (connected: boolean) => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: connected ? '#22C55E' : '#D1D5DB',
    flexShrink: 0,
  }),
};
