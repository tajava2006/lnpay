import { useState } from 'react';
import { nsecEncode } from 'nostr-tools/nip19';
import { getSecretKey, storage } from '@sajwo-tracker/shared';

export function KeyExport() {
  const [nsec, setNsec] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleShow() {
    if (nsec) {
      setNsec(null);
      return;
    }
    const sk = await getSecretKey(storage);
    setNsec(nsecEncode(sk));
  }

  async function handleCopy() {
    if (!nsec) return;
    await navigator.clipboard.writeText(nsec);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={styles.container}>
      <button onClick={handleShow} style={styles.toggleBtn}>
        {nsec ? '키 숨기기' : '유저스크립트 키 보기'}
      </button>
      {nsec && (
        <div style={styles.keyArea}>
          <p style={styles.warning}>
            이 키를 유저스크립트 설치 시 1회만 입력합니다. 타인에게 공유하지 마세요.
          </p>
          <div style={styles.keyRow}>
            <code style={styles.keyText}>{nsec}</code>
            <button onClick={handleCopy} style={styles.copyBtn}>
              {copied ? '복사됨' : '복사'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    marginTop: 8,
  },
  toggleBtn: {
    padding: '6px 14px',
    background: 'transparent',
    color: '#6B7280',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
  },
  keyArea: {
    marginTop: 8,
    padding: 12,
    background: '#FEF2F2',
    borderRadius: 8,
    border: '1px solid #FECACA',
  },
  warning: {
    fontSize: 12,
    color: '#DC2626',
    margin: '0 0 8px 0',
  },
  keyRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  keyText: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'monospace',
    wordBreak: 'break-all' as const,
    color: '#333',
  },
  copyBtn: {
    padding: '4px 12px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
};
