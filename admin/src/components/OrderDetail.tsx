import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  subscribeChatStore, getChatSnapshot,
  addMessage, loadFromIdb, clearMessages,
  idbGetOrder, idbGetRequestsByOrderId,
  APP_PUBKEY,
  ChatWindow,
} from '@sajwo-tracker/shared';
import type { Order, Request, PriceTracker, DisputeMessagePayload } from '@sajwo-tracker/shared';
import type { LightningAdapter } from '../lightning';
import type { HoldInvoiceStatus } from '../lightning/types';
import { subscribeChatMessages } from '../nostr/chat-subscribe';
import { publishDisputeMessage, publishDepositStatus, publishDepositRequired } from '../nostr/publish';
import { getPendingDeposit } from '../pending-deposit-store';
import { resolveDisputeSponsorWins, resolveDisputeCustomerWins } from '../nostr/service';
import { getEscrowEntry, getPreimage } from '../escrow-store';
import { CommitmentBadge } from './CommitmentBadge';
import { SatsAmount } from './SatsAmount';

interface Props {
  orderId: string;
  onBack: () => void;
  tracker: PriceTracker;
  lnAdapter: LightningAdapter | null;
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
  'deposit-required': '보증금 요청',
  'deposit-accepted': '보증금 확인',
  'deposit-cancelled': '보증금 환불',
  'deposit-settled': '보증금 몰수',
  'claim-price-error': '가격 오류 알림',
};

const requestSenderLabel: Record<string, string> = {
  'order-request': '고객',
  claim: '후원자',
  'payment-confirm': '고객',
  'cancel-request': '고객',
  'remit-request': '후원자',
  'account-info': '고객',
  'deposit-required': '어드민',
  'deposit-accepted': '어드민',
  'deposit-cancelled': '어드민',
  'deposit-settled': '어드민',
  'claim-price-error': '어드민',
};

const cDepositStatusLabel: Record<HoldInvoiceStatus, string> = {
  open: '미결제 (open)',
  accepted: '결제됨 — 홀드 중 (accepted)',
  settled: '세틀 완료 (settled)',
  cancelled: '캔슬 완료 (cancelled)',
};

