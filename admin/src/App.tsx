/**
 * 어드민 — 데몬 리모컨
 *
 * 판단과 집행은 운영 PC의 데몬이 한다. 이 앱은 **운영자 키로 로그인해 명령을 보내고, 데몬이 돌려주는
 * 상태를 보여줄 뿐**이다. 그래서 몇 기기에서 열어도 서로 꼬이지 않는다 — 여기에는 APP 키도 LN 자격증명도
 * 집행 코드도 없다(DM-001).
 */
import { useCallback, useEffect, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { storage, subscribeRelayLists } from '@sajwo-tracker/shared';
import { clearSession, loadSession, restoreSigner } from './nostr/nip46';
import { LoginScreen } from './components/LoginScreen';
import { DaemonPanel } from './components/DaemonPanel';
import { LnOrderDetail } from './components/LnOrderDetail';
import { OnchainOrderDetail } from './components/OnchainOrderDetail';
import { LnOrderList, OnchainOrderList } from './components/OrderLists';
import { startDaemonFeed, stopDaemonFeed } from './daemon/feed';
import { clearStores } from './daemon/stores';
import { parseRoute, urlFor, type Route, type Tab } from './routing';

/** 저장된 세션을 되살린다. 운영자 pubkey가 없는 옛 세션(APP 키 로그인 시절)은 버린다 */
function restoreOperator(): string | null {
  const session = loadSession();
  if (!session?.operatorPubkey) {
    clearSession();
    return null;
  }
  restoreSigner(session);
  return session.operatorPubkey;
}

export function App() {
  const [operator, setOperator] = useState<string | null>(restoreOperator);
  // 화면 = 주소. 새로고침·뒤로가기·링크가 같은 자리로 온다 (routing.ts)
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));
  const go = useCallback((next: Route) => {
    history.pushState(null, '', urlFor(next));
    setRoute(next);
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const { tab, orderId } = route;
  const goTab = (next: Tab) => go({ tab: next, orderId: null });
  const select = (id: string) => go({ tab, orderId: id });
  const back = () => go({ tab, orderId: null });

  useEffect(() => subscribeRelayLists(storage), []);

  useEffect(() => {
    if (!operator) return;
    void startDaemonFeed(operator);
    // 백그라운드에서 조용히 죽은 소켓을 되살린다 — 화면이 다시 보일 때 구독을 새로 연다
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      stopDaemonFeed();
      void startDaemonFeed(operator);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      stopDaemonFeed();
    };
  }, [operator]);

  const logout = useCallback(() => {
    stopDaemonFeed();
    clearSession();
    clearStores();
    setOperator(null);
  }, []);

  if (!operator) return <LoginScreen onLogin={setOperator} />;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>페어바이 어드민</h1>
          <p style={styles.sub}>데몬 리모컨 · 운영자 {nip19.npubEncode(operator).slice(0, 16)}…</p>
        </div>
        <button style={styles.logout} onClick={logout}>로그아웃</button>
      </header>
      <nav style={styles.tabs}>
        {([['daemon', '데몬'], ['ln', '라이트닝'], ['onchain', '온체인']] as const).map(([key, label]) => (
          <button key={key} style={{ ...styles.tab, ...(tab === key ? styles.tabActive : {}) }} onClick={() => goTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'daemon' && <DaemonPanel />}
        {tab === 'ln' && (orderId
          ? <LnOrderDetail key={orderId} orderId={orderId} onBack={back} />
          : <LnOrderList onSelect={select} />)}
        {tab === 'onchain' && (orderId
          ? <OnchainOrderDetail key={orderId} orderId={orderId} onBack={back} />
          : <OnchainOrderList onSelect={select} />)}
      </main>
    </div>
  );
}

const styles = {
  page: { maxWidth: 900, margin: '0 auto', padding: '24px 16px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  title: { fontSize: 22, margin: 0, color: '#333' },
  sub: { fontSize: 12, color: '#6B7280', margin: '4px 0 0' },
  logout: { padding: '6px 12px', fontSize: 12, background: '#fff', color: '#6B7280', border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { padding: '8px 16px', fontSize: 14, background: '#fff', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 8, cursor: 'pointer' },
  tabActive: { background: '#4F46E5', color: '#fff', borderColor: '#4F46E5' },
};
