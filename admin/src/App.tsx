import { useCallback, useEffect, useRef, useState } from 'react';
import { startAdminSubscription, stopAdminSubscription } from './nostr/service';
import {
  hasSession, loadSession, restoreSigner, clearSession,
} from './nostr/nip46';
import { LoginScreen } from './components/LoginScreen';
import { OrderQueue } from './components/OrderQueue';
import { OrderClaimList } from './components/OrderClaimList';
import { BtcPrice } from './components/BtcPrice';
import { NodeStatus } from './components/NodeStatus';
import { createPriceTracker } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { createLightningAdapter, createNodeTracker } from './lightning';
import type { LightningAdapter, NodeTracker } from './lightning';

type AuthState = 'checking' | 'logged-out' | 'logged-in';

/** URL search params에서 orderId를 읽는다 */
function getOrderIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('order');
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');

  // ─── 싱글턴 인스턴스 (렌더 시 1회 생성) ───────────

  const trackerRef = useRef<PriceTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createPriceTracker();
  }
  const tracker = trackerRef.current;

  // Lightning 어댑터 + 노드 트래커 (미설정 시 null)
  const adapterRef = useRef<LightningAdapter | null>(null);
  const nodeTrackerRef = useRef<NodeTracker | null | undefined>(undefined);
  if (nodeTrackerRef.current === undefined) {
    const adapter = createLightningAdapter();
    adapterRef.current = adapter;
    nodeTrackerRef.current = adapter ? createNodeTracker(adapter) : null;
  }
  const lnAdapter = adapterRef.current;
  const nodeTracker = nodeTrackerRef.current;

  // ─── 구독 독립화: 로그인 여부와 무관하게 즉시 시작 ──

  useEffect(() => {
    startAdminSubscription();
    tracker.start();
    return () => {
      stopAdminSubscription();
      tracker.stop();
    };
  }, [tracker]);

  // ─── NIP-46 세션 체크 ─────────────────────────────

  useEffect(() => {
    if (!hasSession()) {
      setAuthState('logged-out');
      return;
    }

    const session = loadSession();
    if (!session) {
      clearSession();
      setAuthState('logged-out');
      return;
    }

    // 세션이 존재하면 통신 채널만 복원하고 바로 로그인 상태로 전이
    // (신원 검증은 최초 로그인 시에만 수행)
    restoreSigner(session);
    setAuthState('logged-in');
  }, []);

  // ─── Lightning 노드 트래커: 로그인 후 시작 ─────────

  useEffect(() => {
    if (authState !== 'logged-in') return;
    nodeTracker?.start();
    return () => { nodeTracker?.stop(); };
  }, [authState, nodeTracker]);

  // ─── 네비게이션 ────────────────────────────────────

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(getOrderIdFromUrl);

  // popstate (브라우저 뒤로가기/앞으로가기) 리스너
  useEffect(() => {
    const handlePopState = () => setSelectedOrderId(getOrderIdFromUrl());
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

  const handleLogin = useCallback(() => {
    setAuthState('logged-in');
  }, []);

  // ─── 렌더링 ────────────────────────────────────────

  if (authState === 'checking') {
    return (
      <div style={styles.container}>
        <p style={styles.loading}>세션 확인 중...</p>
      </div>
    );
  }

  if (authState === 'logged-out') {
    return <LoginScreen onLogin={handleLogin} />;
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
            tracker={tracker}
            lnAdapter={lnAdapter}
          />
        ) : (
          <OrderQueue onSelectOrder={selectOrder} tracker={tracker} />
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
  loading: {
    textAlign: 'center' as const,
    padding: 80,
    color: '#999',
    fontSize: 14,
  },
} as const;