const cDepositStatusStyle: Record<HoldInvoiceStatus, { bg: string; color: string }> = {
  open: { bg: '#FEF9C3', color: '#A16207' },
  accepted: { bg: '#EDE9FE', color: '#7C3AED' },
  settled: { bg: '#D1FAE5', color: '#065F46' },
  cancelled: { bg: '#F3F4F6', color: '#6B7280' },
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

export function OrderDetail({ orderId, onBack, tracker, lnAdapter }: Props) {
  const [order, setOrder] = useState<Order | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [resolving, setResolving] = useState(false);
  const [accountCommitment, setAccountCommitment] = useState<string | undefined>();

  // ── 고객 보증금 인보이스 상태 ──────────────────────
  const [cDepositStatus, setCDepositStatus] = useState<HoldInvoiceStatus | null>(null);
  const [cDepositQuerying, setCDepositQuerying] = useState(false);
  const [cDepositActing, setCDepositActing] = useState(false);

  // ── 후원자 보증금 인보이스 상태 ──────────────────────
  const [sDepositStatus, setSDepositStatus] = useState<HoldInvoiceStatus | null>(null);
  const [sDepositQuerying, setSDepositQuerying] = useState(false);
  const [sDepositActing, setSDepositActing] = useState(false);

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

  // ── 보증금 인보이스 상태 조회 ─────────────────────
  const depositPaymentHash = order?.depositPaymentHash;

  const handleCDepositLookup = useCallback(async () => {
    if (!depositPaymentHash || !lnAdapter) return;
    setCDepositQuerying(true);
    try {
      const status = await lnAdapter.lookupHoldInvoice(depositPaymentHash);
      setCDepositStatus(status);
    } catch (e) {
      alert(`보증금 상태 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCDepositQuerying(false);
    }
  }, [depositPaymentHash, lnAdapter]);

  const handleCDepositSettle = useCallback(async () => {
    if (!confirm('보증금을 몰수(settle)하시겠습니까?\n고객에게 보증금이 환불되지 않습니다.')) return;
    const depositKey = `deposit:${orderId}`;
    const preimage = getPreimage(depositKey);
    if (!preimage) {
      alert('보증금 프리이미지를 찾을 수 없습니다.');
      return;
    }
    setCDepositActing(true);
    try {
      await lnAdapter!.settleInvoice(preimage);
      setCDepositStatus('settled');
      if (customerPubkey) void publishDepositStatus(orderId, customerPubkey, 'settled');
    } catch (e) {
      alert(`보증금 settle 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCDepositActing(false);
    }
  }, [orderId, lnAdapter]);

  const handleCDepositCancel = useCallback(async () => {
    if (!confirm('보증금을 환불(cancel)하시겠습니까?\n고객에게 보증금이 즉시 환불됩니다.')) return;
    if (!depositPaymentHash) return;
    setCDepositActing(true);
    try {
      await lnAdapter!.cancelInvoice(depositPaymentHash);
      setCDepositStatus('cancelled');
      if (customerPubkey) void publishDepositStatus(orderId, customerPubkey, 'cancelled');
    } catch (e) {
      alert(`보증금 cancel 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCDepositActing(false);
    }
  }, [depositPaymentHash, lnAdapter]);

  // ── 후원자 보증금 인보이스 상태 조회 ─────────────────
  const sponsorDepositPaymentHash = order?.sponsorDepositPaymentHash;

  const handleSDepositLookup = useCallback(async () => {
    if (!sponsorDepositPaymentHash || !lnAdapter) return;
    setSDepositQuerying(true);
    try {
      const status = await lnAdapter.lookupHoldInvoice(sponsorDepositPaymentHash);
      setSDepositStatus(status);
    } catch (e) {
      alert(`후원자 보증금 상태 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSDepositQuerying(false);
    }
  }, [sponsorDepositPaymentHash, lnAdapter]);

  const handleSDepositSettle = useCallback(async () => {
    if (!confirm('후원자 보증금을 몰수(settle)하시겠습니까?')) return;
    const depositKey = `deposit:sponsor:${orderId}`;
    const preimage = getPreimage(depositKey);
    if (!preimage) { alert('후원자 보증금 프리이미지를 찾을 수 없습니다.'); return; }
    setSDepositActing(true);
    try {
      await lnAdapter!.settleInvoice(preimage);
      setSDepositStatus('settled');
      if (sponsorPubkey) void publishDepositStatus(orderId, sponsorPubkey, 'settled');
    } catch (e) {
      alert(`후원자 보증금 settle 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSDepositActing(false);
    }
  }, [orderId, lnAdapter, sponsorPubkey]);

  const handleSDepositCancel = useCallback(async () => {
    if (!confirm('후원자 보증금을 환불(cancel)하시겠습니까?')) return;
    if (!sponsorDepositPaymentHash) return;
    setSDepositActing(true);
    try {
      await lnAdapter!.cancelInvoice(sponsorDepositPaymentHash);
      setSDepositStatus('cancelled');
      if (sponsorPubkey) void publishDepositStatus(orderId, sponsorPubkey, 'cancelled');
    } catch (e) {
      alert(`후원자 보증금 cancel 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSDepositActing(false);
    }
  }, [sponsorDepositPaymentHash, lnAdapter, orderId, sponsorPubkey]);

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

      {/* Customer Deposit Invoice */}
      {depositPaymentHash && lnAdapter && (
        <div style={styles.depositSection}>
          <div style={styles.depositHeader}>
            <span style={styles.depositTitle}>고객 보증금</span>
            <button
              style={styles.depositQueryBtn}
              onClick={() => void handleCDepositLookup()}
              disabled={cDepositQuerying}
            >
              {cDepositQuerying ? '조회 중...' : '상태 조회'}
            </button>
          </div>
          <div style={styles.depositMeta}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#666' }}>
              hash: {depositPaymentHash.slice(0, 16)}…{depositPaymentHash.slice(-8)}
            </span>
            {(() => {
              const pending = getPendingDeposit(orderId);
              if (!pending) return null;
              const recipient = pending.type === 'sponsor' ? pending.sponsorPubkey : pending.customerPubkey;
              if (!recipient) return null;
              return (
                <button
                  style={styles.depositNotifyBtn}
                  onClick={() => {
                    void publishDepositRequired(orderId, recipient, pending.depositBolt11, pending.expiration);
                    alert('보증금 인보이스를 재전송했습니다.');
                  }}
                >
                  인보이스 재전송
                </button>
              );
            })()}
          </div>
          {cDepositStatus && (
            <div style={styles.cDepositStatusRow}>
              <span style={{
                ...styles.cDepositStatusBadge,
                background: cDepositStatusStyle[cDepositStatus]?.bg ?? '#F3F4F6',
                color: cDepositStatusStyle[cDepositStatus]?.color ?? '#666',
              }}>
                {cDepositStatusLabel[cDepositStatus]}
              </span>
              {cDepositStatus === 'accepted' && (
                <div style={styles.depositActions}>
                  <button
                    style={styles.depositSettleBtn}
                    onClick={() => void handleCDepositSettle()}
                    disabled={cDepositActing}
                  >
                    {cDepositActing ? '처리 중...' : '세틀 (몰수)'}
                  </button>
                  <button
                    style={styles.depositCancelBtn}
                    onClick={() => void handleCDepositCancel()}
                    disabled={cDepositActing}
                  >
                    {cDepositActing ? '처리 중...' : '캔슬 (환불)'}
                  </button>
                </div>
              )}
              {customerPubkey && (
                <button
                  style={styles.depositNotifyBtn}
                  onClick={() => {
                    const statusMap: Record<HoldInvoiceStatus, 'accepted' | 'cancelled' | 'settled'> = {
                      open: 'accepted', accepted: 'accepted', cancelled: 'cancelled', settled: 'settled',
                    };
                    void publishDepositStatus(orderId, customerPubkey, statusMap[cDepositStatus!]);
                    alert('고객에게 보증금 상태 알림을 전송했습니다.');
                  }}
                >
                  고객에게 상태 알림
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sponsor Deposit Invoice */}
      {sponsorDepositPaymentHash && lnAdapter && (
        <div style={styles.depositSection}>
          <div style={styles.depositHeader}>
            <span style={styles.depositTitle}>후원자 보증금</span>
            <button
              style={styles.depositQueryBtn}
              onClick={() => void handleSDepositLookup()}
              disabled={sDepositQuerying}
            >
              {sDepositQuerying ? '조회 중...' : '상태 조회'}
            </button>
          </div>
          <div style={styles.depositMeta}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#666' }}>
              hash: {sponsorDepositPaymentHash.slice(0, 16)}…{sponsorDepositPaymentHash.slice(-8)}
            </span>
            {(() => {
              const pending = getPendingDeposit(orderId);
              if (!pending || pending.type !== 'sponsor' || !pending.sponsorPubkey) return null;
              return (
                <button
                  style={styles.depositNotifyBtn}
                  onClick={() => {
                    void publishDepositRequired(orderId, pending.sponsorPubkey!, pending.depositBolt11, pending.expiration);
                    alert('후원자에게 보증금 인보이스를 재전송했습니다.');
                  }}
                >
                  인보이스 재전송
                </button>
              );
            })()}
          </div>
          {sDepositStatus && (
            <div style={styles.cDepositStatusRow}>
              <span style={{
                ...styles.cDepositStatusBadge,
                background: cDepositStatusStyle[sDepositStatus]?.bg ?? '#F3F4F6',
                color: cDepositStatusStyle[sDepositStatus]?.color ?? '#666',
              }}>
                {cDepositStatusLabel[sDepositStatus]}
              </span>
              {sDepositStatus === 'accepted' && (
                <div style={styles.depositActions}>
                  <button
                    style={styles.depositSettleBtn}
                    onClick={() => void handleSDepositSettle()}
                    disabled={sDepositActing}
                  >
                    {sDepositActing ? '처리 중...' : '세틀 (몰수)'}
                  </button>
                  <button
                    style={styles.depositCancelBtn}
                    onClick={() => void handleSDepositCancel()}
                    disabled={sDepositActing}
                  >
                    {sDepositActing ? '처리 중...' : '캔슬 (환불)'}
                  </button>
                </div>
              )}
              {sponsorPubkey && (
                <button
                  style={styles.depositNotifyBtn}
                  onClick={() => {
                    const statusMap: Record<HoldInvoiceStatus, 'accepted' | 'cancelled' | 'settled'> = {
                      open: 'accepted', accepted: 'accepted', cancelled: 'cancelled', settled: 'settled',
                    };
                    void publishDepositStatus(orderId, sponsorPubkey, statusMap[sDepositStatus!]);
                    alert('후원자에게 보증금 상태 알림을 전송했습니다.');
                  }}
                >
                  후원자에게 상태 알림
                </button>
              )}
            </div>
          )}
        </div>
      )}

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
            renderAccountExtra={accountCommitment
              ? (info) => <CommitmentBadge accountInfo={info} commitment={accountCommitment} />
              : undefined}
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
  depositSection: {
    background: '#FFF7ED',
    border: '1px solid #FED7AA',
    borderRadius: 8,
    padding: '16px 20px',
    marginBottom: 16,
  },
  depositHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  depositTitle: {
    fontSize: 14,
    fontWeight: 600 as const,
    color: '#C2410C',
  },
  depositQueryBtn: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#C2410C',
    background: '#fff',
    border: '1px solid #FED7AA',
    borderRadius: 6,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  depositMeta: {
    marginBottom: 8,
  },
  cDepositStatusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap' as const,
  },
  cDepositStatusBadge: {
    display: 'inline-block',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600 as const,
  },
  depositActions: {
    display: 'flex',
    gap: 8,
  },
  depositSettleBtn: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#fff',
    background: '#DC2626',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  depositCancelBtn: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#fff',
    background: '#059669',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
  },
  depositNotifyBtn: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500 as const,
    color: '#4F46E5',
    background: '#EEF2FF',
    border: '1px solid #C7D2FE',
    borderRadius: 6,
    cursor: 'pointer' as const,
    fontFamily: 'inherit',
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
