import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BtcPrice, createPriceTracker, ErrorBoundary, KeyInit, storage, subscribeRelayLists, type PriceTracker,
} from '@sajwo-tracker/shared';
import { useMyPubkey } from './hooks';
import { startSubscriptions, stopSubscriptions } from './nostr/service';
import { Dashboard } from './buyer/components/Dashboard';
import { startCleanup as startBuyerCleanup, stopCleanup as stopBuyerCleanup } from './buyer/order-store';
import { OrderBook } from './sponsor/components/OrderBook';
import { LnOrderDetail } from './ln/LnOrderDetail';
import { startCleanup as startSponsorCleanup, stopCleanup as stopSponsorCleanup } from './sponsor/order-store';
import { HistoryPage } from './history/HistoryPage';
import { OnchainOrderBook } from './onchain/components/OnchainOrderBook';
import { OnchainOrderForm } from './onchain/components/OnchainOrderForm';
import { OnchainMyOrders } from './onchain/components/OnchainMyOrders';
import { OnchainOrderDetail } from './onchain/components/OnchainOrderDetail';
import { startOnchainSubscriptions, stopOnchainSubscriptions } from './onchain/nostr/service';
import { NotifySetup } from './components/NotifySetup';
import { KeyManager } from './components/KeyManager';
import { parseRoute, urlFor, type Tab, type Track } from './routing';

/**
 * 거래 방법 = 최상위 선택.
 *
 * 라이트닝과 온체인은 **동등한 거래 방법**이다. 한쪽을 다른 쪽의 탭 하나로
 * 넣으면 층위가 어긋나고(온체인이 라이트닝의 하위처럼 보인다), 무엇보다
 * 두 트랙의 화면 구조가 달라져 옮겨 다닐 때마다 다시 배워야 한다.
 *
 * 그래서 **트랙을 위에 두고 탭 구조를 양쪽이 공유한다.** 이름만 트랙에 맞게 바꾼다.
 * 주소 규칙은 `routing.ts`가 진실이다.
 */
const TRACKS: Array<{ key: Track; label: string }> = [
  { key: 'ln', label: '라이트닝' },
  { key: 'onchain', label: '온체인' },
];

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
const TAB_LABELS: Record<Track, Record<Tab, string>> = {
  ln: { request: '의뢰하기', fulfill: '사주기', history: '내 거래' },
  onchain: { request: '팔기', fulfill: '사기', history: '내 거래' },
};

const TAB_ORDER: Tab[] = ['request', 'fulfill', 'history'];

const readTrackFromUrl = () => parseRoute(window.location.search).track;
const readTabFromUrl = () => parseRoute(window.location.search).tab;
const readOrderFromUrl = () => parseRoute(window.location.search).orderId;

