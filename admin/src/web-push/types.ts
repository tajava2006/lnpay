/** 유저 브라우저가 발급받아 어드민에게 등록한 구독 정보. */
export interface PushSubscriptionPayload {
  endpoint: string;
  /** 구독자 공개키 (P-256 uncompressed, base64url) */
  p256dh: string;
  /** 구독자 인증 시크릿 (16바이트, base64url) */
  auth: string;
}

/** 구독 정보로 보이는지 확인한다. 릴레이에서 온 값이라 믿지 않는다. */
export function isPushSubscriptionPayload(v: unknown): v is PushSubscriptionPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.endpoint === 'string'
    && o.endpoint.startsWith('https://')
    && typeof o.p256dh === 'string'
    && typeof o.auth === 'string'
  );
}
