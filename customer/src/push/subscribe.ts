/**
 * Web Push 구독
 *
 * ── 왜 이게 알림의 1순위인가
 *
 * 유저는 앱을 따로 설치하지 않으려 한다. 문자·카톡은 전화번호를 요구하는데
 * 그건 이 앱의 전제(신원 없이 거래)를 깬다. Web Push는 브라우저에서 "허용" 한
 * 번이면 끝이고, 계정도 번호도 설치도 없다.
 *
 * 전송은 구글·애플·모질라 서버를 지나지만 그들과 **관계가 없다** — 계정도
 * 승인도 없고, 페이로드는 RFC 8291로 암호화돼 있어 내용도 못 본다.
 *
 * ── 구독 정보를 어드민에게 어떻게 넘기나
 *
 * 서버가 없으니 기존 통로를 그대로 쓴다: `MESSAGE_KIND` + NIP-44 암호화.
 * 릴레이는 암호문만 보고, 어드민 기기가 여럿이어도 각자 받아 저장하므로
 * 기기 간 동기화가 저절로 된다. `CLIENT_TAG` dev/prod 격리도 따라온다.
 */
import { VAPID_PUBLIC_KEY } from '@sajwo-tracker/shared';

/** 구독할 때 실제로 쓴 VAPID 공개키. 브라우저가 안 알려줄 때의 대조용. */
const KEY_USED = 'push-vapid-key-used';

function bytesToB64u(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 어드민에게 넘기는 구독 정보. 브라우저가 준 값을 그대로 옮긴다. */
export interface PushSubscriptionPayload {
  endpoint: string;
  /** 구독자 공개키 (P-256 uncompressed, base64url) */
  p256dh: string;
  /** 구독자 인증 시크릿 (16바이트, base64url) */
  auth: string;
}

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * 이 브라우저가 Web Push를 할 수 있는지 본다.
 *
 * iOS는 홈 화면에 추가한 PWA에서만 된다. Safari 탭에서는 `PushManager`가
 * 아예 없어서 여기서 걸린다 — 유저에게는 "홈 화면에 추가하세요"로 안내해야
 * 하므로 이유를 구분해서 돌려준다.
 */
export function checkPushSupport(): PushSupport {
  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: '이 브라우저는 서비스워커를 지원하지 않습니다.' };
  }
  if (!('PushManager' in window)) {
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return {
      supported: false,
      reason: iOS
        ? '아이폰은 홈 화면에 추가한 뒤에야 알림을 켤 수 있습니다. 공유 → "홈 화면에 추가"를 먼저 해주세요.'
        : '이 브라우저는 웹 푸시를 지원하지 않습니다.',
    };
  }
  if (!('Notification' in window)) {
    return { supported: false, reason: '이 브라우저는 알림을 지원하지 않습니다.' };
  }
  if (!window.isSecureContext) {
    // LAN IP로 붙은 개발 중에 여기 걸린다. 실수로 헤매지 않게 이유를 밝힌다.
    return { supported: false, reason: 'HTTPS(또는 localhost)에서만 알림을 켤 수 있습니다.' };
  }
  return { supported: true };
}

/**
 * 이 구독이 **지금 쓰는 VAPID 공개키로** 발급된 것인가.
 *
 * 구독은 발급 시점의 `applicationServerKey`에 영구히 묶인다. 서버 키를 바꾸면
 * 옛 구독으로 가는 푸시는 403(invalid JWT)으로 죽는데, **유저 쪽에서는 아무
 * 신호가 없다** — 알림을 켜둔 채로 영영 못 받는다. 그래서 키가 바뀌었는지를
 * 앱이 스스로 알아채야 한다.
 *
 * 브라우저가 `options.applicationServerKey`로 알려준다. 못 알려주는 구형
 * 브라우저를 위해 구독할 때 쓴 키를 따로 적어두고 그걸로 대조한다.
 */
function usesCurrentKey(sub: PushSubscription): boolean {
  const applied = sub.options?.applicationServerKey;
  if (applied) {
    return bytesToB64u(new Uint8Array(applied)) === VAPID_PUBLIC_KEY;
  }
  // 브라우저가 안 알려주면 우리가 적어둔 값으로 판단한다.
  // 기록조차 없으면 키 교체 이전에 만든 구독이므로 옛것으로 본다.
  return localStorage.getItem(KEY_USED) === VAPID_PUBLIC_KEY;
}

/** 이미 이 브라우저에서 구독했는지 본다. 옛 키로 발급된 것은 없는 셈 친다. */
export async function getExistingSubscription(): Promise<PushSubscriptionPayload | null> {
  if (checkPushSupport().supported !== true) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub || !usesCurrentKey(sub)) return null;
  return serialize(sub);
}

