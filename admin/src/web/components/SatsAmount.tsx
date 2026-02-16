import { useSyncExternalStore } from 'react';
import type { PriceTracker } from '@sajwo-tracker/shared';

interface Props {
  krw: number;
  tracker: PriceTracker;
}

/** KRW 금액을 현재 BTC 시세로 환산한 sats를 표시한다. */
export function SatsAmount({ krw, tracker }: Props) {
  const snap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);

  if (!snap.price) return null;

  const sats = Math.floor(krw * 100_000_000 / snap.price);

  return (
    <span style={styles.sats}>
      ~{sats.toLocaleString()} sats
    </span>
  );
}

const styles = {
  sats: {
    fontSize: 12,
    color: '#F59E0B',
    fontWeight: 500 as const,
    marginLeft: 6,
  },
};
