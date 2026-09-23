import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startAdminSubscription, stopAdminSubscription, setLnAdapter, setPriceTracker } from './nostr/service';
import {
  hasSession, loadSession, restoreSigner, clearSession,
} from './nostr/nip46';
import { startLnConfigSubscription, stopLnConfigSubscription, decryptLnConfig } from './nostr/ln-config-service';
import { startCleanup, stopCleanup } from './cleanup';
import { startInvoiceWatcher, stopInvoiceWatcher } from './invoice-watcher';
import { cacheLnConfig, loadCachedLnConfig, clearCachedLnConfig, publishLnConfig, type LnConfig } from './nostr/ln-config';
import { initEscrowCache, mergeRestoredEntries } from './escrow-store';
import { fetchEscrowBackup } from './nostr/escrow-backup';
import { LoginScreen } from './components/LoginScreen';
import { LnConfigPage } from './components/LnConfigPage';
import { getVapidPrivateKey, restoreVapidPrivateKey, discardVapidKeyIfMismatched } from './web-push/vapid-store';
import { OrderQueue } from './components/OrderQueue';
import { OnchainPanel } from './components/OnchainPanel';
import { OnchainConfig } from './components/OnchainConfig';
import { startOnchainTrack, stopOnchainTrack } from './onchain/runtime';
import { getOnchainBaseUrl, getOnchainNetwork, isOnchainEnabled } from './onchain/config';
import { OrderClaimList } from './components/OrderClaimList';
import { HistoryPage } from './components/HistoryPage';
import { OrderDetail } from './components/OrderDetail';
import { NodeStatus } from './components/NodeStatus';
import { getCustomerDepositPercent, setCustomerDepositPercent, getSponsorDepositPercent, setSponsorDepositPercent, restoreDepositSettings } from './deposit-config';
import { restorePendingDeposits } from './pending-deposit-store';
import { isAutoApproveEnabled, setAutoApproveEnabled } from './auto-approve';
import { purgeSubscriptionsIfKeyChanged } from './web-push/store';
import { BtcPrice, createPriceTracker, freshPrice, subscribeRelayLists, storage } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { createLightningAdapter, createNodeTracker } from './lightning';
import type { LightningAdapter, NodeTracker } from './lightning';

type AuthState = 'checking' | 'logged-out' | 'logged-in';

/** URL search params에서 orderId를 읽는다 */
function getOrderIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('order');
}

