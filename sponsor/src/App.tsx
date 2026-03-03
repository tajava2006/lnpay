import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyInit } from './components/KeyInit';
import { OrderBook } from './components/OrderBook';
import { HistoryPage } from './components/HistoryPage';
import { OrderDetail } from './components/OrderDetail';
import { BtcPrice } from './components/BtcPrice';
import { startOrderSubscription, stopOrderSubscription } from './nostr/service';
import { startCleanup, stopCleanup } from './order-store';
import { createPriceTracker, subscribeRelayLists } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { storage } from './nostr/storage';

/** URL search params에서 page를 읽는다 */
function getPageFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('page');
}

/** URL search params에서 orderId를 읽는다 */
function getOrderIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('order');
}

function AppContent() {
  const trackerRef = useRef<PriceTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createPriceTracker();
  }
  const tracker = trackerRef.current;

  const [currentPage, setCurrentPage] = useState<string | null>(getPageFromUrl);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(getOrderIdFromUrl);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPage(getPageFromUrl());
      setSelectedOrderId(getOrderIdFromUrl());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const goHistory = useCallback(() => {
    history.pushState(null, '', '?page=history');
    setCurrentPage('history');
    setSelectedOrderId(null);
  }, []);

  const goHome = useCallback(() => {
    history.pushState(null, '', '/');
    setCurrentPage(null);
    setSelectedOrderId(null);
  }, []);

  const selectOrderDetail = useCallback((orderId: string) => {
    history.pushState(null, '', `?page=detail&order=${orderId}`);
    setCurrentPage('detail');
    setSelectedOrderId(orderId);
  }, []);

  const goBack = useCallback(() => {
    history.back();
  }, []);

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
        <div style={styles.titleRow}>
          <h1 style={styles.title}>사줘 트래커</h1>
          <button style={styles.navBtn} onClick={goHistory}>
            히스토리
          </button>
        </div>
        <p style={styles.subtitle}>
          {currentPage === 'detail' && selectedOrderId
            ? `주문 #${selectedOrderId} 상세`
            : currentPage === 'history'
              ? '거래 이력'
              : '사줘 요청 목록'}
        </p>
        <BtcPrice tracker={tracker} />
      </header>
      <main>
        {currentPage === 'detail' && selectedOrderId ? (
          <OrderDetail
            orderId={selectedOrderId}
            onBack={goBack}
            tracker={tracker}
          />
        ) : currentPage === 'history' ? (
          <HistoryPage
            onSelectOrder={selectOrderDetail}
            onBack={goHome}
            tracker={tracker}
          />
        ) : (
          <OrderBook tracker={tracker} />
        )}
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
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
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
  navBtn: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#4F46E5',
    background: '#EEF2FF',
    border: '1px solid #C7D2FE',
    borderRadius: 6,
    cursor: 'pointer' as const,
  },
} as const;
