/**
 * 알림 설정 안내
 *
 * 이 앱은 유저의 연락처를 모른다. 그게 설계 전제라 문자·이메일·카톡은 처음부터
 * 선택지가 아니다. 대신 유저에게 이미 nostr 키가 하나 있으니, 그 키를 아무 nostr
 * 클라이언트에 넣어두면 거래 알림이 거기로 간다.
 *
 * 화면 헤더에서 열리는 모달 — 특정 주문에 묶이지 않는 계정 단위 설정이라
 * 주문 상세가 아니라 헤더에 둔다.
 *
 * 안드로이드 Amethyst만 안내한다. NIP-17 DM 알림을 백그라운드로 제대로 받는
 * 클라이언트가 그것뿐이었다. iOS는 다음 두 가지로 제외한다:
 *   - Damus는 NIP-17을 지원하지 않고, Nostur는 지원하지만 알림이 없다
 *   - 애플 푸시는 구조적으로 애플 서버를 거친다. 중앙화 인프라를 타지 않는 게
 *     이 앱의 전제인데, 알림 하나 때문에 그걸 깨는 건 값이 맞지 않는다
 * 안내에 없는 클라이언트를 써도 되지만 동작은 보장하지 않는다.
 */
import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { nsecEncode } from 'nostr-tools/nip19';
import { getSecretKey, storage } from '@sajwo-tracker/shared';

export function NotifySetup({ onClose }: { onClose: () => void }) {
  const [nsec, setNsec] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleReveal() {
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
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.head}>
          <h2 style={styles.title}>거래 알림 받기</h2>
          <button onClick={onClose} style={styles.close} aria-label="닫기">✕</button>
        </div>

        <p style={styles.lead}>
          거래가 회원님 차례로 넘어올 때 휴대폰 알림을 받을 수 있습니다.
          결제할 때, 계좌를 보낼 때, 입금을 확인할 때 — 기다리지 않아도 되도록.
        </p>

        <ol style={styles.steps}>
          <li style={styles.step}>
            <b>Amethyst</b>를 설치합니다 (안드로이드).
            <div style={styles.sub}>
              Google Play 또는 zapstore에서 받을 수 있습니다.
            </div>
          </li>
          <li style={styles.step}>
            아래 키로 로그인합니다.
            <div style={styles.sub}>
              Amethyst 첫 화면의 로그인 칸에 붙여넣거나, QR을 스캔하세요.
            </div>
          </li>
          <li style={styles.step}>
            알림을 켭니다.
            <div style={styles.sub}>
              왼쪽 사이드바 맨 아래 <b>설정</b> → <b>알림</b> → <b>백그라운드 노티 서비스</b>를 켜면 됩니다.
              이걸 켜지 않으면 앱을 열어야만 알림이 보입니다.
            </div>
          </li>
        </ol>

        <div style={styles.keyBox}>
          {!nsec ? (
            <button onClick={handleReveal} style={styles.revealBtn}>
              로그인 키 보기
            </button>
          ) : (
            <>
              <div style={styles.qrWrap}>
                <QRCodeSVG value={nsec} size={180} level="M" />
              </div>
              <div style={styles.keyRow}>
                <code style={styles.keyText}>{nsec}</code>
                <button onClick={handleCopy} style={styles.copyBtn}>
                  {copied ? '복사됨' : '복사'}
                </button>
              </div>
            </>
          )}
        </div>

        <div style={styles.warnBox}>
          <b>이 키는 알림 수신용으로만 쓰세요.</b> 브라우저가 만들어 브라우저에 보관하는
          키라, 일반적인 nostr 신원으로 쓰기에는 적합하지 않습니다. 이 키로 글을 쓰거나
          다른 서비스에 로그인하지 마시고, 브라우저 데이터를 지우면 함께 사라진다는 점도
          알아두세요. 키를 아는 사람은 알림을 대신 볼 수 있으니 남에게 보여주지 마세요.
        </div>

        <p style={styles.note}>
          아이폰은 아직 안내드릴 방법이 없습니다. NIP-17 알림을 지원하는 iOS 클라이언트를
          찾지 못했고, 애플 푸시를 쓰려면 중앙 서버를 거쳐야 해서 이 앱의 전제와 맞지 않습니다.
          알림 없이도 모든 기능은 그대로 쓸 수 있습니다.
        </p>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    zIndex: 100,
  },
  modal: {
    background: 'white',
    borderRadius: 12,
    padding: 20,
    maxWidth: 460,
    width: '100%',
    maxHeight: '90vh',
    overflowY: 'auto' as const,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    margin: 0,
    fontSize: 18,
  },
  close: {
    border: 'none',
    background: 'none',
    fontSize: 18,
    color: '#9CA3AF',
    cursor: 'pointer',
    padding: 4,
    lineHeight: 1,
  },
  lead: {
    margin: '0 0 16px 0',
    fontSize: 14,
    lineHeight: 1.6,
    color: '#374151',
  },
  steps: {
    margin: '0 0 16px 0',
    paddingLeft: 20,
    fontSize: 14,
    color: '#374151',
  },
  step: {
    marginBottom: 12,
    lineHeight: 1.5,
  },
  sub: {
    marginTop: 4,
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 1.6,
  },
  keyBox: {
    padding: 16,
    background: '#F9FAFB',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    marginBottom: 16,
    textAlign: 'center' as const,
  },
  revealBtn: {
    padding: '8px 18px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  qrWrap: {
    display: 'inline-block',
    padding: 12,
    background: 'white',
    borderRadius: 8,
    marginBottom: 12,
  },
  keyRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  keyText: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'monospace',
    wordBreak: 'break-all' as const,
    color: '#374151',
    textAlign: 'left' as const,
  },
  copyBtn: {
    padding: '6px 14px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 4,
    fontSize: 13,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    fontFamily: 'inherit',
  },
  warnBox: {
    padding: 12,
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.6,
    color: '#991B1B',
    marginBottom: 12,
  },
  note: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.6,
    color: '#9CA3AF',
  },
};
