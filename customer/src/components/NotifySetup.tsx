/**
 * 알림 설정 안내
 *
 * 이 앱은 유저의 연락처를 모른다. 그게 설계 전제라 문자·카톡은 선택지가 아니다 —
 * 둘 다 전화번호를 요구하고, 그걸 받는 순간 개인정보처리자가 되며 P2P 거래
 * 중재자가 양쪽 번호를 쥐는 구조가 된다.
 *
 * 그래서 **브라우저 알림(Web Push)** 하나다. 설치도 계정도 없이 "허용" 한 번. 안드로이드는 브라우저를
 * 닫아도 온다(구글 플레이 서비스가 깨운다).
 *
 * 화면 헤더에서 열리는 모달 — 특정 주문에 묶이지 않는 계정 단위 설정이라
 * 주문 상세가 아니라 헤더에 둔다.
 */
import { useEffect, useState } from 'react';
import { InstallApp } from './InstallApp';
import { checkPushSupport, subscribeToPush, getExistingSubscription, unsubscribeFromPush } from '../push/subscribe';
import { publishPushSubscription } from '../push/publish';
import { ui } from '../ui';

type PushState =
  | { kind: 'checking' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'off' }
  | { kind: 'working' }
  | { kind: 'on' }
  | { kind: 'error'; message: string };

export function NotifySetup({ onClose }: { onClose: () => void }) {
  const [push, setPush] = useState<PushState>({ kind: 'checking' });

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

        {/*
          설치 안내를 알림 위에 둔다. iOS는 홈 화면에 추가해야만 PushManager가
          생겨서, 순서가 뒤바뀌면 "알림 켜기"가 왜 막히는지 알 수 없다.
        */}
        <InstallApp />

        <PushSection state={push} onEnable={handleEnable} onDisable={handleDisable} />

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
    <div style={ui.panel}>
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
          <button onClick={onEnable} style={ui.primaryButton}>알림 켜기</button>
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
};
