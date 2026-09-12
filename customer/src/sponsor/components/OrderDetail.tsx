import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  subscribeChatStore, getChatSnapshot,
  addMessage, loadFromIdb, clearMessages,
  idbGetOrder, idbGetRequestsByOrderId,
  getUserPubkey,
  storage,
  ChatWindow,
  subscribeChatMessages,
  OrderProgress,
} from '@sajwo-tracker/shared';
import type { Order, PriceTracker, DisputeMessagePayload } from '@sajwo-tracker/shared';

import { publishDisputeMessage, publishAccountReveal } from '../nostr/claim';
import { subscribeRevealRequests, getRevealRequestSnapshot } from '../reveal-request-store';

interface Props {
  orderId: string;
  onBack: () => void;
  tracker: PriceTracker;
}

const stateLabel: Record<string, string> = {
  requested: '요청됨', claimed: '클레임됨', verified: '검증됨',
  escrowed: '에스크로', remitted: '송금 주장', paid: '완료',
  cancelled: '취소', sponsor_wins: '후원자 승리', customer_wins: '고객 승리',
};

const stateColor: Record<string, string> = {
  requested: '#D97706', claimed: '#2563EB', verified: '#4F46E5',
  escrowed: '#7C3AED', remitted: '#BE185D', paid: '#059669',
  cancelled: '#6B7280', sponsor_wins: '#0F766E', customer_wins: '#0E7490',
};

const stateBg: Record<string, string> = {
  requested: '#FEF3C7', claimed: '#DBEAFE', verified: '#E0E7FF',
  escrowed: '#EDE9FE', remitted: '#FCE7F3', paid: '#D1FAE5',
  cancelled: '#F3F4F6', sponsor_wins: '#CCFBF1', customer_wins: '#CFFAFE',
};

