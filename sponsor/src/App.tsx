import { useEffect, useRef } from 'react';
import { KeyInit } from './components/KeyInit';
import { OrderBook } from './components/OrderBook';
import { BtcPrice } from './components/BtcPrice';
import { startOrderSubscription, stopOrderSubscription } from './nostr/service';
import { startCleanup, stopCleanup } from './order-store';
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
    startOrderSubscription();
    startCleanup();
    tracker.start();
    return () => {
      stopRelaySubscription();
      stopOrderSubscription();
      stopCleanup();
      tracker.stop();
    };
  }, [tracker]);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>사줘 트래커</h1>
        <p style={styles.subtitle}>사줘 요청 목록</p>
        <BtcPrice tracker={tracker} />
      </header>
      <main>
        <OrderBook tracker={tracker} />
      </main>
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

const styles = {
  container: {
    maxWidth: 720,
    margin: '0 auto',
    padding: '32px 24px',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  header: {
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: 700 as const,
    color: '#333',
    margin: 0,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    margin: '4px 0 0',
  },
} as const;
