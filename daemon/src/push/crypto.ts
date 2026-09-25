/**
 * Web Push 암호화 (RFC 8291) + VAPID 서명 (RFC 8292)
 *
 * ── 왜 손으로 짜는가
 *
 * 프론트 어드민 시절엔 브라우저에서 돌아야 해서 Node 전용 `web-push` 패키지를 못 썼다. 데몬으로
 * 옮긴 지금은 쓸 수 있지만, 이 구현은 RFC 벡터로 바이트 단위 검증이 끝나 있고 Node의 WebCrypto로
 * 그대로 돈다 — 의존성을 늘릴 이유가 없어 그대로 옮겼다.
 *
 * ── 무엇을 보장하나
 *
 * 푸시 서비스(구글·애플·모질라)는 **암호문만 본다**. 페이로드는 구독자의 공개키로
 * 암호화되고, 복호화 키는 구독자 브라우저 안에만 있다. 중간에 우리 nginx를 끼워도
 * 마찬가지다 — 그래서 프록시를 두는 게 프라이버시 후퇴가 아니다.
 *
 * VAPID는 반대 방향이다. "이 푸시를 보낸 게 확실히 우리"임을 푸시 서비스에
 * 증명해서, 남이 우리 구독자에게 스팸을 못 쏘게 한다.
 *
 * ── 검증
 *
 * 스펙 문서의 테스트 벡터(RFC 8291 §5)로 결과를 대조한다. 틀려도 조용히
 * 실패하는 종류의 코드라(푸시 서비스는 201을 주고 브라우저가 말없이 버린다)
 * 눈으로 확인할 방법이 없기 때문이다.
 */

import type { webcrypto } from 'node:crypto';

// 데몬은 DOM 타입을 싣지 않는다 — WebCrypto 타입은 Node 쪽 이름으로
type BufferSource = NodeJS.BufferSource;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

// ── base64url ────────────────────────────────────────────────────────

export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** WebCrypto의 HKDF는 extract+expand를 한 번에 한다 — 스펙의 두 단계가 이 한 호출이다. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

// ── RFC 8291: 페이로드 암호화 ────────────────────────────────────────

export interface PushSubscriptionKeys {
  /** 구독자 공개키 (P-256 uncompressed 65바이트, base64url) */
  p256dh: string;
  /** 구독자 인증 시크릿 (16바이트, base64url) */
  auth: string;
}

/**
 * 테스트에서 결정론적 입력을 주입하기 위한 구멍.
 * 프로덕션은 기본값(진짜 난수 + 새 키쌍)을 쓴다.
 */
export interface EncryptOverrides {
  salt?: Uint8Array;
  /** 발신자 임시 ECDH 키쌍 */
  asKeyPair?: CryptoKeyPair;
}

/**
 * aes128gcm 본문을 만든다. 반환값을 그대로 POST 바디로 쓴다.
 *
 * 본문 구조 (RFC 8188 §2.1):
 *   salt(16) | rs(4, BE) | idlen(1) | as_public(65) | ciphertext
 */
export async function encryptPayload(
  plaintext: string,
  keys: PushSubscriptionKeys,
  overrides: EncryptOverrides = {},
): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(keys.p256dh);
  const authSecret = b64uToBytes(keys.auth);

  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asKeyPair = overrides.asKeyPair ?? await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );

  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  // ① 공유 비밀 — 발신자 임시키 × 구독자 공개키
  const uaPublicKey = await crypto.subtle.importKey(
    'raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256,
  ));

  // ② IKM — auth secret을 salt로 써서 공유 비밀을 양쪽 공개키에 묶는다 (RFC 8291 §3.4)
  const keyInfo = concat(utf8('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // ③ CEK / NONCE (RFC 8188 §2.2)
  const cekBytes = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // ④ 단일 레코드. 마지막 레코드의 패딩 구분자는 0x02
  const padded = concat(utf8(plaintext), new Uint8Array([2]));
  const cek = await crypto.subtle.importKey('raw', cekBytes as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 }, cek, padded as BufferSource,
  ));

  // ⑤ 헤더를 붙인다. rs는 레코드 크기 — 평문+구분자+태그보다 커야 한다
  const rs = 4096;
  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, rs, false);

  return concat(salt, rsBytes, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// ── RFC 8292: VAPID ──────────────────────────────────────────────────

/**
 * 개인키 d(base64url)와 이미 아는 공개키로 서명용 JWK를 조립한다.
 *
 * d만 저장하는 이유: 공개키는 `VAPID_PUBLIC_KEY` 상수로 코드에 이미 있어서
 * 어드민이 붙여넣어야 할 비밀이 43자 한 줄로 줄어든다.
 */
async function importVapidKey(privateD: string, publicKey: Uint8Array): Promise<CryptoKey> {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error('VAPID 공개키가 uncompressed P-256(65바이트)이 아님');
  }
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: privateD,
      x: bytesToB64u(publicKey.slice(1, 33)),
      y: bytesToB64u(publicKey.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** 푸시 엔드포인트의 오리진. JWT의 aud가 된다. */
export function audienceOf(endpoint: string): string {
  return new URL(endpoint).origin;
}

/**
 * 개인키가 정말 그 공개키의 짝인지 서명 왕복으로 확인한다.
 *
 * 형식 검사(base64url 43자)만으로는 부족하다. 짝이 아닌 키도 형식은 멀쩡해서
 * 그대로 저장되고, 그 다음부터 **푸시 서비스마다 다르게** 실패한다:
 *
 *   FCM(크롬 계열)  403 permission denied: invalid JWT provided
 *   Mozilla(파폭)   201 — 일반 구독에는 서명을 검증하지 않아 그냥 통과한다
 *
 * 이 비대칭이 특히 고약하다. 파이어폭스에서는 알림이 멀쩡히 오니까 키를 의심하지
 * 않게 되고, 크롬만 안 되는 걸 CORS나 프록시 탓으로 몰게 된다(실제로 그렇게 헤맸다).
 * 그래서 저장하는 순간 여기서 막는다.
 */
export async function vapidKeyPairMatches(
  publicKeyB64u: string,
  privateD: string,
): Promise<boolean> {
  try {
    const publicKey = b64uToBytes(publicKeyB64u);
    const priv = await importVapidKey(privateD, publicKey);
    const probe = utf8('vapid-keypair-check');

    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, priv, probe as BufferSource,
    );
    const pub = await crypto.subtle.importKey(
      'raw', publicKey as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, pub, sig, probe as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * `Authorization: vapid t=..., k=...` 헤더 값을 만든다.
 *
 * exp는 12시간 뒤로 둔다. 스펙 상한은 24시간이고, 짧을수록 탈취된 토큰의
 * 수명이 줄지만 어드민 기기 시계가 조금 틀어져도 견뎌야 해서 절반으로 잡았다.
 */
export async function vapidAuthHeader(
  endpoint: string,
  publicKeyB64u: string,
  privateD: string,
  subject: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = bytesToB64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64u(utf8(JSON.stringify({
    aud: audienceOf(endpoint),
    exp: nowSec + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${payload}`;

  const key = await importVapidKey(privateD, b64uToBytes(publicKeyB64u));
  // WebCrypto의 ECDSA 서명은 이미 raw r||s(64바이트)다 — JWS가 요구하는 형식과 같다.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput) as BufferSource,
  ));

  return `vapid t=${signingInput}.${bytesToB64u(sig)}, k=${publicKeyB64u}`;
}