/**
 * VAPID 키가 바뀌었으면 조용히 재구독한다. 앱 부팅 시 1회.
 *
 * 유저가 뭔가를 다시 누르게 만들면 대부분 영영 안 누른다 — 알림이 안 오는 걸
 * 모르니까 누를 이유도 없다. 이미 알림 권한이 있으므로 사용자 제스처 없이도
 * 재구독이 되고, 유저는 아무것도 눈치채지 못한 채 계속 알림을 받는다.
 */
export async function migratePushSubscriptionIfKeyChanged(
  publish: (sub: PushSubscriptionPayload) => Promise<boolean>,
): Promise<void> {
  if (checkPushSupport().supported !== true) return;
  if (Notification.permission !== 'granted') return;

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (!existing || usesCurrentKey(existing)) return;

    console.log('[Push] VAPID 키가 바뀌었다 — 재구독');
    await existing.unsubscribe();

    const fresh = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: VAPID_PUBLIC_KEY,
    });
    localStorage.setItem(KEY_USED, VAPID_PUBLIC_KEY);
    await publish(serialize(fresh));
  } catch (e) {
    // 실패해도 앱 동작을 막지 않는다. 다음 부팅에 다시 시도된다.
    console.warn('[Push] 재구독 실패:', e);
  }
}

/**
 * 알림 권한을 받고 구독한다. **반드시 유저 클릭 안에서 불러야 한다** —
 * 브라우저가 사용자 제스처 없는 권한 요청을 거부한다.
 *
 * 실패는 전부 Error로 던진다. 조용히 실패하면 유저는 켰다고 믿고 기다리는데
 * 알림은 영영 안 오는 최악의 상태가 된다.
 */
export async function subscribeToPush(): Promise<PushSubscriptionPayload> {
  const support = checkPushSupport();
  if (!support.supported) throw new Error(support.reason);

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? '알림이 차단되어 있습니다. 브라우저 주소창의 자물쇠 아이콘에서 알림을 허용으로 바꿔주세요.'
        : '알림 권한을 받지 못했습니다.',
    );
  }

  const reg = await navigator.serviceWorker.ready;

  // 이미 구독돼 있으면 그대로 쓴다. 재구독하면 엔드포인트가 바뀌어
  // 어드민에 남은 옛 구독이 죽은 채로 남는다.
  const existing = await reg.pushManager.getSubscription();
  if (existing && usesCurrentKey(existing)) return serialize(existing);
  // 옛 키로 만든 구독은 살려둬도 푸시가 403으로 죽는다. 버리고 새로 만든다.
  if (existing) await existing.unsubscribe();

  try {
    const sub = await reg.pushManager.subscribe({
      // false로 두면 크롬이 거부한다. 조용한 푸시는 허용되지 않는다.
      userVisibleOnly: true,
      applicationServerKey: VAPID_PUBLIC_KEY,
    });
    localStorage.setItem(KEY_USED, VAPID_PUBLIC_KEY);
    return serialize(sub);
  } catch (err) {
    throw new Error(explainSubscribeFailure(err));
  }
}

/**
 * 구독 실패를 사람이 고칠 수 있는 말로 바꾼다.
 *
 * 브라우저가 주는 "Registration failed - push service error"는 원인을 전혀
 * 알려주지 않는데, 실제로는 브레이브에서 구글 푸시가 기본으로 꺼져 있는 게
 * 대부분이다. 그대로 보여주면 유저는 우리 앱이 고장난 줄 안다.
 */
function explainSubscribeFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/push service error|Registration failed/i.test(raw)) {
    // navigator.brave는 브레이브만 노출한다.
    const isBrave = 'brave' in navigator;
    if (isBrave) {
      return '브레이브는 푸시 알림이 기본으로 꺼져 있습니다. '
        + '주소창에 brave://settings/privacy 를 열고 "구글 푸시 메시지 서비스 사용"을 켠 뒤 '
        + '브레이브를 완전히 종료했다 다시 켜고 시도해 주세요.';
    }
    return '브라우저의 푸시 서비스에 연결하지 못했습니다. '
      + '브라우저 설정에서 푸시 알림이 꺼져 있지 않은지 확인해 주세요.';
  }
  return `알림을 켜지 못했습니다: ${raw}`;
}

/** 이 브라우저의 구독을 해지한다. 어드민 쪽 정리는 발송 실패 시 자동으로 된다. */
export async function unsubscribeFromPush(): Promise<void> {
  if (checkPushSupport().supported !== true) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
}

function serialize(sub: PushSubscription): PushSubscriptionPayload {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) throw new Error('구독 키를 읽지 못했습니다.');
  return { endpoint: sub.endpoint, p256dh, auth };
}
