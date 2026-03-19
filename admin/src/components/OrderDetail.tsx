import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  subscribeChatStore, getChatSnapshot,
  addMessage, loadFromIdb, clearMessages,
  idbGetOrder, idbGetRequestsByOrderId,
  APP_PUBKEY,
} from '@sajwo-tracker/shared';
import type { Order, Request, PriceTracker, DisputeMessagePayload } from '@sajwo-tracker/shared';
import { subscribeChatMessages } from '../nostr/chat-subscribe';
import { publishDisputeMessage } from '../nostr/publish';
import { resolveDisputeSponsorWins, resolveDisputeCustomerWins } from '../nostr/service';
import { ChatWindow } from './ChatWindow';
import { SatsAmount } from './SatsAmount';

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

const requestActionLabel: Record<string, string> = {
  'order-request': '주문 요청',
  claim: '클레임',
  'payment-confirm': '결제 확인',
  'cancel-request': '취소 요청',
  'remit-request': '송금 완료',
  'account-info': '계좌 정보',
};

const requestSenderLabel: Record<string, string> = {
  'order-request': '고객',
  claim: '후원자',
  'payment-confirm': '고객',
  'cancel-request': '고객',
  'remit-request': '후원자',
  'account-info': '고객',
};

function shortPubkey(pk: string): string {
  return pk.length > 16 ? `${pk.slice(0, 8)}…${pk.slice(-8)}` : pk;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function OrderDetail({ orderId, onBack, tracker }: Props) {
  const [order, setOrder] = useState<Order | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [resolving, setResolving] = useState(false);
  const [accountCommitment, setAccountCommitment] = useState<string | undefined>();

  // Load order + requests from IDB
  useEffect(() => {
    void idbGetOrder(orderId).then(o => { if (o) setOrder(o); });
    void idbGetRequestsByOrderId(orderId).then(reqs => {
      setRequests(reqs.sort((a, b) => b.createdAt - a.createdAt));
      const aiReq = reqs.find(r => r.action === 'account-info');
      if (aiReq?.raw) {
        const raw = aiReq.raw as { tags?: string[][] };
        const commitment = raw.tags?.find(t => t[0] === 'commitment')?.[1];
        if (commitment) setAccountCommitment(commitment);
      }
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

  const chatSnapshot = useSyncExternalStore(subscribeChatStore, getChatSnapshot);
  const allMessages = chatSnapshot[orderId] ?? [];

  // Split messages into Customer/Sponsor chats
  const customerPubkey = order?.customerPubkey;
  const sponsorPubkey = order?.sponsorPubkey;

  const customerMessages = useMemo(() =>
    allMessages.filter(m =>
      m.senderPubkey === customerPubkey || m.recipientPubkey === customerPubkey,
    ), [allMessages, customerPubkey]);

  const sponsorMessages = useMemo(() =>
    allMessages.filter(m =>
      m.senderPubkey === sponsorPubkey || m.recipientPubkey === sponsorPubkey,
    ), [allMessages, sponsorPubkey]);

  // Send handlers
  const sendToCustomer = useCallback(async (text: string) => {
    if (!customerPubkey) return;
    const payload: DisputeMessagePayload = { type: 'text', content: text };
    await publishDisputeMessage(orderId, customerPubkey, payload);
  }, [orderId, customerPubkey]);

  const sendToSponsor = useCallback(async (text: string) => {
    if (!sponsorPubkey) return;
    const payload: DisputeMessagePayload = { type: 'text', content: text };
    await publishDisputeMessage(orderId, sponsorPubkey, payload);
  }, [orderId, sponsorPubkey]);

  // Dispute resolution
  const handleSponsorWins = useCallback(async () => {
    if (!confirm('후원자 승리로 판정하시겠습니까?\n에스크로된 BTC가 후원자에게 지급됩니다.')) return;
    setResolving(true);
    try {
      const result = await resolveDisputeSponsorWins(orderId);
      if (result.error) {
        alert(`판정 실패: ${result.error}`);
      } else {
        void idbGetOrder(orderId).then(o => { if (o) setOrder(o); });
      }
    } finally {
      setResolving(false);
    }
  }, [orderId]);

  const handleCustomerWins = useCallback(async () => {
    if (!confirm('고객 승리로 판정하시겠습니까?\n에스크로된 BTC가 고객에게 환불됩니다.')) return;
    setResolving(true);
    try {
      const result = await resolveDisputeCustomerWins(orderId);
      if (result.warning === 'INVOICE_ALREADY_SETTLED') {
        alert('주의: 홀드 인보이스가 이미 settle 되었습니다.\n별도 LN 결제로 환불이 필요합니다.');
      } else if (result.error) {
        alert(`판정 실패: ${result.error}`);
      } else {
        void idbGetOrder(orderId).then(o => { if (o) setOrder(o); });
      }
    } finally {
      setResolving(false);
    }
  }, [orderId]);

  if (!order) {
    return <div style={styles.loading}>오더 불러오는 중...</div>;
  }

  return (
    <div>
      <button style={styles.backBtn} onClick={onBack}>← 목록 보기</button>

      {/* Order Summary */}
      <div style={styles.summary}>
        <div style={styles.summaryTop}>
          <div style={styles.summaryInfo}>
            <span style={styles.orderId}>#{orderId}</span>
            <span style={styles.price}>{order.price.toLocaleString()}원</span>
            <SatsAmount krw={order.price} tracker={tracker} />
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
        <div style={styles.pubkeys}>
          {customerPubkey && <span>Customer: {shortPubkey(customerPubkey)}</span>}
          {sponsorPubkey && <span>Sponsor: {shortPubkey(sponsorPubkey)}</span>}
        </div>
        {order.disbursed && <div style={styles.disbursed}>BTC 송금 완료</div>}
      </div>

      {/* Dispute Resolution */}
      {order.state === 'remitted' && (
        <div style={styles.disputeSection}>
          <div style={styles.disputeTitle}>분쟁 판정</div>
          <div style={styles.disputeButtons}>
            <button
              style={styles.sponsorWinsBtn}
              onClick={() => void handleSponsorWins()}
              disabled={resolving}
            >
              {resolving ? '처리 중...' : '후원자 승리'}
            </button>
            <button
              style={styles.customerWinsBtn}
              onClick={() => void handleCustomerWins()}
              disabled={resolving}
            >
              {resolving ? '처리 중...' : '고객 승리'}
            </button>
          </div>
        </div>
      )}

      {/* Requests */}
      {requests.length > 0 && (
        <div style={styles.requestSection}>
          <div style={styles.requestTitle}>요청 {requests.length}건</div>
          <div style={styles.requestList}>
            {requests.map(req => (
              <div key={req.eventId} style={styles.requestCard}>
                <div style={styles.requestTop}>
                  <span style={styles.requestActionBadge}>
                    {requestActionLabel[req.action] ?? req.action}
                  </span>
                  <span style={styles.requestMeta}>
                    {requestSenderLabel[req.action] ?? '알 수 없음'} · {formatDate(req.createdAt)}
                  </span>
                </div>
                {req.action === 'claim' && req.invoice?.decoded && (
                  <div style={styles.requestInvoice}>
                    <span>노드: {shortPubkey(req.invoice.decoded.destination)}</span>
                    <span>금액: {req.invoice.decoded.amountSat.toLocaleString()} sats</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chat Windows */}
      <div style={styles.chatSection}>
        {customerPubkey && (
          <ChatWindow
            label={`Customer (${shortPubkey(customerPubkey)})`}
            messages={customerMessages}
            myPubkey={APP_PUBKEY}
            onSend={sendToCustomer}
          />
        )}
        {sponsorPubkey && (
          <ChatWindow
            label={`Sponsor (${shortPubkey(sponsorPubkey)})`}
            messages={sponsorMessages}
            myPubkey={APP_PUBKEY}
            onSend={sendToSponsor}
            accountCommitment={accountCommitment}
          />
        )}
        {!customerPubkey && !sponsorPubkey && (
          <div style={styles.noChat}>참여자 정보가 없어 채팅을 시작할 수 없습니다</div>
        )}
      </div>
    </div>
  );
}

const styles = {
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
    marginBottom: 6,
  },
  pubkeys: {
    display: 'flex',
    gap: 16,
    fontSize: 11,
    color: '#999',
    fontFamily: 'monospace',
  },
  disbursed: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#059669',
  },
  disputeSection: {
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: 8,
    padding: '16px 20px',
    marginBottom: 16,
  },
  disputeTitle: {
    fontSize: 14,
    fontWeight: 600 as const,
    color: '#DC2626',
    marginBottom: 12,
  },
  disputeButtons: {
    display: 'flex',
    gap: 12,
  },
  sponsorWinsBtn: {
    flex: 1,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#fff',
    background: '#0F766E',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  customerWinsBtn: {
    flex: 1,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600 as const,
    color: '#fff',
    background: '#0E7490',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  requestSection: {
    marginBottom: 16,
  },
  requestTitle: {
    fontSize: 13,
    color: '#666',
    marginBottom: 8,
  },
  requestList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  requestCard: {
    background: '#fff',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    padding: '12px 16px',
  },
  requestTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  requestActionBadge: {
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#4F46E5',
    background: '#EEF2FF',
    borderRadius: 4,
    padding: '2px 8px',
  },
  requestMeta: {
    fontSize: 12,
    color: '#999',
  },
  requestInvoice: {
    display: 'flex',
    gap: 16,
    marginTop: 6,
    fontSize: 12,
    color: '#555',
    fontFamily: 'monospace',
  },
  chatSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  noChat: {
    textAlign: 'center' as const,
    padding: 32,
    color: '#999',
    fontSize: 13,
  },
} as const;
