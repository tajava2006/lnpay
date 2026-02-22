import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface Props {
  orderId: string;
  bolt11: string;
  onClose: () => void;
}

export function InvoiceModal({ orderId, bolt11, onClose }: Props) {
  const [copied, setCopied] = useState(false);

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
          <h3 style={styles.headerTitle}>Lightning 결제</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>
        <div style={styles.body}>
          <p style={styles.orderLabel}>주문 #{orderId}</p>
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
    margin: '0 0 16px',
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
