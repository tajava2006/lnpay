/**
 * Web Push 암호화 검증
 *
 * 이 코드는 틀려도 조용히 실패한다 — 푸시 서비스는 암호문을 검사하지 않고
 * 201을 돌려주며, 구독자 브라우저가 복호화에 실패하면 말없이 버린다. 그래서
 * "알림이 안 오네"만 남고 원인이 안 보인다.
 *
 * 왕복 테스트(암호화→복호화)만으로는 부족하다. 양방향에 같은 실수를 하면
 * (예: info 문자열을 똑같이 틀리면) 통과해 버리고 실제 브라우저에서만 깨진다.
 * 그래서 **RFC 8291 §5의 공식 테스트 벡터**로 바이트 단위 대조를 한다.
 */
import { describe, it, expect } from 'vitest';
import {
  encryptPayload, vapidAuthHeader, audienceOf, vapidKeyPairMatches,
  b64uToBytes, bytesToB64u,
} from '../web-push/crypto';

// ── RFC 8291 §5 공식 벡터 ────────────────────────────────────────────
const VEC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expectedBody:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** 벡터의 고정 발신자 키를 ECDH 키쌍으로 되살린다. */
async function senderKeyPair(): Promise<CryptoKeyPair> {
  const pub = b64uToBytes(VEC.asPublic);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: VEC.asPrivate,
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const publicKey = await crypto.subtle.importKey(
    'raw', pub as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  );
  return { privateKey, publicKey };
}

describe('RFC 8291 페이로드 암호화', () => {
  it('공식 테스트 벡터와 바이트 단위로 일치한다', async () => {
    const body = await encryptPayload(
      VEC.plaintext,
      { p256dh: VEC.uaPublic, auth: VEC.authSecret },
      { salt: b64uToBytes(VEC.salt), asKeyPair: await senderKeyPair() },
    );

    expect(bytesToB64u(body)).toBe(VEC.expectedBody);
  });

  it('본문 헤더 구조가 salt(16)|rs(4)|idlen(1)|키(65) 순이다', async () => {
    const body = await encryptPayload('hi', { p256dh: VEC.uaPublic, auth: VEC.authSecret });

    expect(body.slice(0, 16)).toHaveLength(16);
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04); // uncompressed P-256 마커
    // 평문 2바이트 + 구분자 1 + GCM 태그 16 = 19
    expect(body.length).toBe(16 + 4 + 1 + 65 + 19);
  });

  it('매번 다른 salt와 임시키를 쓴다 — 같은 평문도 암호문이 갈린다', async () => {
    const keys = { p256dh: VEC.uaPublic, auth: VEC.authSecret };
    const a = await encryptPayload('같은 문장', keys);
    const b = await encryptPayload('같은 문장', keys);

    expect(bytesToB64u(a)).not.toBe(bytesToB64u(b));
  });
});

describe('RFC 8292 VAPID', () => {
  // 테스트 전용 키쌍 (프로덕션 키 아님)
  const PUB = 'BEZykBtDbqMEaAPgxiJUhP0ipF5jOW4zViDWKERB5iI53NMzcgCYMRWOQJY0k6fvGV24izWDBfBjcjNL0LAWe1k';
  const PRIV_D = 'kc1tgSuCQKfcAi3w1Z71p_JJCDQqXUHkBaqw-5fi7qg';
  const SUB = 'https://customer.hoppe-relay.it.com';

  it('aud는 엔드포인트의 오리진이다 — 경로는 안 들어간다', () => {
    expect(audienceOf('https://fcm.googleapis.com/fcm/send/abc123')).toBe('https://fcm.googleapis.com');
    expect(audienceOf('https://updates.push.services.mozilla.com/wpush/v2/xyz')).toBe(
      'https://updates.push.services.mozilla.com',
    );
  });

  it('서명이 공개키로 검증된다', async () => {
    const header = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/x', PUB, PRIV_D, SUB);

    const m = /^vapid t=([\w-]+\.[\w-]+)\.([\w-]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, signingInput, sigB64u, kParam] = m!;

    expect(kParam).toBe(PUB);

    const pub = b64uToBytes(PUB);
    const key = await crypto.subtle.importKey(
      'raw', pub as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64uToBytes(sigB64u!) as BufferSource,
      new TextEncoder().encode(signingInput!) as BufferSource,
    );
    expect(ok).toBe(true);
  });

  it('JWT 페이로드에 aud/exp/sub가 담긴다', async () => {
    const now = 1_700_000_000;
    const header = await vapidAuthHeader('https://web.push.apple.com/abc', PUB, PRIV_D, SUB, now);
    const payload = JSON.parse(
      new TextDecoder().decode(b64uToBytes(header.split('.')[1]!)),
    );

    expect(payload.aud).toBe('https://web.push.apple.com');
    expect(payload.sub).toBe(SUB);
    expect(payload.exp).toBe(now + 12 * 60 * 60);
  });

  it('서명은 raw r||s 64바이트다 (JWS 요구 형식, DER 아님)', async () => {
    const header = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/x', PUB, PRIV_D, SUB);
    const sig = header.split('.')[2]!.split(',')[0]!;

    expect(b64uToBytes(sig)).toHaveLength(64);
  });
});

describe('VAPID 키쌍 짝 검증', () => {
  const PUB = 'BEZykBtDbqMEaAPgxiJUhP0ipF5jOW4zViDWKERB5iI53NMzcgCYMRWOQJY0k6fvGV24izWDBfBjcjNL0LAWe1k';
  const PRIV_D = 'kc1tgSuCQKfcAi3w1Z71p_JJCDQqXUHkBaqw-5fi7qg';

  /**
   * 이 검증이 왜 있는가: 형식만 맞고 짝이 아닌 키는 푸시 서비스마다 다르게 실패한다.
   * FCM은 403 "invalid JWT provided", Mozilla는 서명을 검증하지 않아 201로 통과한다.
   * 파이어폭스에서 알림이 잘 오니까 키를 의심하지 않게 되는 게 진짜 함정이었다.
   */
  it('짝이 맞으면 true', async () => {
    expect(await vapidKeyPairMatches(PUB, PRIV_D)).toBe(true);
  });

  it('짝이 아닌 개인키는 false — 형식은 멀쩡해도 거른다', async () => {
    const other = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'],
    ) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', other.privateKey);

    expect(jwk.d).toMatch(/^[A-Za-z0-9_-]{43}$/); // 형식 검사는 통과하는 값이다
    expect(await vapidKeyPairMatches(PUB, jwk.d!)).toBe(false);
  });

  it('쓰레기 값은 던지지 않고 false', async () => {
    expect(await vapidKeyPairMatches(PUB, 'not-a-key')).toBe(false);
    expect(await vapidKeyPairMatches('not-a-public-key', PRIV_D)).toBe(false);
  });
});
