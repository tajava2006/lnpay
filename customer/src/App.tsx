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
import { OnchainPage } from './onchain/components/OnchainPage';
import { startOnchainSubscriptions, stopOnchainSubscriptions } from './onchain/nostr/service';
import { NotifySetup } from './components/NotifySetup';

/**
 * 탭 = 역할 구분.
 *
 * 키는 하나지만 한 사람이 두 역할을 겸하므로, 지금 어느 입장인지는 화면이
 * 책임진다. 합치기 전 앱이 나뉘어 있던 이유가 이 혼동을 막기 위해서였고,
 * 그 역할을 탭이 이어받는다.
 *
 * 라벨을 동사형으로 둔 이유: "내 주문"처럼 명사로 두면 후원자가 자기 BTC
 * 구매를 '주문'으로 여겨 엉뚱한 탭을 찾는다(실제 혼동 사례). 각 탭이
 * "여기서 당신이 무엇을 하는가"를 말하면 그 오해가 구조적으로 사라진다.
 */
type Tab = 'request' | 'fulfill' | 'onchain' | 'history';

/** 첫 화면. 신규 유입 대부분이 후원자 입장이라 오더북을 먼저 보여준다. */
const DEFAULT_TAB: Tab = 'fulfill';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'request', label: '의뢰하기' },
  { key: 'fulfill', label: '사주기' },
  // 온체인은 **별도 탭**이다(PLAN-ONCHAIN-TRACK §1.2) — 플로우가 완전히 다르고,
  // 라이트닝 트랙을 안 건드리고 붙였다 뗐다 할 수 있어야 한다.
  { key: 'onchain', label: '온체인' },
  { key: 'history', label: '내 거래' },
];

function readTabFromUrl(): Tab {
  const p = new URLSearchParams(window.location.search).get('tab');
  return p === 'request' || p === 'fulfill' || p === 'onchain' || p === 'history'
    ? p : DEFAULT_TAB;
}

/** 기본 탭은 쿼리 없이 루트로 둔다. */
function urlForTab(tab: Tab): string {
  return tab === DEFAULT_TAB ? '/' : `?tab=${tab}`;
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
  const [notifyOpen, setNotifyOpen] = useState(false);

  useEffect(() => {
    const onPop = () => {
      setTab(readTabFromUrl());
      setDetailOrderId(readOrderFromUrl());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 알림 클릭 → 서비스워커가 목적지를 알려준다.
  //
  // 서비스워커가 직접 이동시키면(client.navigate) 페이지가 통째로 다시 읽혀
  // 쓰던 입력이 날아간다. 그래서 주소만 받아 앱 안에서 라우팅한다 —
  // popstate와 같은 경로를 타므로 뒤로가기 동작도 그대로다.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type !== 'pairbuy-navigate' || typeof data.url !== 'string') return;

      history.pushState(null, '', data.url);
      setTab(readTabFromUrl());
      setDetailOrderId(readOrderFromUrl());
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  const goTab = useCallback((next: Tab) => {
    history.pushState(null, '', urlForTab(next));
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
    history.pushState(null, '', urlForTab(tab));
    setDetailOrderId(null);
  }, [tab]);

  const openFromBook = useCallback((orderId: string) => openDetail(orderId, 'fulfill'), [openDetail]);
  const openFromHistory = useCallback((orderId: string) => openDetail(orderId, 'history'), [openDetail]);

  useEffect(() => {
    const stopRelaySubscription = subscribeRelayLists(storage);
    startSubscriptions();
    // 온체인은 `t` 태그가 달라 **소켓을 따로 연다**(§1.3). 섞으면 구버전
    // 클라이언트가 온체인 오더를 라이트닝으로 렌더링하는 사고가 재현된다.
    void startOnchainSubscriptions();
    startBuyerCleanup();
    startSponsorCleanup();
    tracker.start();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        stopSubscriptions();
        startSubscriptions();
        stopOnchainSubscriptions();
        void startOnchainSubscriptions();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      stopRelaySubscription();
      stopSubscriptions();
      stopOnchainSubscriptions();
      stopBuyerCleanup();
      stopSponsorCleanup();
      tracker.stop();
    };
  }, [tracker]);

  return (
    <div className="container">
      <header className="header">
        <h1>페어바이</h1>
        <div style={styles.headerRight}>
          <BtcPrice tracker={tracker} />
          <button
            onClick={() => setNotifyOpen(true)}
            style={styles.bell}
            title="거래 알림 받기"
            aria-label="거래 알림 받기"
          >
            🔔
          </button>
        </div>
      </header>

      {notifyOpen && <NotifySetup onClose={() => setNotifyOpen(false)} />}

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
        ) : tab === 'request' ? (
          <Dashboard tracker={tracker} />
        ) : tab === 'fulfill' ? (
          <OrderBook tracker={tracker} onSelectOrder={openFromBook} />
        ) : tab === 'onchain' ? (
          <OnchainPage />
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
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  bell: {
    border: 'none',
    background: 'none',
    fontSize: 18,
    cursor: 'pointer' as const,
    padding: 4,
    lineHeight: 1,
  },
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
