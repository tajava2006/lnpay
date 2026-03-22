import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { decodeBolt11 } from '../utils/bolt11';

interface Props {
  orderId: string;
  bolt11: string;
  price: number;
  tracker: PriceTracker;
  onClose: () => void;
  /** 모달 제목 (기본: "Lightning 결제") */
  title?: string;
}

const FAIR_RATIO_LIMIT = 1.05;

function formatSats(sats: number): string {
  return sats.toLocaleString() + ' sats';
}

export function InvoiceModal({ orderId, bolt11, price, tracker, onClose, title }: Props) {
  const [copied, setCopied] = useState(false);

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

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(bolt11);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = bolt11;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  const truncated = bolt11.length > 40
    ? `${bolt11.slice(0, 20)}...${bolt11.slice(-10)}`
    : bolt11;

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.headerTitle}>{title ?? 'Lightning 결제'}</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>
        <div style={styles.body}>
          <p style={styles.orderLabel}>주문 #{orderId}</p>

          {decoded && (
            <div style={styles.amountSection}>
              <span style={styles.amountValue}>{formatSats(decoded.amountSat)}</span>
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
            </div>
          )}

          <div style={styles.qrContainer}>
            <QRCodeSVG
              value={`lightning:${bolt11}`}
              size={280}
              bgColor="#ffffff"
              fgColor="#1a1a2e"
            />
          </div>
          <p style={styles.hint}>QR 코드를 Lightning 지갑으로 스캔하세요</p>
          <div style={styles.bolt11Row}>
            <code style={styles.bolt11Text}>{truncated}</code>
            <button onClick={handleCopy} style={styles.copyBtn}>
              {copied ? '복사됨!' : '복사'}
            </button>
          </div>
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
    padding: 32,
    maxWidth: 400,
    width: '90%',
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
  qrContainer: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 16,
  },
  hint: {
    fontSize: 13,
    color: '#999',
    margin: '0 0 16px',
  },
  bolt11Row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: '#f8f9fa',
    borderRadius: 8,
    padding: '10px 12px',
  },
  bolt11Text: {
    flex: 1,
    fontSize: 12,
    color: '#666',
    wordBreak: 'break-all' as const,
    textAlign: 'left' as const,
    fontFamily: 'monospace',
  },
  copyBtn: {
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    flexShrink: 0,
  },
};
