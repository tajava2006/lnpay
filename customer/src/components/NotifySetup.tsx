/**
 * 알림 설정 안내
 *
 * 이 앱은 유저의 연락처를 모른다. 그게 설계 전제라 문자·카톡은 선택지가 아니다 —
 * 둘 다 전화번호를 요구하고, 그걸 받는 순간 개인정보처리자가 되며 P2P 거래
 * 중재자가 양쪽 번호를 쥐는 구조가 된다.
 *
 * 그래서 두 경로를 준다:
 *
 * **브라우저 알림 (Web Push)** — 1순위. 설치도 계정도 없이 "허용" 한 번.
 * 안드로이드는 브라우저를 닫아도 온다(구글 플레이 서비스가 깨운다).
 *
 * **nostr 클라이언트 (NIP-17)** — 받침. 이미 nostr을 쓰는 사람이거나,
 * 브라우저 구독이 날아갔을 때. 접어두고 원하는 사람만 펼치게 한다.
 *
 * 화면 헤더에서 열리는 모달 — 특정 주문에 묶이지 않는 계정 단위 설정이라
 * 주문 상세가 아니라 헤더에 둔다.
 */
import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { nsecEncode } from 'nostr-tools/nip19';
import { getSecretKey, storage } from '@sajwo-tracker/shared';
import { checkPushSupport, subscribeToPush, getExistingSubscription, unsubscribeFromPush } from '../push/subscribe';
import { publishPushSubscription } from '../push/publish';

type PushState =
  | { kind: 'checking' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'off' }
  | { kind: 'working' }
  | { kind: 'on' }
  | { kind: 'error'; message: string };

