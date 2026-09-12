import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { InvoicePayBlock } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { decodeBolt11 } from '../bolt11';

interface Props {
  orderId: string;
  bolt11: string;
  price: number;
  tracker: PriceTracker;
  onClose: () => void;
  /** 모달 제목 (기본: "Lightning 결제") */
  title?: string;
  /** 보증금 모드 — fairness 대신 보증금 안내 표시 */
  isDeposit?: boolean;
}

const FAIR_RATIO_LIMIT = 1.05;

function formatSats(sats: number): string {
  return sats.toLocaleString() + ' sats';
}

export function InvoiceModal({ orderId, bolt11, price, tracker, onClose, title, isDeposit }: Props) {
  const priceSnap = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
  const btcKrw = priceSnap.price;

  const decoded = useMemo(() => decodeBolt11(bolt11), [bolt11]);

  // 시세 대비 적정성: 주문 KRW를 현재 BTC 가격으로 환산한 sats와 비교
  const fairness = useMemo(() => {
    if (!decoded || !btcKrw || price <= 0) return null;
    const expectedSats = Math.round((price / btcKrw) * 1e8);
    const ratio = decoded.amountSat / expectedSats;
    return { expectedSats, ratio };
  }, [decoded, btcKrw, price]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.headerTitle}>{title ?? 'Lightning 결제'}</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>
        <div style={styles.body}>
          <p style={styles.orderLabel}>의뢰 #{orderId}</p>

          {decoded && (
            <div style={styles.amountSection}>
              <span style={styles.amountValue}>{formatSats(decoded.amountSat)}</span>
              {isDeposit ? (
                <>
                  <span style={{ ...styles.fairnessLabel, color: '#059669' }}>
                    의뢰 금액의 약 {price > 0 && btcKrw ? Math.round((decoded.amountSat / ((price / btcKrw) * 1e8)) * 100) : '?'}%
                  </span>
                  <span style={styles.depositNotice}>
                    스팸 방지를 위한 보증금입니다. 거래 완료 후 전액 환불되며 수수료도 소모되지 않습니다.
                  </span>
                </>
              ) : (
                <>
                  {fairness && (() => {
                    const diffPct = Math.round((fairness.ratio - 1) * 100);
                    const isFair = fairness.ratio <= FAIR_RATIO_LIMIT;
                    return (
                      <span style={{
                        ...styles.fairnessLabel,
                        color: isFair ? '#059669' : '#D97706',
                      }}>
                        {isFair
                          ? `현재 시세 대비 적정 (${diffPct >= 0 ? '+' : ''}${diffPct}%) 합니다.`
                          : `시세 대비 ${diffPct}% 높음`
                        }
                      </span>
                    );
                  })()}
                  {fairness && (
                    <span style={styles.fairnessDetail}>
                      현재 시세 기준 약 {formatSats(fairness.expectedSats)}
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          <InvoicePayBlock bolt11={bolt11} />
        </div>
      </div>
    </>
  );
}

const styles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    zIndex: 999,
  },
  modal: {
    position: 'fixed' as const,
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    background: 'white',
    borderRadius: 16,
    padding: 20,
    maxWidth: 400,
    width: 'calc(100% - 24px)',
    maxHeight: 'calc(100dvh - 24px)',
    overflowY: 'auto' as const,
    zIndex: 1000,
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerTitle: {
    margin: 0,
    fontSize: 20,
    color: '#333',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 24,
    cursor: 'pointer',
    color: '#999',
    padding: '0 4px',
  },
  body: {
    textAlign: 'center' as const,
  },
  orderLabel: {
    fontSize: 14,
    color: '#666',
    margin: '0 0 12px',
  },
  amountSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 4,
    marginBottom: 16,
    padding: '12px 16px',
    background: '#F9FAFB',
    borderRadius: 10,
  },
  amountValue: {
    fontSize: 22,
    fontWeight: 700 as const,
    color: '#333',
  },
  fairnessLabel: {
    fontSize: 13,
    fontWeight: 600 as const,
  },
  fairnessDetail: {
    fontSize: 12,
    color: '#999',
  },
  depositNotice: {
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 1.5,
    marginTop: 4,
  },
};
