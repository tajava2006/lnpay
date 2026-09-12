import { useState, useCallback, useSyncExternalStore, lazy, Suspense } from 'react';
import { InvoicePayBlock, sponsorRelation } from '@sajwo-tracker/shared';
import type { Order, PriceTracker } from '@sajwo-tracker/shared';
import { publishClaim, publishRemitRequest } from '../nostr/claim';
import { getStateMeta } from '../order-states';
import { decodeBolt11 } from '../bolt11';
import type { Bolt11Result } from '../bolt11';
import { subscribeAccountInfo, getAccountInfoSnapshot } from '../account-store';
import { subscribeClaimErrors, getClaimErrorSnapshot, clearClaimError } from '../claim-error-store';
import { subscribe as subscribeDeposits, getSnapshot as getDepositSnapshot } from '../deposit-store';
// QR 스캐너는 jsqr(~30KB)을 끌고 오는데 클레임할 때만 쓴다.
// 첫 화면이 오더북이라 대부분의 방문에서 쓰이지 않으므로 지연 로딩한다.
const QrScanner = lazy(() => import('./QrScanner').then(m => ({ default: m.QrScanner })));

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

function formatSats(msat: number): string {
  const sats = Math.floor(msat / 1000);
  return sats.toLocaleString() + ' sats';
}

function krwToSats(krw: number, btcKrw: number): number {
  return Math.round((krw / btcKrw) * 1e8);
}

export function OrderCard({ order, now, tracker, myPubkey, onSelectOrder }: Props) {
  const [claiming, setClaiming] = useState(false);
  const [showInvoiceInput, setShowInvoiceInput] = useState(false);
  const [frozenBtcPrice, setFrozenBtcPrice] = useState<number | null>(null);
  const [invoiceText, setInvoiceText] = useState('');
  const [invoiceResult, setInvoiceResult] = useState<Bolt11Result | null>(null);
  const [remitting, setRemitting] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);

  const handleQrScan = useCallback((data: string) => {
    setShowQrScanner(false);
    handleInvoiceChange(data);
  }, []);

  const priceSnap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
  const btcKrw = frozenBtcPrice ?? priceSnap.price;
  const expectedSats = btcKrw && order.price > 0
    ? krwToSats(order.price, btcKrw)
    : null;

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
  const showAccountInfo = isMine && order.state === 'escrowed' && accountInfo;
  const showWaitingAccount = isMine && order.state === 'escrowed' && !accountInfo;
  const canRemit = isMine && order.state === 'escrowed' && accountInfo;

  function handleInvoiceChange(value: string) {
    setInvoiceText(value);
    if (!value.trim()) {
      setInvoiceResult(null);
      return;
    }
    setInvoiceResult(decodeBolt11(value));
  }

  async function handleClaim() {
    if (!invoiceResult || !invoiceResult.valid) return;

    setClaiming(true);
    try {
      const ok = await publishClaim(order, invoiceText.trim().toLowerCase());
      if (ok) {
        setShowInvoiceInput(false);
        setFrozenBtcPrice(null);
        setInvoiceText('');
        setInvoiceResult(null);
      } else {
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
  const amountMatch = (() => {
    if (!invoiceResult?.valid || !expectedSats) return true;
    const invoiceSats = Math.floor(invoiceResult.amountMsat! / 1000);
    return invoiceSats === expectedSats;
  })();

  const isInvoiceValid = invoiceResult?.valid === true && amountMatch;

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
          showInvoiceInput ? (
            <div style={styles.invoiceSection}>
              {claimError && (
                <p style={styles.priceErrorMsg}>
                  인보이스 금액이 현재 시세와 맞지 않습니다.
                  현재 시세 기준 {claimError.expectedSats.toLocaleString()} sats로 재발행해 주세요.
                </p>
              )}
              <p style={styles.invoiceDesc}>
                유동성 검증을 위해{' '}
                {expectedSats !== null
                  ? <strong>{expectedSats.toLocaleString()} sats</strong>
                  : <strong>{order.price.toLocaleString()}원</strong>
                }의 Lightning invoice를 붙여넣어 주세요.
              </p>
              <p style={styles.invoiceHint}>
                본인 지갑에서 위 금액의 invoice를 생성한 뒤 여기에 붙여넣으면,
                에스크로가 Lightning 경로를 검증합니다. 실제 결제는 발생하지 않습니다.
              </p>
              <div style={styles.invoiceInputRow}>
                <textarea
                  style={styles.invoiceInput}
                  placeholder="lnbc..."
                  value={invoiceText}
                  onChange={e => handleInvoiceChange(e.target.value)}
                  rows={3}
                />
                <button
                  style={styles.qrBtn}
                  onClick={() => setShowQrScanner(true)}
                  title="QR 코드 스캔"
                  type="button"
                >
                  📷
                </button>
              </div>
              {showQrScanner && (
                <Suspense fallback={null}>
                  <QrScanner onScan={handleQrScan} onClose={() => setShowQrScanner(false)} />
                </Suspense>
              )}
              {invoiceResult && !invoiceResult.valid && (
                <p style={styles.invoiceError}>{invoiceResult.error}</p>
              )}
              {invoiceResult?.valid && (
                <p style={amountMatch ? styles.invoiceSuccess : styles.invoiceError}>
                  {formatSats(invoiceResult.amountMsat!)}
                  {!amountMatch && expectedSats !== null && (
                    ` — ${expectedSats.toLocaleString()} sats로 발행해 주세요.`
                  )}
                </p>
              )}
              <div style={styles.invoiceBtns}>
                <button
                  style={{
                    ...styles.claimBtn,
                    opacity: isInvoiceValid && !claiming ? 1 : 0.5,
                    cursor: isInvoiceValid && !claiming ? 'pointer' : 'not-allowed',
                  }}
                  onClick={handleClaim}
                  disabled={!isInvoiceValid || claiming}
                >
                  {claiming ? '발행 중...' : '클레임 발행'}
                </button>
                <button
                  style={styles.cancelBtn}
                  onClick={() => {
                    setShowInvoiceInput(false);
                    setFrozenBtcPrice(null);
                    setInvoiceText('');
                    setInvoiceResult(null);
                  }}
                  disabled={claiming}
                >
                  취소
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                style={styles.claimBtn}
                onClick={() => {
                  clearClaimError(order.orderId);
                  setFrozenBtcPrice(priceSnap.price);
                  setShowInvoiceInput(true);
                }}
              >
                사줄게
              </button>
              {claimError && (
                <p style={styles.priceErrorMsg}>
                  클레임이 거부되었습니다.
                  현재 시세 기준 {claimError.expectedSats.toLocaleString()} sats로 재발행해 주세요.
                </p>
              )}
            </>
          )
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