/** URL search params에서 page를 읽는다 */
function getPageFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('page');
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [customerDepositPct, setCustomerDepositPct] = useState(getCustomerDepositPercent);
  const [sponsorDepositPct, setSponsorDepositPct] = useState(getSponsorDepositPercent);

  // ─── 싱글턴 인스턴스 (렌더 시 1회 생성) ───────────

  const trackerRef = useRef<PriceTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createPriceTracker();
  }
  const tracker = trackerRef.current;

  // ─── LN 설정 (sessionStorage 캐시 + 메모리) ───────

  // 릴레이에서 받은 암호화된 NIP-78 content (로그인 전에 도착 가능)
  const [encryptedLnConfig, setEncryptedLnConfig] = useState<string | null>(null);
  // 복호화된 LN 설정 (sessionStorage 캐시에서 즉시 복원, 없으면 릴레이 구독으로 수신)
  const [lnConfig, setLnConfig] = useState<LnConfig | null>(loadCachedLnConfig);
  // 세션당 1회만 재브로드캐스트 (구독 에코 → 무한 루프 방지)
  const lnConfigBroadcastedRef = useRef(false);
  // LN 설정 페이지 표시 여부
  const [showLnConfig, setShowLnConfig] = useState(false);
  // 설정 화면을 다녀오면 다시 읽는다 — 거기서 입력했을 수 있다.
  const [pushKeyOk, setPushKeyOk] = useState(() => !!getVapidPrivateKey());
  // 판단이 필요 없는 유일한 블로커를 자동으로 넘긴다. 기본 켜짐.
  const [autoApprove, setAutoApprove] = useState(isAutoApproveEnabled);

  // ─── LN 어댑터 + 노드 트래커 (lnConfig 의존) ─────

  // 설정이 바뀌면 트랙을 다시 띄운다 (네트워크·엔드포인트가 생성자 인자라서)
  const [onchainEpoch, setOnchainEpoch] = useState(0);

  const lnAdapter: LightningAdapter | null = useMemo(() => {
    if (!lnConfig) return null;
    return createLightningAdapter(lnConfig);
  }, [lnConfig]);

  const [nodeTracker, setNodeTracker] = useState<NodeTracker | null>(null);

  // lnAdapter 변경 시 이전 tracker 중지 + 새로 생성
  useEffect(() => {
    if (!lnAdapter) {
      setNodeTracker(null);
      setLnAdapter(null);
      stopInvoiceWatcher();
      return;
    }

    const nt = createNodeTracker(lnAdapter);
    setNodeTracker(nt);
    setLnAdapter(lnAdapter);
    startInvoiceWatcher(lnAdapter);

    // 로그인 상태이면 즉시 시작
    if (authState === 'logged-in') {
      nt.start();
    }

    return () => {
      nt.stop();
      stopInvoiceWatcher();
    };
  }, [lnAdapter]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 온체인 트랙 — **켜져 있을 때만** 돈다 (PLAN-ONCHAIN-TRACK §1.2).
   *
   * 라이트닝 트랙은 지금 실제 돈이 돌고 있으므로, 온체인이 켜지든 꺼지든
   * 거기에 영향이 없어야 한다. 로그인·LN 어댑터가 둘 다 준비돼야 시작한다 —
   * 서명(NIP-46)과 보증금 인보이스가 없으면 아무 단계도 못 지나간다.
   */
  useEffect(() => {
    if (authState !== 'logged-in' || !lnAdapter || !isOnchainEnabled()) {
      stopOnchainTrack();
      return;
    }
    void startOnchainTrack({
      lnAdapter,
      // ⚠️ **신선한 가격만** — 끊긴 거래소의 마지막 값은 몇 시간 전 것일 수 있다(리뷰 #8).
      btcPriceKrw: () => freshPrice(tracker.getSnapshot(), Date.now()) ?? undefined,
      network: getOnchainNetwork(),
      chainBaseUrl: getOnchainBaseUrl(),
    });
    return () => stopOnchainTrack();
  }, [authState, lnAdapter, onchainEpoch, tracker]);

  // 로그인 상태 변경 시 기존 tracker 시작/중지
  useEffect(() => {
    if (authState === 'logged-in') {
      nodeTracker?.start();
    } else {
      nodeTracker?.stop();
    }
  }, [authState, nodeTracker]);

  // ─── 구독 독립화: 로그인 여부와 무관하게 즉시 시작 ──

  useEffect(() => {
    const stopRelaySubscription = subscribeRelayLists(storage);
    startAdminSubscription();
    startLnConfigSubscription(setEncryptedLnConfig);
    startCleanup();
    setPriceTracker(tracker);
    tracker.start();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        stopAdminSubscription();
        startAdminSubscription();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      stopRelaySubscription();
      stopAdminSubscription();
      stopLnConfigSubscription();
      stopCleanup();
      setPriceTracker(null);
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

  // ─── 로그인 시 escrow 캐시 초기화 + 릴레이 복원 ───

  useEffect(() => {
    if (authState !== 'logged-in') return;

    let cancelled = false;

    void (async () => {
      try {
        await initEscrowCache();
        if (cancelled) return;

        // 릴레이 백업에서 로컬에 없는 엔트리 복원
        const restored = await fetchEscrowBackup();
        if (!cancelled && Object.keys(restored).length > 0) {
          await mergeRestoredEntries(restored);
        }

        // 다기기 운영을 위한 나머지 로컬 전용 상태 복원.
        // 오더·요청은 릴레이 이벤트로 재구성되지만 이 둘은 그럴 수 없다.
        if (cancelled) return;
        await restorePendingDeposits();

        // 다른 어드민 기기에서 입력한 푸시 키를 넘겨받는다.
        // 설정 화면을 열지 않아도 복원돼야 한다 — 안 그러면 그 기기에서만
        // 알림이 조용히 안 나간다.
        if (cancelled) return;
        // 공개키가 바뀌었으면 옛 구독은 전부 403이 된다. 먼저 비운다.
        purgeSubscriptionsIfKeyChanged();
        await discardVapidKeyIfMismatched();
        await restoreVapidPrivateKey();
        if (!cancelled) setPushKeyOk(!!getVapidPrivateKey());

        if (cancelled) return;
        // 전역 설정이라 원격이 우선이다. 복원되면 화면 값도 맞춰준다.
        if (await restoreDepositSettings() && !cancelled) {
          setCustomerDepositPct(getCustomerDepositPercent());
          setSponsorDepositPct(getSponsorDepositPercent());
        }
      } catch (e) {
        console.warn('[App] Escrow cache init failed:', e);
      }
    })();

    return () => { cancelled = true; };
  }, [authState]);

  // ─── 로그인 + 암호화 config 둘 다 준비되면 복호화 ───

  useEffect(() => {
    if (authState !== 'logged-in' || !encryptedLnConfig) return;

    let cancelled = false;
    void decryptLnConfig(encryptedLnConfig).then((config: LnConfig) => {
      if (!cancelled) {
        // 내용이 같으면 이전 참조 유지 → useMemo/useEffect 재실행 방지
        setLnConfig(prev => {
          if (prev && prev.backend === config.backend && prev.baseUrl === config.baseUrl && prev.credential === config.credential) {
            return prev;
          }
          cacheLnConfig(config);
          console.log('[App] LN config decrypted:', config.backend, config.baseUrl);
          return config;
        });
        // 쓰기 릴레이 전체에 재브로드캐스트 (릴레이 데이터 유실 방어, 내용 변경 여부와 무관)
        // 세션당 1회만 실행 (구독 에코로 인한 무한 루프 방지)
        if (!lnConfigBroadcastedRef.current) {
          lnConfigBroadcastedRef.current = true;
          void publishLnConfig(config).catch((err: unknown) => {
            console.warn('[App] LN config re-broadcast failed:', err);
          });
        }
      }
    }).catch((err: unknown) => {
      console.warn('[App] LN config decryption failed:', err);
    });

    return () => { cancelled = true; };
  }, [authState, encryptedLnConfig]);

  // ─── 로그아웃 시 캐시 정리 ──────────────────────────

  useEffect(() => {
    if (authState === 'logged-out') clearCachedLnConfig();
  }, [authState]);

  // ─── 네비게이션 ────────────────────────────────────

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(getOrderIdFromUrl);
  const [currentPage, setCurrentPage] = useState<string | null>(getPageFromUrl);

  // popstate (브라우저 뒤로가기/앞으로가기) 리스너
  useEffect(() => {
    const handlePopState = () => {
      setSelectedOrderId(getOrderIdFromUrl());
      setCurrentPage(getPageFromUrl());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const selectOrder = useCallback((orderId: string) => {
    history.pushState(null, '', `?order=${orderId}`);
    setSelectedOrderId(orderId);
    setCurrentPage(null);
  }, []);

  const selectOrderDetail = useCallback((orderId: string) => {
    history.pushState(null, '', `?page=detail&order=${orderId}`);
    setCurrentPage('detail');
    setSelectedOrderId(orderId);
  }, []);

  const goHistory = useCallback(() => {
    history.pushState(null, '', '?page=history');
    setCurrentPage('history');
    setSelectedOrderId(null);
  }, []);

  const goQueue = useCallback(() => {
    history.pushState(null, '', '/');
    setCurrentPage(null);
    setSelectedOrderId(null);
  }, []);

  const handleLogin = useCallback(() => {
    setAuthState('logged-in');
  }, []);

  const handleLnConfigSave = useCallback((config: LnConfig) => {
    setLnConfig(config);
    cacheLnConfig(config);
    setShowLnConfig(false);
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

  if (showLnConfig) {
    return (
      <div style={styles.container}>
        <LnConfigPage
          onSave={handleLnConfigSave}
          onBack={() => {
            setPushKeyOk(!!getVapidPrivateKey());
            setShowLnConfig(false);
          }}
        />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>페어바이 어드민</h1>
          <button
            style={currentPage !== 'history' && currentPage !== 'detail' ? styles.navBtnActive : styles.navBtn}
            onClick={goQueue}
          >
            오더북
          </button>
          <button
            style={currentPage === 'history' || currentPage === 'detail' ? styles.navBtnActive : styles.navBtn}
            onClick={goHistory}
          >
            주문 히스토리
          </button>
          <button
            style={lnConfig ? styles.lnConfigBtn : styles.lnConfigBtnWarn}
            onClick={() => setShowLnConfig(true)}
          >
            {lnConfig ? 'LN 설정' : 'LN 설정 필요'}
          </button>
          {/*
            푸시 키가 없으면 알림이 **조용히** 안 나간다 — 거래는 정상 진행되고
            콘솔에만 경고가 남아서, 실제로 이것 때문에 한참 헤맸다.
            메인 화면에서 바로 보이게 둔다.
          */}
          {!pushKeyOk && (
            <button style={styles.lnConfigBtnWarn} onClick={() => setShowLnConfig(true)}>
              푸시 키 필요
            </button>
          )}
        </div>
        <p style={styles.subtitle}>
          {currentPage === 'detail' && selectedOrderId
            ? `주문 #${selectedOrderId} 상세`
            : selectedOrderId
              ? `주문 #${selectedOrderId} 클레임`
              : currentPage === 'history'
                ? '거래 이력'
                : '클레임 대기열'}
        </p>
        <BtcPrice tracker={tracker} />
        {nodeTracker && <NodeStatus tracker={nodeTracker} />}
        <label style={styles.depositLabel}>
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={e => {
              setAutoApproveEnabled(e.target.checked);
              setAutoApprove(e.target.checked);
            }}
          />
          클레임 자동 승인
        </label>
        <label style={styles.depositLabel}>
          고객 보증금
          <select
            value={customerDepositPct}
            onChange={(e) => {
              const v = Number(e.target.value);
              setCustomerDepositPercent(v);
              setCustomerDepositPct(v);
            }}
            style={styles.depositSelect}
          >
            <option value={0}>OFF</option>
            <option value={1}>1%</option>
            <option value={3}>3%</option>
            <option value={5}>5%</option>
          </select>
        </label>
        <label style={styles.depositLabel}>
          후원자 보증금
          <select
            value={sponsorDepositPct}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSponsorDepositPercent(v);
              setSponsorDepositPct(v);
            }}
            style={styles.depositSelect}
          >
            <option value={0}>OFF</option>
            <option value={1}>1%</option>
            <option value={3}>3%</option>
            <option value={5}>5%</option>
          </select>
        </label>
      </header>
      <main>
        {currentPage === 'detail' && selectedOrderId ? (
          <OrderDetail
            orderId={selectedOrderId}
            onBack={goHistory}
            tracker={tracker}
            lnAdapter={lnAdapter}
          />
        ) : selectedOrderId ? (
          <OrderClaimList
            orderId={selectedOrderId}
            onBack={goQueue}
            tracker={tracker}
            lnAdapter={lnAdapter}
          />
        ) : currentPage === 'history' ? (
          <HistoryPage
            onSelectOrder={selectOrderDetail}
            tracker={tracker}
          />
        ) : (
          <>
            <OrderQueue onSelectOrder={selectOrder} tracker={tracker} />
            <OnchainConfig onChanged={() => setOnchainEpoch(n => n + 1)} />
            {/*
              온체인 트랙은 **별도 FSM·별도 구독**이라 오더북에 섞지 않는다
              (PLAN-ONCHAIN-TRACK §1). 대신 사람이 봐야 하는 것(경보·분쟁)은
              같은 화면에 있어야 놓치지 않는다.
            */}
            <OnchainPanel />
          </>
        )}
      </main>
      <p style={styles.version}>{__COMMIT_HASH__}</p>
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
  loading: {
    textAlign: 'center' as const,
    padding: 80,
    color: '#999',
    fontSize: 14,
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
  navBtnActive: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#fff',
    background: '#4F46E5',
    border: '1px solid #4F46E5',
    borderRadius: 6,
    cursor: 'pointer' as const,
  },
  lnConfigBtn: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#666',
    background: '#F3F4F6',
    border: '1px solid #E5E7EB',
    borderRadius: 6,
    cursor: 'pointer' as const,
  },
  lnConfigBtnWarn: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#DC2626',
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: 6,
    cursor: 'pointer' as const,
  },
  depositLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: '#666',
  },
  depositSelect: {
    fontSize: 12,
    padding: '2px 4px',
    borderRadius: 4,
    border: '1px solid #D1D5DB',
  },
  version: {
    marginTop: 64,
    textAlign: 'right' as const,
    fontSize: 10,
    color: '#ccc',
  },
} as const;
