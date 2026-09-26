/**
 * 홈 화면에 추가
 *
 * ── "설치"와 "홈 화면에 추가"는 다른 것인가
 *
 * 브라우저마다 말이 다를 뿐 결과는 둘로 갈린다.
 *
 * **진짜 설치(PWA)** — manifest 조건(이름·아이콘·start_url·display:standalone)과
 * 서비스워커를 갖춘 사이트만 자격이 생긴다. 주소창 없는 독립 창으로 뜨고, 앱
 * 목록에 들어가며, **푸시 알림을 받을 수 있다.**
 *
 * **단순 바로가기** — 자격이 없는 사이트에 안드로이드 크롬이 대신 주는 것.
 * 그냥 북마크라서 눌러도 브라우저 탭으로 열린다. 아이콘만 홈에 생긴다.
 *
 * 우리 앱은 자격을 갖췄으므로(manifest + sw.js) 어디서든 "진짜 설치"가 된다.
 * 크롬 계열이 메뉴에 두 항목을 같이 보여주는 경우가 있는데, 그건 자격 있는
 * 사이트에 "설치"를, 그와 별개로 바로가기 생성을 함께 노출하는 것이다.
 *
 * ── 원터치는 안드로이드까지만 가능하다
 *
 * 크롬 계열은 `beforeinstallprompt`를 주므로 우리 버튼에서 바로 설치 창을 띄울 수
 * 있다. **아이폰은 그런 API가 없다.** 사파리는 공유 시트를 거치는 수동 경로만
 * 제공하고, 웹에서 그 시트를 열 방법을 주지 않는다. 그래서 iOS는 원터치가
 * 불가능하고, 할 수 있는 건 어디를 눌러야 하는지 정확히 알려주는 것뿐이다.
 *
 * iOS에서 이게 중요한 이유: **홈 화면에 추가해야만 웹 푸시가 켜진다.**
 * 사파리 탭에서는 PushManager 자체가 없다.
 */
import { useEffect, useState } from 'react';
import { ui } from '../ui';

/** 크롬 계열이 주는 설치 프롬프트 이벤트. 표준 타입에 없어 직접 좁힌다. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    // iOS 사파리는 display-mode를 안 주고 navigator.standalone으로 알린다.
    || (navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export function InstallApp() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    // 이 이벤트는 앱이 뜬 직후에 오므로, 늦게 붙으면 놓친다.
    // 그래도 이미 설치된 기기에서는 아예 오지 않는 게 정상이다.
    const onPrompt = (e: Event) => {
      e.preventDefault(); // 브라우저 기본 배너를 막고 우리 버튼으로 돌린다
      setPromptEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function handleInstall() {
    if (!promptEvent) return;
    try {
      await promptEvent.prompt();
    } catch (e) {
      console.warn('[설치] 프롬프트를 띄우지 못했다', e);
    } finally {
      // 프롬프트는 한 번 쓰면 재사용할 수 없다. 거절당했으면 브라우저가
      // 나중에 이벤트를 다시 준다.
      setPromptEvent(null);
    }
  }

  if (installed) {
    return (
      <div style={ui.panel}>
        <b style={styles.title}>앱으로 실행 중</b>
        <p style={styles.text}>홈 화면에서 연 상태입니다. 알림을 켤 수 있습니다.</p>
      </div>
    );
  }

  if (promptEvent) {
    return (
      <div style={ui.panel}>
        <b style={styles.title}>홈 화면에 추가</b>
        <p style={styles.text}>
          주소창 없이 앱처럼 열리고, 알림도 더 안정적으로 받습니다.
        </p>
        <button onClick={() => void handleInstall()} style={ui.primaryButton}>홈 화면에 추가</button>
      </div>
    );
  }

  if (isIos()) {
    return (
      <div style={ui.panel}>
        <b style={styles.title}>홈 화면에 추가 (아이폰)</b>
        <p style={styles.text}>
          <b>아이폰은 알림을 받으려면 이 단계가 반드시 필요합니다.</b> 사파리가
          자동 추가를 지원하지 않아 직접 눌러주셔야 합니다.
        </p>
        <ol style={styles.steps}>
          <li style={styles.step}>
            화면 아래 <b>공유 버튼</b>(<span style={styles.share}>􀈂</span> 위쪽 화살표)을 누릅니다
          </li>
          <li style={styles.step}>목록을 내려 <b>홈 화면에 추가</b>를 누릅니다</li>
          <li style={styles.step}>추가된 아이콘으로 다시 열어 알림을 켭니다</li>
        </ol>
        <p style={styles.note}>
          사파리가 아닌 브라우저(크롬·웨일 등)에서는 이 메뉴가 없습니다. 사파리로
          열어주세요.
        </p>
      </div>
    );
  }

  // 안드로이드인데 이벤트가 아직 안 왔거나, 데스크탑 브라우저가 지원하지 않는 경우.
  return (
    <div style={ui.panel}>
      <b style={styles.title}>홈 화면에 추가</b>
      <p style={styles.text}>
        브라우저 메뉴(⋮)에서 <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 누르면
        앱처럼 쓸 수 있습니다.
      </p>
    </div>
  );
}

const styles = {
  title: { fontSize: 15 },
  text: {
    margin: '8px 0 12px 0',
    fontSize: 13,
    lineHeight: 1.6,
    color: '#4B5563',
  },
  steps: {
    margin: '0 0 8px 0',
    paddingLeft: 20,
    fontSize: 13,
    color: '#4B5563',
  },
  step: { marginBottom: 6, lineHeight: 1.6 },
  share: { fontFamily: 'system-ui' },
  note: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.6,
    color: '#9CA3AF',
  },
};
