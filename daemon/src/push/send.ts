/**
 * 웹 푸시 발송 — 효과 대기열의 `push.send`
 *
 * 데몬은 서버라 FCM·Apple 엔드포인트에 **직접 보낸다**(브라우저라면 CORS 때문에 중계가 필요했다).
 *
 * 알림은 부가 기능이다. 실패해도 거래를 막지 않고, 끝없이 재시도하지도 않는다(3번). 404·410은
 * 구독이 죽었다는 뜻이라 표시해 두고 다음부터 보내지 않는다.
 */
import type { Db } from '../db';
import type { EffectExecutor, Effects } from '../effects';
import type { Logger } from '../log';
import { encryptPayload, vapidAuthHeader } from './crypto';

export const PUSH_EFFECT = 'push.send';

/** 알림이 유효한 시간. 지나면 푸시 서비스가 버린다 */
const TTL_SECONDS = 12 * 60 * 60;

export interface PushConfig {
  /** VAPID 개인키 (P-256 d, base64url) */
  privateD: string;
  /** 그 짝 — 운영은 유저 앱이 구독에 쓴 `VAPID_PUBLIC_KEY` */
  publicKey: string;
  /** VAPID `sub` — 푸시 서비스가 문제 생겼을 때 연락할 곳 */
  subject: string;
  /** 테스트가 바꿔 낀다 */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number }>;
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  /** 같은 tag의 알림은 쌓이지 않고 대체된다 */
  tag?: string;
}

export interface PushPayload {
  pubkey: string;
  message: PushMessage;
  /** 있으면 이 기기에만 (등록 확인 알림) */
  endpoint?: string;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 릴레이에서 온 값이라 믿지 않는다 */
export function isPushSubscriptionPayload(v: unknown): v is PushSubscriptionPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.endpoint === 'string' && o.endpoint.startsWith('https://') && o.endpoint.length <= 2048
    && typeof o.p256dh === 'string' && o.p256dh.length <= 200
    && typeof o.auth === 'string' && o.auth.length <= 100;
}

interface PushCtx {
  db: Db;
  effects: Effects;
  nowMs: () => number;
}

/**
 * 구독을 저장한다. **새 기기면 true** — 그때만 등록 확인을 보낸다(릴레이가 같은 등록을 다시 줘도
 * 수신 계층이 id로 거르지만, 같은 기기가 새 이벤트로 다시 등록하는 건 새 기기가 아니다).
 */
export function saveSubscription(ctx: PushCtx, pubkey: string, sub: PushSubscriptionPayload): boolean {
  const before = ctx.db.get<{ pubkey: string; dead_at: number | null }>(
    'SELECT pubkey, dead_at FROM push_subs WHERE endpoint = ?', sub.endpoint,
  );
  ctx.db.run(
    `INSERT INTO push_subs (endpoint, pubkey, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET pubkey = excluded.pubkey, p256dh = excluded.p256dh,
       auth = excluded.auth, dead_at = NULL`,
    sub.endpoint, pubkey, sub.p256dh, sub.auth, Math.floor(ctx.nowMs() / 1000),
  );
  return !before || before.pubkey !== pubkey || before.dead_at !== null;
}

export function queuePush(ctx: PushCtx, payload: PushPayload): void {
  ctx.effects.enqueue<PushPayload>(PUSH_EFFECT, payload);
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function createPushExecutor(
  db: Db, config: PushConfig | null, nowMs: () => number, log: Logger,
): EffectExecutor<PushPayload> {
  const post = config?.fetch ?? (async (url, init) => {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
    return { status: res.status };
  });

  return {
    maxAttempts: 3,
    async run({ pubkey, message, endpoint }) {
      if (!config) return { status: 'done', result: { dead: [] } };
      const subs = endpoint
        ? db.all<SubRow>('SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint = ? AND pubkey = ? AND dead_at IS NULL', endpoint, pubkey)
        : db.all<SubRow>('SELECT endpoint, p256dh, auth FROM push_subs WHERE pubkey = ? AND dead_at IS NULL', pubkey);
      if (subs.length === 0) {
        // "구독이 없다"와 "보냈는데 실패했다"는 원인이 전혀 다르다 — 남긴다
        log.debug('푸시 구독 없음', { pubkey: pubkey.slice(0, 8) });
        return { status: 'done', result: { dead: [] } };
      }

      const dead: string[] = [];
      let networkErrors = 0;
      for (const sub of subs) {
        try {
          const [body, auth] = await Promise.all([
            encryptPayload(JSON.stringify(message), sub),
            vapidAuthHeader(sub.endpoint, config.publicKey, config.privateD, config.subject),
          ]);
          const res = await post(sub.endpoint, {
            method: 'POST',
            headers: {
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: String(TTL_SECONDS),
              Authorization: auth,
            },
            body,
          });
          if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);
          else if (res.status >= 300) log.warn('푸시 거절', { status: res.status, endpoint: sub.endpoint.slice(0, 60) });
        } catch (e) {
          networkErrors += 1;
          log.warn('푸시 실패', { endpoint: sub.endpoint.slice(0, 60), error: e instanceof Error ? e.message : String(e) });
        }
      }
      // 전부 네트워크 실패면 다시 — 하나라도 닿았으면 끝(닿은 기기에 두 번 가지 않게)
      if (networkErrors === subs.length) return { status: 'retry', error: '푸시 서비스에 닿지 않음' };
      return { status: 'done', result: { dead } };
    },
    onDone(_payload, result) {
      const dead = (result as { dead: string[] }).dead;
      for (const endpoint of dead) {
        db.run('UPDATE push_subs SET dead_at = ? WHERE endpoint = ?', Math.floor(nowMs() / 1000), endpoint);
      }
    },
  };
}
