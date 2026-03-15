import { useEffect, useRef } from 'react';
import { KeyInit } from './components/KeyInit';
import { Dashboard } from './components/Dashboard';
import { startSubscriptions, stopSubscriptions } from './nostr/service';
import { createPriceTracker, subscribeRelayLists } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { storage } from './nostr/storage';

function AppContent() {
  const trackerRef = useRef<PriceTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createPriceTracker();
  }
  const tracker = trackerRef.current;

  useEffect(() => {
    const stopRelaySubscription = subscribeRelayLists(storage);
    startSubscriptions();
    tracker.start();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        stopSubscriptions();
        startSubscriptions();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      stopRelaySubscription();
      stopSubscriptions();
      tracker.stop();
    };
  }, [tracker]);

  return (
    <div className="container">
      <Dashboard tracker={tracker} />
      <p style={{ marginTop: 64, textAlign: 'right', fontSize: 10, color: '#ccc' }}>{__COMMIT_HASH__}</p>
    </div>
  );
}

export function App() {
  return (
    <KeyInit>
      <AppContent />
    </KeyInit>
  );
}
