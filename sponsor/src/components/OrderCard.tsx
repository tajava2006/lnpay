import { useState, useSyncExternalStore } from 'react';
import type { SajwoRequest } from '../types';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { publishClaim } from '../nostr/claim';
import { transitionOrder } from '../state-machine';
import { getStatusMeta } from '../order-states';
import { decodeBolt11 } from '../utils/bolt11';
import type { Bolt11Result } from '../utils/bolt11';

interface Props {
  request: SajwoRequest;
  now: number;
  tracker: PriceTracker;
}

function formatTimeLeft(expiresAt: number | null, now: number): string {
  if (!expiresAt) return '기한 없음';

  const diff = expiresAt - now;

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

/** KRW 금액을 BTC 가격 기준으로 sats로 환산 */
function krwToSats(krw: number, btcKrw: number): number {
  return Math.round((krw / btcKrw) * 1e8);
}

export function OrderCard({ request, now, tracker }: Props) {
  const [claiming, setClaiming] = useState(false);
  const [showInvoiceInput, setShowInvoiceInput] = useState(false);
  const [invoiceText, setInvoiceText] = useState('');
  const [invoiceResult, setInvoiceResult] = useState<Bolt11Result | null>(null);

  const priceSnap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
  const btcKrw = priceSnap.price;
  const expectedSats = btcKrw && request.price > 0
    ? krwToSats(request.price, btcKrw)
    : null;

  const timeLeft = formatTimeLeft(request.expiresAt, now);
  const isUrgent = request.expiresAt
    ? request.expiresAt - now < 3600
    : false;

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
      const ok = await publishClaim(request, invoiceText.trim().toLowerCase());
      if (ok) {
        transitionOrder(request.orderId, 'claimed');
        setShowInvoiceInput(false);
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

  const isDetected = request.status === 'detected';
  const canRevert = request.status === 'claimed' || request.status === 'rejected';
  const statusMeta = getStatusMeta(request.status);

  // 금액 범위 검증: invoice 금액이 예상 BTC 환산의 90~110% 이내인지
  const amountInRange = (() => {
    if (!invoiceResult?.valid || !expectedSats) return true; // 가격 정보 없으면 검증 스킵
    const invoiceSats = Math.floor(invoiceResult.amountMsat! / 1000);
    return invoiceSats >= expectedSats * 0.9 && invoiceSats <= expectedSats * 1.1;
  })();

  const isInvoiceValid = invoiceResult?.valid === true && amountInRange;

  return (
    <div style={styles.card}>
      <div style={styles.top}>
        <span style={styles.price}>
          {request.price.toLocaleString()}{request.currency === 'KRW' ? '원' : ` ${request.currency}`}
        </span>
        <span style={{
          ...styles.timeLeft,
          color: isUrgent ? '#DC2626' : '#666',
        }}>
          {timeLeft}
        </span>
      </div>

      <div style={styles.middle}>
        {!isDetected ? (
          <div style={styles.statusRow}>
            <span style={{
              ...styles.statusBadge,
              background: statusMeta.bgColor,
              color: statusMeta.textColor,
            }}>
              {statusMeta.label}
            </span>
            {canRevert && (
              <button
                style={styles.revertBtn}
                onClick={() => transitionOrder(request.orderId, 'detected')}
              >
                인보이스 변경
              </button>
            )}
          </div>
        ) : showInvoiceInput ? (
          <div style={styles.invoiceSection}>
            <p style={styles.invoiceDesc}>
              유동성 검증을 위해 <strong>{request.price.toLocaleString()}원
              {expectedSats !== null && ` (약 ${expectedSats.toLocaleString()} sats)`}</strong> 상당의
              Lightning invoice를 붙여넣어 주세요.
            </p>
            <p style={styles.invoiceHint}>
              본인 지갑에서 해당 금액의 invoice를 생성한 뒤 여기에 붙여넣으면,
              에스크로가 Lightning 경로를 검증합니다. 실제 결제는 발생하지 않습니다.
            </p>
            <textarea
              style={styles.invoiceInput}
              placeholder="lnbc..."
              value={invoiceText}
              onChange={e => handleInvoiceChange(e.target.value)}
              rows={3}
            />
            {invoiceResult && !invoiceResult.valid && (
              <p style={styles.invoiceError}>{invoiceResult.error}</p>
            )}
            {invoiceResult?.valid && (
              <p style={amountInRange ? styles.invoiceSuccess : styles.invoiceError}>
                {formatSats(invoiceResult.amountMsat!)}
                {!amountInRange && expectedSats !== null && (
                  ` — 예상 범위(${Math.floor(expectedSats * 0.9).toLocaleString()}~${Math.ceil(expectedSats * 1.1).toLocaleString()} sats)를 벗어납니다.`
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
          <button
            style={styles.claimBtn}
            onClick={() => setShowInvoiceInput(true)}
          >
            사줄게
          </button>
        )}
      </div>

      <div style={styles.bottom}>
        <span style={styles.meta}>#{request.orderId}</span>
        <span style={styles.meta}>{request.expiresAt ? formatDate(request.expiresAt) : ''}</span>
      </div>
    </div>
  );
}

const styles = {
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
  invoiceInput: {
    width: '100%',
    padding: 10,
    border: '1px solid #ddd',
    borderRadius: 6,
    fontSize: 12,
    fontFamily: 'monospace',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
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
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  revertBtn: {
    background: 'transparent',
    color: '#666',
    border: '1px solid #ddd',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 500 as const,
    cursor: 'pointer',
  },
};
