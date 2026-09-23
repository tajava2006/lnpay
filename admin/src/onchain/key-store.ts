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
 *
 * ── 주문마다 따로 둔다 (리뷰 #8)
 *
 * 전에는 **키 전체를 맵 하나**로 들고 통째로 다시 썼다. 그게 세 가지로 터졌다:
 *
 * 1. **번커 타임아웃 한 번에 전부 날아갔다.** 로컬·릴레이 복호화가 둘 다 실패하면
 *    빈 맵을 캐시했고, 번커가 돌아온 뒤 다음 클레임이 그 빈 맵 + 새 키 하나로
 *    **로컬과 릴레이를 동시에 덮어썼다.** 진행 중인 모든 주문의 중재가 끝난다.
 * 2. **기기를 옮기면 옛 맵이 새 맵을 덮었다.** 로컬이 있으면 릴레이를 안 봐서,
 *    다른 기기가 만든 키를 모르는 채로 백업을 통째로 다시 썼다.
 * 3. **맵이 커지면 백업 자체가 막힌다.** NIP-44 평문 한도(65,535B)와 릴레이 이벤트
 *    크기 한도에 수백 건이면 닿는다 — 그 뒤로 새 주문은 `bonded`로 못 간다.
 *
 * 주문마다 이벤트 하나(`d = onchain-key:<태그>:<orderId>`), 로컬 칸 하나로 두면
 * **읽고-고쳐-쓰는 자리가 없어진다.** 한 주문을 쓰는 일이 다른 주문을 지울 수 없다.
 *
 * 그리고 **복호화 실패는 '모름'이다** — 없음으로 치고 진행하지 않는다. 멈춘 주문은
 * 다음 틱에 다시 해 보면 되지만, 날린 키는 되돌릴 수 없다.
 *
 * 옛 맵(로컬 `admin:onchain-keys`, 릴레이 `onchain-keys:<태그>`)은 **읽기만** 한다 —
 * 그 전에 만든 주문의 키가 거기 있다.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import { APP_PUBKEY, CLIENT_TAG_ONCHAIN, getWriteRelays, storage } from '@sajwo-tracker/shared';
import {
  bytesToHex, generateOrderKey, hexToBytes, xonlyFromPrivkey, type OrderKey,
} from '@sajwo-tracker/shared/onchain';
import { getSigner } from '../nostr/nip46';

const APP_DATA_KIND = 30078;
const KEY_D_PREFIX = `onchain-key:${CLIENT_TAG_ONCHAIN}:`;
const LOCAL_PREFIX = 'admin:onchain-key:';
/** 옛 방식(맵 하나) — 읽기 전용 */
const LEGACY_D_TAG = `onchain-keys:${CLIENT_TAG_ONCHAIN}`;
const LEGACY_LOCAL_KEY = 'admin:onchain-keys';

const HEX_KEY = /^[0-9a-f]{64}$/;

type KeyLookup =
  | { status: 'found'; key: OrderKey }
  | { status: 'none' }
  | { status: 'unknown'; reason: string };

const memory = new Map<string, OrderKey>();

function keyFromHex(hex: string): OrderKey {
  return { privkey: hexToBytes(hex), xonly: xonlyFromPrivkey(hexToBytes(hex)) };
}

async function encrypt(plaintext: string): Promise<string> {
  const signer = getSigner();
  if (!signer) throw new Error('온체인 키 저장소: signer 없음');
  return signer.nip44Encrypt(APP_PUBKEY, plaintext);
}

/** 복호화. 실패하면 **던진다** — 호출부가 '모름'으로 받는다 */
async function decrypt(ciphertext: string): Promise<string> {
  const signer = getSigner();
  if (!signer) throw new Error('온체인 키 저장소: signer 없음');
  return signer.nip44Decrypt(APP_PUBKEY, ciphertext);
}

function unknown(e: unknown): KeyLookup {
  return { status: 'unknown', reason: e instanceof Error ? e.message : String(e) };
}

async function readLegacyMap(ciphertext: string): Promise<Record<string, string>> {
  const parsed: unknown = JSON.parse(await decrypt(ciphertext));
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' && HEX_KEY.test(v)) out[k] = v;
  }
  return out;
}

/** 이 기기에 있는가 */
async function readLocal(orderId: string): Promise<KeyLookup> {
  const cipher = localStorage.getItem(LOCAL_PREFIX + orderId);
  if (cipher) {
    try {
      const hex = (await decrypt(cipher)).trim();
      if (!HEX_KEY.test(hex)) return { status: 'unknown', reason: '로컬 키 형식이 이상하다' };
      return { status: 'found', key: keyFromHex(hex) };
    } catch (e) {
      return unknown(e);
    }
  }

  const legacy = localStorage.getItem(LEGACY_LOCAL_KEY);
  if (legacy) {
    try {
      const hex = (await readLegacyMap(legacy))[orderId];
      if (hex) return { status: 'found', key: keyFromHex(hex) };
    } catch (e) {
      return unknown(e);
    }
  }
  return { status: 'none' };
}

