import { useEffect, useRef } from 'react';
import { KeyInit } from './components/KeyInit';
import { Dashboard } from './components/Dashboard';
import { startAdminSubscription, stopAdminSubscription } from './nostr/service';
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
    startAdminSubscription();
    tracker.start();

    return () => {
      stopRelaySubscription();
      stopAdminSubscription();
      tracker.stop();
    };
  }, [tracker]);

  return (
    <div className="container">
      <Dashboard tracker={tracker} />
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
