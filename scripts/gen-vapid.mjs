/**
 * VAPID 키쌍 생성 — `node scripts/gen-vapid.mjs`
 *
 * ── 이게 무슨 키인가
 *
 * 비트코인·nostr과 같은 타원곡선 계열이지만 **곡선과 서명이 둘 다 다르다.**
 *
 *   비트코인/nostr : secp256k1 + Schnorr(BIP-340), x-only 32바이트 공개키
 *   VAPID          : P-256(secp256r1) + ECDSA/SHA-256 (= ES256),
 *                    비압축점 65바이트 공개키(0x04‖X‖Y)
 *
 * RFC 8292가 ES256을 못박아서 선택의 여지가 없다.
 *
 * ── 어디에 넣나
 *
 *   공개키 → shared/src/constants.ts 의 VAPID_PUBLIC_KEY (커밋해도 되는 값)
 *   개인키 → 어드민 설정 화면에만. **레포에 커밋하지 않는다**
 *
 * ⚠️ 공개키를 바꾸면 기존 구독이 전부 무효가 된다. 구독은 발급 시점의
 * applicationServerKey에 묶여 있어서 키가 달라지면 푸시 서비스가 403을 준다.
 * 앱이 그걸 감지해 자동으로 재구독하지만(push/subscribe.ts), 유저 기기가
 * 한 번은 앱을 열어야 한다.
 */
import { webcrypto } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

const pair = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const publicRaw = await webcrypto.subtle.exportKey('raw', pair.publicKey);
const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);

// 만들자마자 짝이 맞는지 확인한다. 어긋난 키를 넣으면 크롬 계열만 403으로
// 조용히 죽고 파이어폭스는 멀쩡히 통과해서 원인을 찾기가 아주 어렵다.
const probe = new TextEncoder().encode('vapid-keypair-check');
const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, probe);
const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, probe);

console.log();
console.log('PUBLIC  (shared/src/constants.ts 의 VAPID_PUBLIC_KEY 로):');
console.log(b64u(publicRaw));
console.log();
console.log('PRIVATE (어드민 설정 화면에만. 커밋 금지):');
console.log(privateJwk.d);
console.log();
console.log(ok ? '✓ 키쌍 검증 통과' : '✗ 키쌍 검증 실패 — 다시 생성하세요');
process.exit(ok ? 0 : 1);