/** 릴레이 백업에 있는가 (주문별 → 옛 맵 순) */
async function readRelay(orderId: string): Promise<KeyLookup> {
  if (!getSigner()) return { status: 'unknown', reason: 'signer 없음' };
  const relays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const own = await pool.get(relays, {
      kinds: [APP_DATA_KIND], authors: [APP_PUBKEY], '#d': [KEY_D_PREFIX + orderId],
    });
    if (own?.content) {
      const hex = (await decrypt(own.content)).trim();
      if (!HEX_KEY.test(hex)) return { status: 'unknown', reason: '릴레이 키 형식이 이상하다' };
      return { status: 'found', key: keyFromHex(hex) };
    }
    const legacy = await pool.get(relays, {
      kinds: [APP_DATA_KIND], authors: [APP_PUBKEY], '#d': [LEGACY_D_TAG],
    });
    if (legacy?.content) {
      const hex = (await readLegacyMap(legacy.content))[orderId];
      if (hex) return { status: 'found', key: keyFromHex(hex) };
    }
    return { status: 'none' };
  } catch (e) {
    return unknown(e);
  } finally {
    pool.destroy();
  }
}

async function writeLocal(orderId: string, key: OrderKey): Promise<void> {
  localStorage.setItem(LOCAL_PREFIX + orderId, await encrypt(bytesToHex(key.privkey)));
}

/** 릴레이 백업을 올린다. **실패하면 던진다** — 호출부가 주소 발행을 멈춰야 한다. */
async function publishBackup(orderId: string, key: OrderKey): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('온체인 키 백업: signer 없음');

  const template: EventTemplate = {
    kind: APP_DATA_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', KEY_D_PREFIX + orderId]],
    content: await encrypt(bytesToHex(key.privkey)),
  };
  const signed = await signer.signEvent(template);

  const relays = await getWriteRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    if (!results.some(r => r.status === 'fulfilled')) {
      throw new Error('모든 릴레이에 백업 발행 실패');
    }
    console.log('[OnchainKeys] 백업 발행', orderId, '→', relays.length, '릴레이');
  } finally {
    pool.destroy();
  }
}

/**
 * 그 주문의 어드민 키를 만들고 **백업까지 마친 뒤** 돌려준다.
 *
 * - 이미 있으면 **그걸 쓴다** (재시도해도 키가 바뀌지 않는다 — 바뀌면 이미
 *   발행된 주소를 못 여는 키가 생긴다)
 * - 로컬을 **읽지 못하면** 만들지 않고 던진다 — 있는 키를 모르는 채 새로 만들면
 *   같은 주문에 키가 둘이 된다
 * - 릴레이 백업이 실패하면 **던진다.** 호출부는 주소를 발행하면 안 된다(공격 M)
 */
export async function createOrderKeyWithBackup(orderId: string): Promise<OrderKey> {
  if (!orderId) throw new Error('orderId가 비어 있다');
  if (!getSigner()) throw new Error('온체인 키 저장소: signer 없음');

  let key = memory.get(orderId);
  if (!key) {
    const local = await readLocal(orderId);
    if (local.status === 'unknown') {
      throw new Error(`기존 키를 읽지 못해 만들지 않는다: ${local.reason}`);
    }
    if (local.status === 'found') {
      key = local.key;
    } else {
      key = generateOrderKey();
      // 로컬을 먼저 쓴다 — 릴레이 발행이 실패해도 키를 잃지 않는다.
      await writeLocal(orderId, key);
    }
    memory.set(orderId, key);
  }

  // 백업이 성공해야만 호출부가 진행한다. 같은 주문의 이벤트라 몇 번 올려도 덮이는 건 자기 자신뿐이다.
  await publishBackup(orderId, key);
  return key;
}

/**
 * 이미 만든 키를 꺼낸다 (서명할 때). 확실히 없으면 `null`.
 *
 * ⚠️ **읽지 못했으면 던진다.** "없다"와 "못 읽었다"를 뭉개면 호출부가 "키가 없다 —
 * 중재 불가"로 잘못 결론 내린다. 던지면 호출부는 다음 틱에 다시 해 본다.
 *
 * `expectedXonly`를 주면 **그 주문에 실린 어드민 키와 같은지** 확인한다 — 엉뚱한
 * 키로 서명하면 그 서명은 쓸모가 없고, 그 사실을 종결 직전에야 알게 된다.
 */
export async function getOrderKey(orderId: string, expectedXonly?: string): Promise<OrderKey | null> {
  const check = (key: OrderKey): OrderKey => {
    if (expectedXonly && key.xonly !== expectedXonly) {
      throw new Error(`저장된 어드민 키가 주문의 키와 다르다 (${orderId})`);
    }
    return key;
  };

  const cached = memory.get(orderId);
  if (cached) return check(cached);

  const local = await readLocal(orderId);
  if (local.status === 'found') {
    memory.set(orderId, local.key);
    return check(local.key);
  }
  if (local.status === 'unknown') throw new Error(`어드민 키를 읽지 못했다: ${local.reason}`);

  const relay = await readRelay(orderId);
  if (relay.status === 'found') {
    memory.set(orderId, relay.key);
    // 기기를 바꾼 경우 — 이 기기에도 남긴다.
    await writeLocal(orderId, relay.key).catch(e => console.warn('[OnchainKeys] 로컬 복원 실패', e));
    console.log('[OnchainKeys] 릴레이에서 복원', orderId);
    return check(relay.key);
  }
  if (relay.status === 'unknown') throw new Error(`어드민 키 백업을 읽지 못했다: ${relay.reason}`);
  return null;
}

/** @testing-only */
export function _resetForTesting(): void {
  memory.clear();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && (k.startsWith(LOCAL_PREFIX) || k === LEGACY_LOCAL_KEY)) localStorage.removeItem(k);
  }
}

/** @testing-only — 메모리 캐시만 비운다 (새 세션 흉내) */
export function _forgetMemoryForTesting(): void {
  memory.clear();
}
