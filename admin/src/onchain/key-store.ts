/**
 * 어드민의 주문별 키 (PLAN-ONCHAIN-TRACK §3.2 · 공격 M)
 *
 * ── 어드민만 키를 "만든다"
 *
 * 고객·후원자는 자기 nostr 키에서 **파생**하므로 백업할 게 없다. 어드민은
 * NIP-46이라 로컬에 개인키가 없어 파생할 재료가 없다 → 난수로 만든다.
 * 만든 이상 **잃으면 끝이다.**
 *
 * ⚠️ **이 키를 잃으면 그 주문의 분쟁 중재가 영구 불가**다. `{A,S}`·`{A,C}` 둘 다
 * 서명할 수 없고, 고객이 타임락(8주)으로 회수할 때까지 아무도 아무것도 못 한다.
 *
 * ── 그래서 백업이 선택이 아니다
 *
 * 두 곳에 둔다. **실패 모드가 다르기 때문**이다:
 *
 * | 어디 | 무엇을 막나 |
 * |---|---|
 * | NIP-78 + NIP-44 (릴레이) | **기기 분실·교체.** 어드민을 폰·PC에서 번갈아 쓴다 |
 * | localStorage | **릴레이가 죽거나 이벤트가 유실돼도** 그 기기에선 산다 |
 *
 * ⚠️ **릴레이 백업 성공을 확인하기 전에는 주소를 발행하지 않는다.**
 * localStorage만으로는 부족하다 — 그 기기를 잃으면 끝이다. 그래서
 * `createOrderKeyWithBackup()`은 백업이 실패하면 **던진다.**
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import { APP_PUBKEY, CLIENT_TAG_ONCHAIN, getWriteRelays, storage } from '@sajwo-tracker/shared';
import {
  bytesToHex, generateOrderKey, hexToBytes, xonlyFromPrivkey, type OrderKey,
} from '@sajwo-tracker/shared/onchain';
import { getSigner } from '../nostr/nip46';

const APP_DATA_KIND = 30078;
const D_TAG = `onchain-keys:${CLIENT_TAG_ONCHAIN}`;
const STORAGE_KEY = 'admin:onchain-keys';

/** orderId → 비밀키 hex */
type KeyMap = Record<string, string>;

let cache: KeyMap | null = null;

function isKeyMap(value: unknown): value is KeyMap {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>)
    .every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v));
}

async function encryptMap(map: KeyMap): Promise<string> {
  const signer = getSigner();
  if (!signer) throw new Error('온체인 키 저장소: signer 없음');
  return signer.nip44Encrypt(APP_PUBKEY, JSON.stringify(map));
}

async function decryptMap(ciphertext: string): Promise<KeyMap | null> {
  const signer = getSigner();
  if (!signer) return null;
  try {
    const parsed: unknown = JSON.parse(await signer.nip44Decrypt(APP_PUBKEY, ciphertext));
    return isKeyMap(parsed) ? parsed : null;
  } catch (e) {
    console.error('[OnchainKeys] 복호화 실패', e);
    return null;
  }
}

/** 릴레이 백업을 올린다. **실패하면 던진다** — 호출부가 주소 발행을 멈춰야 한다. */
async function publishBackup(map: KeyMap): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('온체인 키 백업: signer 없음');

  const template: EventTemplate = {
    kind: APP_DATA_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', D_TAG]],
    content: await encryptMap(map),
  };
  const signed = await signer.signEvent(template);

  const relays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    if (!results.some(r => r.status === 'fulfilled')) {
      throw new Error('모든 릴레이에 백업 발행 실패');
    }
    console.log('[OnchainKeys] 백업 발행', Object.keys(map).length, '건 →', relays.length, '릴레이');
  } finally {
    pool.destroy();
  }
}

async function fetchBackup(): Promise<KeyMap | null> {
  const signer = getSigner();
  if (!signer) return null;
  const relays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const event = await pool.get(relays, {
      kinds: [APP_DATA_KIND], authors: [APP_PUBKEY], '#d': [D_TAG],
    });
    if (!event?.content) return null;
    return await decryptMap(event.content);
  } catch (e) {
    console.warn('[OnchainKeys] 릴레이 복원 실패', e);
    return null;
  } finally {
    pool.destroy();
  }
}

/**
 * 키 맵을 연다. 로컬이 비었으면 **릴레이에서 복원**한다 —
 * 기기를 바꿨거나 브라우저 데이터가 날아간 경우다.
 */
export async function loadOnchainKeys(): Promise<KeyMap> {
  if (cache) return cache;

  const local = localStorage.getItem(STORAGE_KEY);
  if (local) {
    const map = await decryptMap(local);
    if (map) {
      cache = map;
      return map;
    }
    // 복호화가 안 되는 로컬 캐시는 **지우지 않는다.** signer가 잠깐 없을 수도
    // 있고, 그때 지우면 유일본을 날린다. 릴레이를 먼저 본다.
    console.warn('[OnchainKeys] 로컬 캐시를 못 열었다 — 릴레이에서 복원 시도');
  }

  const restored = await fetchBackup();
  if (restored) {
    cache = restored;
    localStorage.setItem(STORAGE_KEY, await encryptMap(restored));
    console.log('[OnchainKeys] 릴레이에서', Object.keys(restored).length, '건 복원');
    return restored;
  }

  cache = local ? {} : {};
  return cache;
}

/**
 * 그 주문의 어드민 키를 만들고 **백업까지 마친 뒤** 돌려준다.
 *
 * - 이미 있으면 **그걸 쓴다** (재시도해도 키가 바뀌지 않는다 — 바뀌면 이미
 *   발행된 주소를 못 여는 키가 생긴다)
 * - 릴레이 백업이 실패하면 **던진다.** 호출부는 주소를 발행하면 안 된다(공격 M)
 */
export async function createOrderKeyWithBackup(orderId: string): Promise<OrderKey> {
  if (!orderId) throw new Error('orderId가 비어 있다');

  const map = { ...(await loadOnchainKeys()) };
  const existingHex = map[orderId];
  const key: OrderKey = existingHex
    ? { privkey: hexToBytes(existingHex), xonly: xonlyOf(existingHex) }
    : generateOrderKey();

  map[orderId] = bytesToHex(key.privkey);

  // 로컬을 먼저 쓴다 — 릴레이 발행이 실패해도 키를 잃지 않는다.
  cache = map;
  localStorage.setItem(STORAGE_KEY, await encryptMap(map));

  // 그리고 백업이 성공해야만 호출부가 진행한다.
  await publishBackup(map);

  return key;
}

/** 이미 만든 키를 꺼낸다 (서명할 때). 없으면 `null` */
export async function getOrderKey(orderId: string): Promise<OrderKey | null> {
  const map = await loadOnchainKeys();
  const hex = map[orderId];
  if (!hex) return null;
  return { privkey: hexToBytes(hex), xonly: xonlyOf(hex) };
}

/**
 * ⚠️ 비트코인 crypto는 **언제나 `@sajwo-tracker/shared/onchain`을 거친다.**
 * admin이 `@scure/btc-signer`를 직접 의존으로 달면 서명 경로에 두 번째
 * 인스턴스가 생긴다(§3.5). 여기서 필요한 건 파생 한 줄뿐이라 그걸 가져다 쓴다.
 */
function xonlyOf(privkeyHex: string): string {
  return xonlyFromPrivkey(hexToBytes(privkeyHex));
}

/** @testing-only */
export function _resetForTesting(): void {
  cache = null;
  localStorage.removeItem(STORAGE_KEY);
}