function AppContent() {
  const trackerRef = useRef<PriceTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createPriceTracker();
  }
  const tracker = trackerRef.current;

  const [track, setTrack] = useState<Track>(readTrackFromUrl);
  const [tab, setTab] = useState<Tab>(readTabFromUrl);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(readOrderFromUrl);
  // 내 pubkey — 온체인 카드의 역할 판정에 쓴다. 로딩 전엔 null
  const myPubkey = useMyPubkey();
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);

  useEffect(() => {
    const onPop = () => {
      setTrack(readTrackFromUrl());
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
      setTrack(readTrackFromUrl());
      setTab(readTabFromUrl());
      setDetailOrderId(readOrderFromUrl());
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  const goTab = useCallback((next: Tab) => {
    history.pushState(null, '', urlFor(track, next));
    setTab(next);
    setDetailOrderId(null);
  }, [track]);

  /**
   * 트랙을 바꿔도 **보던 탭은 유지한다** — 두 트랙이 같은 탭 구조라
   * "팔던 자리에서 팔던 자리로" 넘어가는 게 자연스럽다.
   */
  const goTrack = useCallback((next: Track) => {
    history.pushState(null, '', urlFor(next, tab));
    setTrack(next);
    setDetailOrderId(null);
  }, [tab]);

  // 상세는 어느 트랙·탭에서 들어왔는지 URL에 남긴다 — 새로고침해도 그 자리고,
  // 뒤로가기 목적지도 갈린다.
  const openDetail = useCallback((orderId: string, from: Tab) => {
    history.pushState(null, '', urlFor(track, from, orderId));
    setTab(from);
    setDetailOrderId(orderId);
  }, [track]);

  const closeDetail = useCallback(() => {
    history.pushState(null, '', urlFor(track, tab));
    setDetailOrderId(null);
  }, [track, tab]);

  const openFromRequests = useCallback((orderId: string) => openDetail(orderId, 'request'), [openDetail]);
  const openFromBook = useCallback((orderId: string) => openDetail(orderId, 'fulfill'), [openDetail]);
  const openFromHistory = useCallback((orderId: string) => openDetail(orderId, 'history'), [openDetail]);

  useEffect(() => {
    const stopRelaySubscription = subscribeRelayLists(storage);
    void startSubscriptions(); // 가드가 안에서 잡는다
    // 온체인은 `t` 태그가 달라 **소켓을 따로 연다**. 섞으면 구버전
    // 클라이언트가 온체인 오더를 라이트닝으로 렌더링하는 사고가 재현된다.
    void startOnchainSubscriptions();
    startBuyerCleanup();
    startSponsorCleanup();
    tracker.start();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        stopSubscriptions();
        void startSubscriptions();
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
          <button
            onClick={() => setKeyOpen(true)}
            style={styles.bell}
            title="내 키 — 보관하기 · 다른 기기로 옮기기"
            aria-label="내 키"
          >
            🔑
          </button>
        </div>
      </header>

      {notifyOpen && <NotifySetup onClose={() => setNotifyOpen(false)} />}
      {keyOpen && <KeyManager onClose={() => setKeyOpen(false)} />}

      <nav style={styles.tracks}>
        {TRACKS.map(t => (
          <button
            key={t.key}
            onClick={() => goTrack(t.key)}
            style={track === t.key ? { ...styles.track, ...styles.trackOn } : styles.track}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <nav style={styles.tabs}>
        {TAB_ORDER.map(key => (
          <button
            key={key}
            onClick={() => goTab(key)}
            style={tab === key ? { ...styles.tab, ...styles.tabOn } : styles.tab}
          >
            {TAB_LABELS[track][key]}
          </button>
        ))}
      </nav>

      {/* 화면 단위 경계 — 헤더(🔑 키 보기)는 밖에 둔다. 주소가 바뀌면 key가 바뀌어 새로 그린다 */}
      <main>
        <ErrorBoundary key={`${track}:${tab}:${detailOrderId ?? ''}`} label="이 화면">
          {track === 'onchain' ? (
            detailOrderId ? (
              <OnchainOrderDetail
                orderId={detailOrderId}
                myPubkey={myPubkey}
                onBack={closeDetail}
                tracker={tracker}
              />
            ) : tab === 'request' ? (
              <OnchainOrderForm onDone={() => goTab('history')} tracker={tracker} />
            ) : tab === 'fulfill' ? (
              <OnchainOrderBook myPubkey={myPubkey} tracker={tracker} />
            ) : (
              <OnchainMyOrders myPubkey={myPubkey} onSelectOrder={openFromHistory} />
            )
          ) : detailOrderId ? (
            <LnOrderDetail orderId={detailOrderId} onBack={closeDetail} tracker={tracker} />
          ) : tab === 'request' ? (
            <Dashboard tracker={tracker} onSelectOrder={openFromRequests} />
          ) : tab === 'fulfill' ? (
            <OrderBook tracker={tracker} onSelectOrder={openFromBook} />
          ) : (
            <HistoryPage onSelectOrder={openFromHistory} tracker={tracker} />
          )}
        </ErrorBoundary>
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
  tracks: {
    display: 'flex', gap: 6, marginBottom: 8,
    background: '#F3F4F6', borderRadius: 10, padding: 4,
  },
  track: {
    flex: 1, padding: '9px 0', fontSize: 14, fontWeight: 600 as const,
    background: 'transparent', color: '#6B7280', border: 'none',
    borderRadius: 8, cursor: 'pointer',
  },
  trackOn: { background: '#fff', color: '#111827', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
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
