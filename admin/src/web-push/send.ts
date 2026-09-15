/**
 * 푸시 발송
 *
 * ── 왜 중계가 필요한가 (2026-09-14 실측)
 *
 * 푸시 엔드포인트에 브라우저에서 직접 POST할 수 있는지 재봤다:
 *
 *   Mozilla (Firefox)  ✅ ACAO로 우리 오리진을 에코, POST/authorization/ttl 허용
 *   FCM (Chrome)       ❌ preflight 400 / POST 401, 어느 쪽에도 ACAO 없음
 *   Apple (Safari)     ❌ OPTIONS 405, CORS 헤더 없음
 *
 * FCM이 401을 준다는 건 요청을 이해하고 인증만 거절했다는 뜻인데 그러고도 ACAO를
 * 안 붙였다 — 경로 문제가 아니라 브라우저 오리진을 받을 생각이 없는 것이다.
 *
 * 그래서 우리 오리진의 중계를 거친다. 상태도 비밀도 없는 포워더다: VAPID 서명은
 * 여기 브라우저에서 하고, 페이로드는 이미 RFC 8291로 암호화돼 있어 중계는
 * 암호문을 옮길 뿐 못 읽는다. `PUSH_PROXY`가 비어 있으면 직접 쏘는데,
 * 그건 Firefox 상대로만 통한다(초기 검증용 경로).
 */
import { VAPID_PUBLIC_KEY } from '@sajwo-tracker/shared';
import { encryptPayload, vapidAuthHeader } from './crypto';
import { getVapidPrivateKey } from './vapid-store';
import { getSubscriptions, removeSubscription } from './store';
import type { PushSubscriptionPayload } from './types';

/**
 * 중계 경로. 빈 문자열이면 엔드포인트로 직접 POST한다.
 *
 * **프로덕션 기본값은 같은 오리진의 `/push`**다. 어드민이 배포된 도메인에 nginx가
 * 이미 있으므로, 상대 경로로 두면 CORS가 아예 성립하지 않고(같은 오리진) 설정
 * 파일도 하나 안 늘어난다. VPS에서 빌드하는 구조라 env를 따로 심으면 잊기 쉽다.
 *
 * **개발 기본값은 직접 발송**이다. 로컬에는 nginx가 없으니 프록시로 보내면
 * 파이어폭스 상대로 되던 것까지 깨진다. 크롬·사파리가 dev에서 안 되는 건
 * 알려진 제약으로 두고, 필요하면 VITE_PUSH_PROXY로 프로덕션 프록시를 가리킨다.
 */
const PUSH_PROXY = import.meta.env.VITE_PUSH_PROXY
  ?? (import.meta.env.PROD ? '/push' : '');

/** VAPID `sub` — 푸시 서비스가 문제 생겼을 때 연락할 곳. */
const VAPID_SUBJECT = 'https://customer.hoppe-relay.it.com';

/** 알림이 유효한 시간. 지나면 푸시 서비스가 버린다. */
const TTL_SECONDS = 12 * 60 * 60;

export interface PushMessage {
  title: string;
  body: string;
  /** 클릭 시 열릴 경로 */
  url?: string;
  /** 같은 tag의 알림은 쌓이지 않고 대체된다. 주문 단위로 주면 좋다. */
  tag?: string;
}

function proxied(endpoint: string): string {
  if (!PUSH_PROXY) return endpoint;
  const u = new URL(endpoint);
  return `${PUSH_PROXY}/${u.host}${u.pathname}${u.search}`;
}

/**
 * 한 구독에 한 건 보낸다.
 *
 * 404/410은 구독이 죽었다는 뜻이라 저장소에서 지운다 — 유저가 브라우저 데이터를
 * 지우거나 알림을 끄면 이렇게 된다. 그 외 실패는 남겨둔다(일시적일 수 있다).
 */
async function sendOne(
  pubkey: string,
  sub: PushSubscriptionPayload,
  message: PushMessage,
): Promise<boolean> {
  const privateD = getVapidPrivateKey();
  if (!privateD) {
    console.warn('[Push] VAPID 개인키가 설정되지 않음 — 발송 건너뜀');
    return false;
  }

  try {
    const [body, auth] = await Promise.all([
      encryptPayload(JSON.stringify(message), sub),
      vapidAuthHeader(sub.endpoint, VAPID_PUBLIC_KEY, privateD, VAPID_SUBJECT),
    ]);

    const res = await fetch(proxied(sub.endpoint), {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        Authorization: auth,
      },
      body: body as BodyInit,
    });

    if (res.status === 404 || res.status === 410) {
      removeSubscription(pubkey, sub.endpoint);
      return false;
    }
    if (!res.ok) {
      console.warn('[Push] 발송 거절:', res.status, sub.endpoint.slice(0, 60));
      return false;
    }
    return true;
  } catch (err) {
    // CORS 차단도 여기로 떨어진다 — 프록시 없이 Chrome/Safari에 쏘면 이 경로다.
    console.warn('[Push] 발송 실패:', sub.endpoint.slice(0, 60), err);
    return false;
  }
}

/**
 * 한 유저의 모든 구독(기기)에 보낸다. 실패해도 던지지 않는다 —
 * 알림은 부가 기능이고, 못 보냈다고 거래를 막아선 안 된다.
 */
export async function sendPush(pubkey: string, message: PushMessage): Promise<number> {
  const subs = getSubscriptions(pubkey);
  if (subs.length === 0) {
    // 반드시 로그를 남긴다. "구독이 없다"와 "보냈는데 실패했다"는 원인이 전혀
    // 다른데, 조용히 return하면 둘 다 "알림이 안 온다"로만 보인다.
    console.log('[Push]', pubkey.slice(0, 8), '— 등록된 구독 없음, 발송 안 함');
    return 0;
  }

  const results = await Promise.all(subs.map(s => sendOne(pubkey, s, message)));
  const sent = results.filter(Boolean).length;
  console.log('[Push]', pubkey.slice(0, 8), '—', sent, '/', subs.length, '기기 발송');
  return sent;
}
