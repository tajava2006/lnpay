/**
 * hex ↔ bytes (온체인 트랙 전용)
 *
 * 외부 라이브러리(`@scure/base`)를 쓰지 않는다. 그걸 직접 의존으로 달면
 * 서명 경로에 `@noble/*` 계열 인스턴스가 한 벌 더 생길 수 있는데, 그건
 * ark SDK에서 한 번 겪은 문제다(같은 crypto가 두 벌이면 조용히 갈린다).
 * 필요한 건 이 두 함수뿐이라 여기서 끝낸다.
 *
 * ⚠️ `hexToBytes`는 **릴레이에서 온 문자열**을 받는 자리다. 길이·문자
 * 검증을 반드시 통과시킨다 — 조용히 잘라 쓰면 엉뚱한 키로 주소가 파생된다.
 */

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: 16진 문자열이 아니다 (length=${hex.length})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 32바이트 x-only pubkey 형식인지 (64자 hex) */
export function isXonlyHex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
