import { useEffect } from 'react';
import { KeyInit } from './components/KeyInit';
import { OrderBook } from './components/OrderBook';
import { startOrderSubscription, stopOrderSubscription } from './nostr/service';

function AppContent() {
  useEffect(() => {
    startOrderSubscription();
    return () => stopOrderSubscription();
  }, []);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>사줘 트래커</h1>
        <p style={styles.subtitle}>사줘 요청 목록</p>
      </header>
      <main>
        <OrderBook />
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
