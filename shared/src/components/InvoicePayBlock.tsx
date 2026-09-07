import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface Props {
  bolt11: string;
  /** QR 한 변의 최대 px. 컨테이너가 더 좁으면 그에 맞춰 줄어든다 (기본 280) */
  maxQrSize?: number;
  /** QR 아래 안내 문구 (기본: PC/모바일 양쪽 안내) */
  hint?: string;
}

/**
 * Lightning 인보이스 결제 블록 — QR + 지갑 열기 + 복사 + 전체 인보이스.
 *
 * 모바일에서는 QR을 스캔할 두 번째 기기가 없으므로 "지갑 앱으로 열기"(lightning: 스킴)가
 * 주 경로고, 복사와 전체 인보이스 노출(길게 눌러 복사)이 폴백이다.
 */
export function InvoicePayBlock({ bolt11, maxQrSize = 280, hint }: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');

  async function handleCopy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(bolt11);
      ok = true;
    } catch {
      ok = legacyCopy(bolt11);
    }
    setCopyState(ok ? 'done' : 'failed');
    if (ok) setTimeout(() => setCopyState('idle'), 2000);
  }

  return (
    <div style={styles.container}>
      <div style={styles.qrWrap}>
        <QRCodeSVG
          value={`lightning:${bolt11}`}
          size={maxQrSize}
          level="M"
          bgColor="#ffffff"
          fgColor="#1a1a2e"
          style={{ width: '100%', height: 'auto', maxWidth: maxQrSize, borderRadius: 8 }}
        />
      </div>

      <p style={styles.hint}>{hint ?? 'QR을 다른 기기의 Lightning 지갑으로 스캔하거나, 이 기기의 지갑 앱으로 여세요'}</p>

      <div style={styles.actions}>
        <a href={`lightning:${bolt11}`} style={styles.openBtn}>
          지갑 앱으로 열기
        </a>
        <button type="button" onClick={handleCopy} style={styles.copyBtn}>
          {copyState === 'done' ? '복사됨!' : '인보이스 복사'}
        </button>
      </div>

      {copyState === 'failed' && (
        <p style={styles.copyFailed}>복사에 실패했습니다. 아래 인보이스를 길게 눌러 복사하세요.</p>
      )}

      <code style={styles.bolt11}>{bolt11}</code>
    </div>
  );
}

/** clipboard API가 막힌 환경(비-https, 구형 iOS)용 폴백. 성공 여부를 반환한다. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  const sel = document.getSelection();
  const prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

  ta.select();
  ta.setSelectionRange(0, text.length); // iOS는 select()만으론 선택이 안 잡힌다

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  ta.remove();
  if (sel && prevRange) {
    sel.removeAllRanges();
    sel.addRange(prevRange);
  }
  return ok;
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'stretch',
    gap: 10,
    width: '100%',
  },
  qrWrap: {
    display: 'flex',
    justifyContent: 'center',
  },
  hint: {
    fontSize: 12,
    color: '#999',
    margin: 0,
    textAlign: 'center' as const,
    lineHeight: 1.5,
  },
  actions: {
    display: 'flex',
    gap: 8,
  },
  openBtn: {
    flex: 1,
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 8,
    padding: '12px 10px',
    fontSize: 14,
    fontWeight: 600 as const,
    textAlign: 'center' as const,
    textDecoration: 'none',
    cursor: 'pointer',
  },
  copyBtn: {
    flex: 1,
    background: '#E5E7EB',
    color: '#374151',
    border: 'none',
    borderRadius: 8,
    padding: '12px 10px',
    fontSize: 14,
    fontWeight: 600 as const,
    cursor: 'pointer',
  },
  copyFailed: {
    fontSize: 12,
    color: '#DC2626',
    margin: 0,
    textAlign: 'center' as const,
  },
  bolt11: {
    display: 'block',
    background: '#f8f9fa',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#666',
    textAlign: 'left' as const,
    wordBreak: 'break-all' as const,
    userSelect: 'all' as const,
    WebkitUserSelect: 'all' as const,
    maxHeight: 84,
    overflowY: 'auto' as const,
  },
};