export function NotifySetup({ onClose }: { onClose: () => void }) {
  const [push, setPush] = useState<PushState>({ kind: 'checking' });
  const [showNostr, setShowNostr] = useState(false);

  useEffect(() => {
    const support = checkPushSupport();
    if (!support.supported) {
      setPush({ kind: 'unsupported', reason: support.reason });
      return;
    }
    void getExistingSubscription()
      .then(sub => setPush({ kind: sub ? 'on' : 'off' }))
      .catch(() => setPush({ kind: 'off' }));
  }, []);

  async function handleEnable() {
    setPush({ kind: 'working' });
    try {
      const sub = await subscribeToPush();
      const ok = await publishPushSubscription(sub);
      if (!ok) throw new Error('구독 정보를 전달하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      setPush({ kind: 'on' });
    } catch (e) {
      setPush({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleDisable() {
    setPush({ kind: 'working' });
    try {
      await unsubscribeFromPush();
      setPush({ kind: 'off' });
    } catch {
      setPush({ kind: 'on' });
    }
  }

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.head}>
          <h2 style={styles.title}>거래 알림 받기</h2>
          <button onClick={onClose} style={styles.close} aria-label="닫기">✕</button>
        </div>

        <p style={styles.lead}>
          거래가 회원님 차례로 넘어올 때 알려드립니다. 결제할 때, 계좌를 보낼 때,
          입금을 확인할 때 — 화면을 지켜보지 않아도 되도록.
        </p>

        <PushSection state={push} onEnable={handleEnable} onDisable={handleDisable} />

        <button onClick={() => setShowNostr(v => !v)} style={styles.disclosure}>
          {showNostr ? '▾' : '▸'} nostr 클라이언트로 받기 (선택)
        </button>
        {showNostr && <NostrSection />}
      </div>
    </div>
  );
}

function PushSection({ state, onEnable, onDisable }: {
  state: PushState;
  onEnable: () => void;
  onDisable: () => void;
}) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <b>브라우저 알림</b>
        {state.kind === 'on' && <span style={styles.badgeOn}>켜짐</span>}
      </div>

      {state.kind === 'checking' && <p style={styles.cardText}>확인 중…</p>}

      {state.kind === 'unsupported' && (
        <p style={styles.cardText}>{state.reason}</p>
      )}

      {(state.kind === 'off' || state.kind === 'error') && (
        <>
          <p style={styles.cardText}>
            설치할 것도, 계정을 만들 것도 없습니다. 아래 버튼을 누르고 브라우저가 묻는
            알림 권한을 허용하면 끝입니다. 켜지면 <b>확인 알림이 하나</b> 갑니다 —
            그게 오면 제대로 된 겁니다.
          </p>
          <p style={styles.cardSub}>
            맥이나 윈도우에서는 브라우저가 알림을 처음 띄울 때 운영체제가 한 번 더
            물어볼 수 있습니다. 그것도 허용해 주세요.
          </p>
          {state.kind === 'error' && <p style={styles.err}>{state.message}</p>}
          <button onClick={onEnable} style={styles.primaryBtn}>알림 켜기</button>
        </>
      )}

      {state.kind === 'working' && <p style={styles.cardText}>처리 중…</p>}

      {state.kind === 'on' && (
        <>
          <p style={styles.cardText}>
            이 브라우저로 알림이 갑니다. 다른 기기에서도 받으려면 그 기기에서
            한 번 더 켜주세요.
          </p>
          <div style={styles.tipBox}>
            <b>안드로이드</b>라면 브라우저를 닫아도 알림이 옵니다. 다만 크롬을
            <b> 강제 종료</b>하면 끊기고, <b>삼성 갤럭시</b>는 절전 설정(설정 → 배터리 →
            백그라운드 사용 제한, "사용하지 않는 앱 절전")이 알림을 늦추거나 막을 수
            있으니 크롬을 예외로 두세요.
            <br /><br />
            <b>PC</b>는 창을 닫아도 되지만 브라우저를 완전히 종료(⌘Q)하면 안 옵니다.
          </div>
          <button onClick={onDisable} style={styles.ghostBtn}>알림 끄기</button>
        </>
      )}
    </div>
  );
}

function NostrSection() {
  const [nsec, setNsec] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleReveal() {
    setNsec(nsecEncode(await getSecretKey(storage)));
  }

  async function handleCopy() {
    if (!nsec) return;
    await navigator.clipboard.writeText(nsec);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={styles.card}>
      <p style={styles.cardText}>
        이미 nostr을 쓰신다면 이 키를 클라이언트에 넣어 알림을 받을 수도 있습니다.
        브라우저 알림을 켜셨다면 굳이 필요하지 않습니다.
      </p>

      <ol style={styles.steps}>
        <li style={styles.step}>
          <b>Amethyst</b> 설치 (안드로이드)
        </li>
        <li style={styles.step}>
          아래 키로 로그인 (QR 스캔 또는 붙여넣기)
        </li>
        <li style={styles.step}>
          왼쪽 사이드바 맨 아래 <b>설정</b> → <b>알림</b> → <b>백그라운드 노티 서비스</b> 켜기
        </li>
      </ol>

      <div style={styles.keyBox}>
        {!nsec ? (
          <button onClick={handleReveal} style={styles.ghostBtn}>로그인 키 보기</button>
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
        키라 일반적인 nostr 신원으로는 적합하지 않습니다. 이 키로 글을 쓰거나 다른
        서비스에 로그인하지 마시고, 남에게 보여주지 마세요.
      </div>

      <p style={styles.note}>
        아이폰은 NIP-17 알림을 지원하는 클라이언트를 찾지 못했습니다. 대신 이 페이지를
        홈 화면에 추가하면 위의 브라우저 알림을 쓸 수 있습니다.
      </p>
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
  title: { margin: 0, fontSize: 18 },
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
  card: {
    padding: 16,
    background: '#F9FAFB',
    border: '1px solid #E5E7EB',
    borderRadius: 8,
    marginBottom: 12,
  },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    fontSize: 15,
  },
  badgeOn: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#DCFCE7',
    color: '#166534',
  },
  cardText: {
    margin: '0 0 12px 0',
    fontSize: 13,
    lineHeight: 1.6,
    color: '#4B5563',
  },
  cardSub: {
    margin: '0 0 12px 0',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#9CA3AF',
  },
  primaryBtn: {
    padding: '9px 20px',
    background: '#4F46E5',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  ghostBtn: {
    padding: '7px 16px',
    background: 'transparent',
    color: '#6B7280',
    border: '1px solid #D1D5DB',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  disclosure: {
    width: '100%',
    textAlign: 'left' as const,
    padding: '8px 0',
    border: 'none',
    background: 'none',
    color: '#6B7280',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tipBox: {
    padding: 12,
    background: '#FFFBEB',
    border: '1px solid #FDE68A',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.6,
    color: '#78350F',
    marginBottom: 12,
  },
  err: {
    margin: '0 0 12px 0',
    fontSize: 13,
    lineHeight: 1.6,
    color: '#DC2626',
  },
  steps: {
    margin: '0 0 12px 0',
    paddingLeft: 20,
    fontSize: 13,
    color: '#4B5563',
  },
  step: { marginBottom: 6, lineHeight: 1.6 },
  keyBox: { marginBottom: 12, textAlign: 'center' as const },
  qrWrap: {
    display: 'inline-block',
    padding: 12,
    background: 'white',
    borderRadius: 8,
    marginBottom: 12,
  },
  keyRow: { display: 'flex', gap: 8, alignItems: 'center' },
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
    fontSize: 12,
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
