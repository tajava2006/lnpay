/**
 * 비밀 파일 읽기 (PLAN-DAEMON §4.7)
 *
 * 비밀은 환경변수가 아니라 **파일**로 받는다 — 환경변수는 `docker inspect`·프로세스 목록·크래시
 * 덤프로 새기 쉽다. 컨테이너에는 읽기 전용으로 마운트한다.
 */
import { readFileSync } from 'node:fs';
import { decode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';

export interface AppKey {
  secretKey: Uint8Array;
  pubkey: string;
}

/** 시드 — hex 64자(32바이트). 자금 비밀 전부의 뿌리다(§4.7). */
export function parseSeed(text: string): Uint8Array {
  const hex = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('시드는 hex 64자여야 한다');
  const seed = Uint8Array.from(hex.match(/../g)!, b => Number.parseInt(b, 16));
  if (seed.every(b => b === 0)) throw new Error('시드가 전부 0이다');
  return seed;
}

/**
 * APP 키 — nsec 또는 hex 64자.
 *
 * ⚠️ **기대한 pubkey와 다르면 부팅을 막는다.** 유저 앱은 `event.pubkey !== APP_PUBKEY`인 오더를
 * 전부 버린다. 다른 키로 서명하는 데몬은 겉으로는 잘 도는데 아무에게도 안 보인다.
 */
export function parseAppKey(text: string, expectedPubkey: string): AppKey {
  const value = text.trim();
  let secretKey: Uint8Array;
  if (value.startsWith('nsec1')) {
    const decoded = decode(value);
    if (decoded.type !== 'nsec') throw new Error('nsec이 아니다');
    secretKey = decoded.data;
  } else if (/^[0-9a-fA-F]{64}$/.test(value)) {
    secretKey = Uint8Array.from(value.toLowerCase().match(/../g)!, b => Number.parseInt(b, 16));
  } else {
    throw new Error('APP 키는 nsec 또는 hex 64자여야 한다');
  }
  const pubkey = getPublicKey(secretKey);
  if (pubkey !== expectedPubkey) {
    throw new Error(`APP 키가 기대한 pubkey가 아니다 (${pubkey.slice(0, 8)}… ≠ ${expectedPubkey.slice(0, 8)}…)`);
  }
  return { secretKey, pubkey };
}

export function readSeedFile(path: string): Uint8Array {
  return parseSeed(readFileSync(path, 'utf8'));
}

export function readAppKeyFile(path: string, expectedPubkey: string): AppKey {
  return parseAppKey(readFileSync(path, 'utf8'), expectedPubkey);
}
