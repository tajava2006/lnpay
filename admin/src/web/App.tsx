import { useCallback, useEffect, useRef, useState } from 'react';
import { startAdminSubscription, stopAdminSubscription } from './nostr/service';
import { validateAdminKey } from './nostr/keys';
import { OrderQueue } from './components/OrderQueue';
import { OrderClaimList } from './components/OrderClaimList';
import { BtcPrice } from './components/BtcPrice';
import { NodeStatus } from './components/NodeStatus';
import { createPriceTracker } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { createLightningAdapter, createNodeTracker } from './lightning';
import type { NodeTracker } from './lightning';

const keyResult = validateAdminKey();

/** URL search params에서 orderId를 읽는다 */
function getOrderIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('order');
}

export function App() {
  const trackerRef = useRef<PriceTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createPriceTracker();
  }
  const tracker = trackerRef.current;

  // Lightning 노드 트래커 (미설정 시 null)
  const nodeTrackerRef = useRef<NodeTracker | null | undefined>(undefined);
  if (nodeTrackerRef.current === undefined) {
    const adapter = createLightningAdapter();
    nodeTrackerRef.current = adapter ? createNodeTracker(adapter) : null;
  }
  const nodeTracker = nodeTrackerRef.current;

  useEffect(() => {
    if (!keyResult.valid) return;
    startAdminSubscription();
    tracker.start();
    nodeTracker?.start();
    return () => {
      stopAdminSubscription();
      tracker.stop();
      nodeTracker?.stop();
    };
  }, [tracker, nodeTracker]);

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(getOrderIdFromUrl);

  // popstate (브라우저 뒤로가기/앞으로가기) 리스너
  useEffect(() => {
    const handlePopState = () => {
      setSelectedOrderId(getOrderIdFromUrl());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const selectOrder = useCallback((orderId: string) => {
    history.pushState(null, '', `?order=${orderId}`);
    setSelectedOrderId(orderId);
  }, []);

  const goBack = useCallback(() => {
    history.back();
  }, []);

  if (!keyResult.valid) {
    return (
      <div style={styles.container}>
        <div style={styles.errorBox}>
          <h1 style={styles.errorTitle}>키 설정 오류</h1>
          <p style={styles.errorReason}>{keyResult.reason}</p>
          <div style={styles.guide}>
            <p style={styles.guideTitle}>설정 방법:</p>
            <ol style={styles.guideList}>
              <li><code>admin/.env.example</code>을 <code>admin/.env</code>로 복사</li>
              <li><code>VITE_APP_SECRET_KEY</code>에 APP_PUBKEY에 대응하는 개인키(hex) 입력</li>
              <li>개발 서버 재시작 (<code>pnpm dev:admin</code>)</li>
            </ol>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>사줘 트래커 어드민</h1>
        <p style={styles.subtitle}>
          {selectedOrderId ? `주문 #${selectedOrderId} 클레임` : '클레임 대기열'}
        </p>
        <BtcPrice tracker={tracker} />
        {nodeTracker && <NodeStatus tracker={nodeTracker} />}
      </header>
      <main>
        {selectedOrderId ? (
          <OrderClaimList
            orderId={selectedOrderId}
            onBack={goBack}
          />
        ) : (
          <OrderQueue onSelectOrder={selectOrder} />
        )}
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
  errorBox: {
    marginTop: 80,
    padding: '32px 40px',
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: 12,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: 700 as const,
    color: '#991B1B',
    margin: '0 0 12px',
  },
  errorReason: {
    fontSize: 14,
    color: '#B91C1C',
    whiteSpace: 'pre-wrap' as const,
    margin: '0 0 24px',
    lineHeight: 1.6,
  },
  guide: {
    background: '#fff',
    borderRadius: 8,
    padding: '16px 20px',
  },
  guideTitle: {
    fontSize: 14,
    fontWeight: 600 as const,
    color: '#333',
    margin: '0 0 8px',
  },
  guideList: {
    fontSize: 13,
    color: '#555',
    lineHeight: 2,
    margin: 0,
    paddingLeft: 20,
  },
} as const;
