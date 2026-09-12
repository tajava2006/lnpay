import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyInit, BtcPrice, createPriceTracker, subscribeRelayLists, storage } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { startSubscriptions, stopSubscriptions } from './nostr/service';
import { Dashboard } from './buyer/components/Dashboard';
import { startCleanup as startBuyerCleanup, stopCleanup as stopBuyerCleanup } from './buyer/order-store';
import { OrderBook } from './sponsor/components/OrderBook';
import { OrderDetail } from './sponsor/components/OrderDetail';
import { startCleanup as startSponsorCleanup, stopCleanup as stopSponsorCleanup } from './sponsor/order-store';
import { HistoryPage } from './history/HistoryPage';

/**
 * 탭 = 역할 구분.
 *
 * 키는 하나지만 한 사람이 두 역할을 겸하므로, 지금 어느 입장인지는 화면이
 * 책임진다. 합치기 전 앱이 나뉘어 있던 이유가 이 혼동을 막기 위해서였고,
 * 그 역할을 탭이 이어받는다.
 */
type Tab = 'buy' | 'find' | 'history';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'buy', label: '내 주문' },
  { key: 'find', label: '주문 찾기' },
  { key: 'history', label: '내역' },
];

function readTabFromUrl(): Tab {
  const p = new URLSearchParams(window.location.search).get('tab');
  return p === 'find' || p === 'history' ? p : 'buy';
}

function readOrderFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('order');
}

function AppContent() {
  const trackerRef = useRef<PriceTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createPriceTracker();
  }
  const tracker = trackerRef.current;

  const [tab, setTab] = useState<Tab>(readTabFromUrl);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(readOrderFromUrl);

  useEffect(() => {
    const onPop = () => {
      setTab(readTabFromUrl());
      setDetailOrderId(readOrderFromUrl());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const goTab = useCallback((next: Tab) => {
    history.pushState(null, '', next === 'buy' ? '/' : `?tab=${next}`);
    setTab(next);
    setDetailOrderId(null);
  }, []);

  // 상세는 어느 탭에서 들어왔는지 URL에 남긴다 — 뒤로가기 목적지가 갈린다.
  const openDetail = useCallback((orderId: string, from: Tab) => {
    history.pushState(null, '', `?tab=${from}&order=${orderId}`);
    setTab(from);
    setDetailOrderId(orderId);
  }, []);

  const closeDetail = useCallback(() => {
    history.pushState(null, '', tab === 'buy' ? '/' : `?tab=${tab}`);
    setDetailOrderId(null);
  }, [tab]);

  const openFromBook = useCallback((orderId: string) => openDetail(orderId, 'find'), [openDetail]);
  const openFromHistory = useCallback((orderId: string) => openDetail(orderId, 'history'), [openDetail]);

  useEffect(() => {
    const stopRelaySubscription = subscribeRelayLists(storage);
    startSubscriptions();
    startBuyerCleanup();
    startSponsorCleanup();
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
      stopBuyerCleanup();
      stopSponsorCleanup();
      tracker.stop();
    };
  }, [tracker]);

  return (
    <div className="container">
      <header className="header">
        <h1>사줘 트래커</h1>
        <BtcPrice tracker={tracker} />
      </header>

      <nav style={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => goTab(t.key)}
            style={tab === t.key ? { ...styles.tab, ...styles.tabOn } : styles.tab}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {detailOrderId ? (
          <OrderDetail orderId={detailOrderId} onBack={closeDetail} tracker={tracker} />
        ) : tab === 'buy' ? (
          <Dashboard tracker={tracker} />
        ) : tab === 'find' ? (
          <OrderBook tracker={tracker} onSelectOrder={openFromBook} />
        ) : (
          <HistoryPage onSelectOrder={openFromHistory} tracker={tracker} />
        )}
      </main>

      <p style={styles.version}>{__COMMIT_HASH__}</p>
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
  tabs: {
    display: 'flex',
    gap: 4,
    marginBottom: 20,
    borderBottom: '1px solid #E5E7EB',
  },
  tab: {
    padding: '10px 16px',
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'none',
    color: '#6B7280',
    fontSize: 14,
    fontWeight: 500 as const,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  tabOn: {
    color: '#4F46E5',
    borderBottomColor: '#4F46E5',
    fontWeight: 700 as const,
  },
  version: {
    marginTop: 64,
    textAlign: 'right' as const,
    fontSize: 10,
    color: '#ccc',
  },
};
