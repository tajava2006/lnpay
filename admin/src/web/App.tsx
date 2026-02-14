import { useEffect } from 'react';
import { startAdminSubscription, stopAdminSubscription } from './nostr/service';
import { ClaimInbox } from './components/ClaimInbox';

export function App() {
  useEffect(() => {
    startAdminSubscription();
    return () => stopAdminSubscription();
  }, []);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>사줘 트래커 어드민</h1>
        <p style={styles.subtitle}>클레임 대기열</p>
      </header>
      <main>
        <ClaimInbox />
      </main>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 800,
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
