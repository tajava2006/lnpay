import { useSyncExternalStore } from 'react';
import type { PriceTracker } from '@sajwo-tracker/shared';

interface Props {
  tracker: PriceTracker;
}

export function BtcPrice({ tracker }: Props) {
  const snap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);

  const connectedCount = snap.exchanges.filter(e => e.connected).length;

  return (
    <>
      <div className="stat-value btc">
        {snap.price !== null
          ? `${snap.price.toLocaleString('ko-KR')}원`
          : '연결 중...'
        }
        <span
          className={`btc-dot${connectedCount > 0 ? ' connected' : ''}`}
        />
      </div>
    </>
  );
}