export function OrderDetail({ orderId, onBack, tracker }: Props) {
  const [order, setOrder] = useState<Order | null>(null);
  const [myPubkey, setMyPubkey] = useState<string | null>(null);
  const [hasAccountInfo, setHasAccountInfo] = useState(false);
  const [revealing, setRevealing] = useState(false);

  // Load order + own pubkey + account info availability
  useEffect(() => {
    void idbGetOrder(orderId).then(o => { if (o) setOrder(o); });
    void getUserPubkey(storage).then(setMyPubkey);
    void idbGetRequestsByOrderId(orderId).then(reqs => {
      setHasAccountInfo(reqs.some(r => r.action === 'account-info' && r.accountInfo));
    });
  }, [orderId]);

  // Chat subscription lifecycle
  useEffect(() => {
    let cleanup: (() => void) | null = null;

    void loadFromIdb(orderId);
    void subscribeChatMessages(orderId, msg => addMessage(msg))
      .then(unsub => { cleanup = unsub; });

    return () => {
      cleanup?.();
      clearMessages(orderId);
    };
  }, [orderId]);

  // Admin이 공개를 요청했는지. 요청 전에는 버튼 자체를 열지 않는다 —
  // remitted는 '원화 송금했어요' 직후의 정상 상태라, 버튼이 보이면
  // 흐름의 일부인 줄 알고 계좌를 Admin에게 그냥 보내는 일이 생긴다.
  const revealRequests = useSyncExternalStore(subscribeRevealRequests, getRevealRequestSnapshot);
  const revealRequested = revealRequests[orderId] !== undefined;

  const chatSnapshot = useSyncExternalStore(subscribeChatStore, getChatSnapshot);
  const messages = chatSnapshot[orderId] ?? [];

  // Send handler (Sponsor → Admin)
  const handleSend = useCallback(async (text: string) => {
    if (!order) return;
    const payload: DisputeMessagePayload = { type: 'text', content: text };
    await publishDisputeMessage(order, payload);
  }, [order]);

  // 계좌정보 공개 (분쟁 시 Admin에게 증거 제출)
  const handleAccountReveal = useCallback(async () => {
    if (!order) return;
    if (!confirm('계좌정보를 Admin에게 공개하시겠습니까?\n원래 전달한 계좌정보의 커밋먼트와 대조 검증됩니다.')) return;
    setRevealing(true);
    try {
      const ok = await publishAccountReveal(order);
      if (!ok) alert('계좌정보 공개에 실패했습니다.');
    } catch {
      alert('계좌정보 공개 중 오류가 발생했습니다.');
    } finally {
      setRevealing(false);
    }
  }, [order]);

  // BTC sats conversion
  const snap = tracker.getSnapshot();
  const btcPrice = snap.price;
  const sats = btcPrice !== null && btcPrice > 0 && order
    ? Math.round((order.price / btcPrice) * 1e8)
    : null;

  // 이 화면은 내역 탭에서도 열리므로 내가 고객이었던 주문이 들어올 수 있다.
  // 진행도 안내를 역할에 맞춰야 해서 오더에서 유도한다 — 칼럼 없이 pubkey 비교로.
  // 자기 클레임을 Admin이 막으므로 둘 다 참일 수는 없다.
  const myRole = order && myPubkey && order.customerPubkey === myPubkey ? 'customer' : 'sponsor';

  if (!order) {
    return <div style={styles.loading}>불러오는 중...</div>;
  }

  return (
    <div>
      <button style={styles.backBtn} onClick={onBack}>← 목록으로</button>

      {/* Order Summary */}
      <div style={styles.summary}>
        <div style={styles.summaryTop}>
          <div style={styles.summaryInfo}>
            <span style={styles.orderId}>#{orderId}</span>
            <span style={styles.price}>{order.price.toLocaleString()}원</span>
            {sats !== null && (
              <span style={styles.sats}>~{sats.toLocaleString()} sats</span>
            )}
          </div>
          <span style={{
            ...styles.stateBadge,
            background: stateBg[order.state] ?? '#F3F4F6',
            color: stateColor[order.state] ?? '#666',
          }}>
            {stateLabel[order.state] ?? order.state}
          </span>
        </div>
        <div style={styles.summaryMeta}>
          <span>
            생성: {new Date(order.createdAt * 1000).toLocaleString('ko-KR', {
              year: 'numeric', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </span>
          {order.expiration > 0 && (
            <span>
              만료: {new Date(order.expiration * 1000).toLocaleString('ko-KR', {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
            </span>
          )}
        </div>
        {order.disbursed && <div style={styles.disbursed}>BTC 수령 완료</div>}
      </div>

      <div style={styles.progressWrap}>
        <OrderProgress
          role={myRole}
          state={order.state}
          accountInfoSent={hasAccountInfo}
        />
      </div>

      {/* 계좌정보 공개 (분쟁 상태에서만 표시) */}
      {hasAccountInfo && revealRequested && (
        <div style={styles.revealSection}>
          <button
            style={styles.revealBtn}
            onClick={() => void handleAccountReveal()}
            disabled={revealing}
          >
            {revealing ? '전송 중...' : '계좌정보 공개'}
          </button>
          <span style={styles.revealHint}>
            Admin이 분쟁 중재를 위해 계좌정보 공개를 요청했습니다.
            전달받은 계좌를 그대로 제출하면 커밋먼트와 대조 검증됩니다.
          </span>
        </div>
      )}

      {/* Chat Window (Sponsor ↔ Admin) */}
      {myPubkey && (
        <ChatWindow
          label="Admin 채팅"
          messages={messages}
          myPubkey={myPubkey}
          onSend={handleSend}
        />
      )}
    </div>
  );
}

const styles = {
  progressWrap: {
    marginBottom: 16,
  },
  loading: {
    textAlign: 'center' as const,
    padding: 48,
    color: '#666',
    fontSize: 14,
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 12px',
    marginBottom: 16,
    fontSize: 13,
    fontWeight: 500 as const,
    color: '#4F46E5',
    background: 'none',
    border: '1px solid #C7D2FE',
    borderRadius: 6,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  summary: {
    background: '#fff',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    padding: '16px 20px',
    marginBottom: 16,
  },
  summaryTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  summaryInfo: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
  },
  orderId: {
    fontSize: 16,
    fontWeight: 600 as const,
    color: '#333',
  },
  price: {
    fontSize: 20,
    fontWeight: 700 as const,
    color: '#4F46E5',
  },
  sats: {
    fontSize: 12,
    color: '#999',
  },
  stateBadge: {
    display: 'inline-block',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600 as const,
  },
  summaryMeta: {
    display: 'flex',
    gap: 16,
    fontSize: 12,
    color: '#999',
  },
  disbursed: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#059669',
  },
  revealSection: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: '#FEF3C7',
    border: '1px solid #FDE68A',
    borderRadius: 8,
    padding: '12px 16px',
    marginBottom: 16,
  },
  revealBtn: {
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#fff',
    background: '#D97706',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
  },
  revealHint: {
    fontSize: 11,
    color: '#92400E',
    lineHeight: 1.4,
  },
} as const;
