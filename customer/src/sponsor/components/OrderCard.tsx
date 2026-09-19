import { useState, useSyncExternalStore } from 'react';
import { InvoicePayBlock, sponsorRelation } from '@sajwo-tracker/shared';
import type { Order, PriceTracker } from '@sajwo-tracker/shared';
import { publishClaim, publishRemitRequest } from '../nostr/claim';
import { getStateMeta } from '../order-states';
import { SponsorInvoiceForm } from './SponsorInvoiceForm';
import { subscribeAccountInfo, getAccountInfoSnapshot } from '../account-store';
import { subscribeClaimErrors, getClaimErrorSnapshot, clearClaimError, rejectReasonText } from '../claim-error-store';
import { subscribe as subscribeDeposits, getSnapshot as getDepositSnapshot } from '../deposit-store';
// QR 스캐너는 jsqr(~30KB)을 끌고 오는데 클레임할 때만 쓴다.
// 첫 화면이 오더북이라 대부분의 방문에서 쓰이지 않으므로 지연 로딩한다.

interface Props {
  order: Order;
  now: number;
  tracker: PriceTracker;
  /** 내 pubkey. 아직 로딩 중이면 null — 남의 거래로 단정하지 않는다 */
  myPubkey: string | null;
  onSelectOrder: (orderId: string) => void;
}

function formatTimeLeft(expiration: number, now: number): string {
  if (expiration === 0) return '기한 없음';

  const diff = expiration - now;
  if (diff <= 0) return '만료됨';

  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes}분 남음`;
  }
  if (minutes > 0) {
    return `${minutes}분 ${seconds}초 남음`;
  }
  return `${seconds}초 남음`;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function OrderCard({ order, now, tracker, myPubkey, onSelectOrder }: Props) {
  const [claiming, setClaiming] = useState(false);
  const [remitting, setRemitting] = useState(false);

  // 시세 구독은 오더북 정렬·표시에만 쓴다. **여기서 가격이 정해지지 않는다** —
  // 확정은 어드민이 verified에서 하고 오더의 payout 태그로 내려온다.
  useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);

  const accountInfoMap = useSyncExternalStore(subscribeAccountInfo, getAccountInfoSnapshot);
  const accountInfo = accountInfoMap[order.orderId];

  const claimErrors = useSyncExternalStore(subscribeClaimErrors, getClaimErrorSnapshot);
  const claimError = claimErrors[order.orderId];

  const depositMap = useSyncExternalStore(subscribeDeposits, getDepositSnapshot);
  const deposit = depositMap[order.orderId];

  const timeLeft = formatTimeLeft(order.expiration, now);
  const isUrgent = order.expiration > 0 && order.expiration - now < 3600;

  const relation = sponsorRelation(order, myPubkey);
  const isTaken = relation === 'taken';

  // 클레임 가능: requested 상태일 때만
  const canClaim = relation === 'open';
  const stateMeta = getStateMeta(order.state);

  // 계좌정보 + 송금 관련. 반드시 내 거래일 때만 —
  // 안 그러면 남의 escrowed 주문에도 "계좌 정보 대기 중"이 떠서
  // 자기가 관여한 거래로 착각하게 된다.
  const isMine = relation === 'mine';
  // 계좌는 `invoiced`부터 온다 — 내 인보이스가 검증된 뒤라야 고객이 발행한다.
  // `escrowed`는 그 앞 단계, 즉 **내가 인보이스를 낼 차례**다.
  //
  // `invoiced`에서도 거절 통보가 와 있으면 다시 띄운다 — 지급 직전에 인보이스가
  // 만료된 경우다. 이때 거래는 살아 있고 필요한 건 새 인보이스뿐이라,
  // 폼이 안 보이면 후원자가 할 수 있는 게 없어진다.
  const needsInvoice = isMine
    && (order.state === 'escrowed' || (order.state === 'invoiced' && !!claimError));
  const showAccountInfo = isMine && order.state === 'invoiced' && accountInfo;
  const showWaitingAccount = isMine && order.state === 'invoiced' && !accountInfo;
  const canRemit = isMine && order.state === 'invoiced' && accountInfo;


  async function handleClaim() {
    setClaiming(true);
    try {
      const ok = await publishClaim(order);
      if (!ok) {
        alert('클레임 발행에 실패했습니다.');
      }
    } catch (err) {
      console.error('[Claim] Error:', err);
      alert('클레임 발행 중 오류가 발생했습니다.');
    } finally {
      setClaiming(false);
    }
  }

  async function handleRemit() {
    if (!confirm(
      '지정된 금액을 지정된 계좌로 송금하셨습니까?\n\n'
      + '송금하지 않고 송금을 주장할 경우, 분쟁 발생 시 불리하게 적용될 수 있습니다.',
    )) return;
    setRemitting(true);
    try {
      const ok = await publishRemitRequest(order);
      if (!ok) {
        alert('송금 완료 통보에 실패했습니다.');
      }
    } catch (err) {
      console.error('[Remit] Error:', err);
      alert('송금 완료 통보 중 오류가 발생했습니다.');
    } finally {
      setRemitting(false);
    }
  }

  // 금액 일치 검증: invoice 금액이 고정된 예상 sats와 동일한지


  return (
    <div style={isTaken ? { ...styles.card, ...styles.cardTaken } : styles.card}>
      <div style={styles.top}>
        <span style={styles.price}>
          {order.price.toLocaleString()}원
        </span>
        <span style={{
          ...styles.timeLeft,
          color: isUrgent ? '#DC2626' : '#666',
        }}>
          {timeLeft}
        </span>
      </div>

      <div style={styles.middle}>
        {canClaim ? (
          <>
            {/*
              클레임은 버튼 하나다. 인보이스는 에스크로가 잡힌 뒤에 낸다
              (docs/DESIGN-LATE-INVOICE.md). 여기서 받으면 후원자 노드 사정이
              고객의 결제를 막고, 인보이스는 거래 내내 묵어 만료된다.
            */}
            <button
              style={{
                ...styles.claimBtn,
                opacity: claiming ? 0.5 : 1,
                cursor: claiming ? 'not-allowed' : 'pointer',
              }}
              onClick={handleClaim}
              disabled={claiming}
            >
              {claiming ? '발행 중...' : '사줄게'}
            </button>
            <p style={styles.invoiceHint}>
              맡겠다는 표시만 합니다. 고객이 결제를 마치면 BTC 받을 인보이스를
              등록하게 됩니다.
            </p>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={styles.statusRow}>
              <span style={{
                ...styles.statusBadge,
                background: stateMeta.bgColor,
                color: stateMeta.textColor,
              }}>
                {stateMeta.label}
              </span>
              {isTaken && <span style={styles.lockBadge}>다른 후원자가 진행 중</span>}
              {isMine && <span style={styles.mineBadge}>내가 사주는 중</span>}
            </div>

            {isTaken && (
              <p style={styles.takenNotice}>
                이미 다른 후원자가 가져간 의뢰라 참여할 수 없습니다.
                거래가 취소되면 다시 '요청됨'으로 돌아오고, 그때는 누구나 참여할 수 있습니다.
              </p>
            )}

            {/* 보증금 섹션: 내 거래의 claimed 상태에서 deposit 있을 때 */}
            {isMine && order.state === 'claimed' && deposit && !deposit.status && (
              <div style={styles.depositSection}>
                <p style={styles.depositDesc}>
                  보증금 결제가 필요합니다.
                </p>
                <p style={styles.depositNotice}>
                  스팸 방지를 위한 보증금이며 거래 완료 후 전액 환불됩니다.
                </p>
                <InvoicePayBlock bolt11={deposit.bolt11} maxQrSize={200} />
              </div>
            )}
            {isMine && order.state === 'claimed' && deposit?.status && (
              <span style={{
                ...styles.depositStatusBadge,
                background: deposit.status === 'accepted' ? '#D1FAE5'
                  : deposit.status === 'cancelled' ? '#F3F4F6' : '#FEE2E2',
                color: deposit.status === 'accepted' ? '#065F46'
                  : deposit.status === 'cancelled' ? '#6B7280' : '#DC2626',
              }}>
                보증금: {deposit.status === 'accepted' ? '전달 완료'
                  : deposit.status === 'cancelled' ? '환불됨' : '몰수됨'}
              </span>
            )}

            {needsInvoice && (
              <SponsorInvoiceForm
                order={order}
                onSubmitted={() => clearClaimError(order.orderId)}
                notice={claimError ? rejectReasonText(claimError) : null}
              />
            )}

            {showWaitingAccount && (
              <span style={styles.waitingBadge}>
                계좌 정보 대기 중
              </span>
            )}

            {showAccountInfo && accountInfo && (
              <div style={styles.accountSection}>
                <p style={styles.accountTitle}>계좌 정보</p>
                <p style={styles.accountDetail}>
                  {accountInfo.bankName} {accountInfo.accountNumber}
                </p>
                <p style={styles.accountDetail}>
                  예금주: {accountInfo.holderName}
                </p>
                {canRemit && (
                  <button
                    style={{
                      ...styles.remitBtn,
                      opacity: !remitting ? 1 : 0.5,
                      cursor: !remitting ? 'pointer' : 'not-allowed',
                    }}
                    onClick={handleRemit}
                    disabled={remitting}
                  >
                    {remitting ? '통보 중...' : '원화 송금했어요'}
                  </button>
                )}
              </div>
            )}

            {isMine && (
              <button
                style={styles.detailBtn}
                onClick={() => onSelectOrder(order.orderId)}
              >
                진행 상황 보기
              </button>
            )}
          </div>
        )}
      </div>

      <div style={styles.bottom}>
        <span style={styles.meta}>#{order.orderId}</span>
        <span style={styles.meta}>{order.expiration > 0 ? formatDate(order.expiration) : ''}</span>
      </div>
    </div>
  );
}

const styles = {
  cardTaken: {
    // 손댈 수 없는 주문임을 한눈에. 정보는 계속 읽히게 과하지 않은 수준으로.
    background: '#FAFAFA',
    opacity: 0.72,
    boxShadow: 'none',
    border: '1px dashed #D1D5DB',
  },
  statusRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 6,
  },
  lockBadge: {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600 as const,
    background: '#F3F4F6',
    color: '#4B5563',
    border: '1px solid #E5E7EB',
  },
  mineBadge: {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 700 as const,
    background: '#EEF2FF',
    color: '#4338CA',
  },
  takenNotice: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.6,
    color: '#6B7280',
  },
  detailBtn: {
    alignSelf: 'flex-start' as const,
    background: '#EEF2FF',
    color: '#4338CA',
    border: 'none',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  card: {
    background: '#fff',
    borderRadius: 10,
    padding: '16px 20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  top: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  price: {
    fontSize: 20,
    fontWeight: 600 as const,
    color: '#4F46E5',
  },
  timeLeft: {
    fontSize: 13,
    fontWeight: 500 as const,
  },
  middle: {
    marginBottom: 8,
  },
  claimBtn: {
    background: '#4F46E5',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  cancelBtn: {
    background: 'transparent',
    color: '#666',
    border: '1px solid #ddd',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 500 as const,
    cursor: 'pointer',
  },
  statusBadge: {
    display: 'inline-block',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 500 as const,
  },
  bottom: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  meta: {
    fontSize: 12,
    color: '#999',
  },
  invoiceSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  invoiceDesc: {
    fontSize: 13,
    color: '#333',
    margin: 0,
    lineHeight: 1.5,
  },
  invoiceHint: {
    fontSize: 12,
    color: '#888',
    margin: 0,
    lineHeight: 1.5,
  },
  invoiceInputRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'flex-start',
  },
  invoiceInput: {
    flex: 1,
    padding: 10,
    border: '1px solid #ddd',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'monospace',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
  },
  qrBtn: {
    padding: '10px 12px',
    border: '1px solid #ddd',
    borderRadius: 6,
    background: '#f9f9f9',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    flexShrink: 0,
  },
  invoiceError: {
    fontSize: 12,
    color: '#DC2626',
    margin: 0,
  },
  invoiceSuccess: {
    fontSize: 12,
    color: '#16A34A',
    margin: 0,
    fontWeight: 500 as const,
  },
  invoiceBtns: {
    display: 'flex',
    gap: 8,
  },
  waitingBadge: {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500 as const,
    background: '#FEF3C7',
    color: '#D97706',
  },
  accountSection: {
    background: '#F9FAFB',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  accountTitle: {
    fontSize: 12,
    fontWeight: 600 as const,
    color: '#333',
    margin: 0,
  },
  accountDetail: {
    fontSize: 13,
    color: '#555',
    margin: 0,
    fontFamily: 'monospace',
  },
  priceErrorMsg: {
    fontSize: 12,
    color: '#DC2626',
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: 6,
    padding: '8px 12px',
    margin: 0,
    lineHeight: 1.5,
  },
  remitBtn: {
    marginTop: 4,
    background: '#059669',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  depositSection: {
    background: '#FFF7ED',
    border: '1px solid #FED7AA',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 4,
  },
  depositDesc: {
    fontSize: 13,
    color: '#C2410C',
    fontWeight: 500 as const,
    margin: 0,
    textAlign: 'center' as const,
  },
  depositNotice: {
    fontSize: 11,
    color: '#6B7280',
    margin: 0,
    textAlign: 'center' as const,
  },
  depositStatusBadge: {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500 as const,
  },
};
