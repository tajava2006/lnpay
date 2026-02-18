import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  STORAGE_KEYS,
} from './constants';
import type { StorageAdapter, CachedRelayList } from './types';

interface RelayLists {
  read: string[];
  write: string[];
}

// ============================================================
// 이벤트 파싱
// ============================================================

/** kind 10002 이벤트에서 읽기/쓰기 릴레이 목록을 추출한다. */
function parseRelayListEvent(event: Event): RelayLists {
  const relayTags = event.tags.filter(
    (tag): tag is [string, string, ...string[]] =>
      tag[0] === 'r' && typeof tag[1] === 'string',
  );

  const read = relayTags
    .filter(tag => !tag[2] || tag[2] === 'read')
    .map(tag => tag[1]);

  const write = relayTags
    .filter(tag => !tag[2] || tag[2] === 'write')
    .map(tag => tag[1]);

  return { read, write };
}

// ============================================================
// 지속 구독
// ============================================================

/** 배열이 동일한 요소를 같은 순서로 갖는지 비교한다. */
function areSame(a: string[] | undefined, b: string[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * 수신한 릴레이 리스트를 저장소의 캐시와 비교하고, 더 최신이면 저장한다.
 * 변경이 있으면 로그를 출력한다.
 */
async function compareAndSave(
  storage: StorageAdapter,
  newLists: RelayLists,
  createdAt: number,
): Promise<void> {
  const [oldRead, oldWrite] = await Promise.all([
    storage.get<CachedRelayList>(STORAGE_KEYS.READ_RELAYS),
    storage.get<CachedRelayList>(STORAGE_KEYS.WRITE_RELAYS),
  ]);

  // 과거 이벤트 재전파 방어: 저장된 것보다 오래된 이벤트는 무시
  const storedCreatedAt = Math.max(oldRead?.createdAt ?? 0, oldWrite?.createdAt ?? 0);
  if (createdAt < storedCreatedAt) {
    console.log(
      `[Relay] 과거 릴레이 이벤트 무시 (저장: ${storedCreatedAt}, 수신: ${createdAt})`,
    );
    return;
  }

  const readChanged = !areSame(oldRead?.relays, newLists.read);
  const writeChanged = !areSame(oldWrite?.relays, newLists.write);

  if (!readChanged && !writeChanged) return;

  const now = Date.now();

  if (!oldRead?.relays || !oldWrite?.relays) {
    // 최초 초기화
    console.log(
      '[Relay] 릴레이 리스트 초기화 — 읽기:',
      newLists.read,
      '쓰기:',
      newLists.write,
    );
  } else {
    if (readChanged) {
      console.log(
        '[Relay] 읽기 릴레이 변경됨:',
        oldRead.relays,
        '→',
        newLists.read,
      );
    }
    if (writeChanged) {
      console.log(
        '[Relay] 쓰기 릴레이 변경됨:',
        oldWrite.relays,
        '→',
        newLists.write,
      );
    }
  }

  await Promise.all([
    readChanged
      ? storage.set(STORAGE_KEYS.READ_RELAYS, {
          relays: newLists.read,
          fetchedAt: now,
          createdAt,
        } satisfies CachedRelayList)
      : Promise.resolve(),
    writeChanged
      ? storage.set(STORAGE_KEYS.WRITE_RELAYS, {
          relays: newLists.write,
          fetchedAt: now,
          createdAt,
        } satisfies CachedRelayList)
      : Promise.resolve(),
  ]);
}

/**
 * DISCOVERY_RELAYS에서 kind 10002를 지속 구독하여 릴레이 리스트 변경을 실시간 반영한다.
 *
 * 구독 자체가 초기 로드 + 실시간 업데이트를 겸한다:
 * REQ → 릴레이에 저장된 이벤트 전달 → EOSE → 이후 업데이트 수신
 *
 * @returns cleanup 함수
 */
export function subscribeRelayLists(storage: StorageAdapter): () => void {
  const pool = new SimplePool();

  const sub = pool.subscribeMany(
    DISCOVERY_RELAYS,
    { kinds: [10002], authors: [APP_PUBKEY] },
    {
      onevent: (event) => {
        const newLists = parseRelayListEvent(event);
        void compareAndSave(storage, newLists, event.created_at);
      },
      oneose: () => {
        console.log('[Relay] 릴레이 리스트 초기 동기화 완료');
      },
    },
  );

  return () => {
    sub.close();
    pool.destroy();
  };
}

// ============================================================
// 캐시 읽기 (저장소에서 즉시 반환, 비어있으면 one-shot fetch)
// ============================================================

/**
 * 캐시된 읽기 릴레이 목록을 반환한다.
 * 저장소가 비어있으면(최초 실행) one-shot fetch로 채운다.
 */
export async function getReadRelays(storage: StorageAdapter): Promise<string[]> {
  const cached = await storage.get<CachedRelayList>(STORAGE_KEYS.READ_RELAYS);

  if (cached && cached.relays.length > 0) {
    return cached.relays;
  }

  const { read } = await refreshRelayLists(storage);
  return read;
}

/**
 * 캐시된 쓰기 릴레이 목록을 반환한다.
 * 저장소가 비어있으면(최초 실행) one-shot fetch로 채운다.
 */
export async function getWriteRelays(storage: StorageAdapter): Promise<string[]> {
  const cached = await storage.get<CachedRelayList>(STORAGE_KEYS.WRITE_RELAYS);

  if (cached && cached.relays.length > 0) {
    return cached.relays;
  }

  const { write } = await refreshRelayLists(storage);
  return write;
}

// ============================================================
// One-shot fetch (cold-start 폴백 + 초기 부트스트랩)
// ============================================================

/**
 * 릴레이 목록을 네트워크에서 새로 조회하고 읽기/쓰기 캐시를 모두 업데이트한다.
 * 지속 구독이 아직 이벤트를 전달하지 않은 cold-start 상황의 폴백용.
 */
export async function refreshRelayLists(storage: StorageAdapter): Promise<RelayLists> {
  const pool = new SimplePool();

  try {
    const event = await pool.get(DISCOVERY_RELAYS, {
      kinds: [10002],
      authors: [APP_PUBKEY],
    });

    if (!event) {
      console.warn('[Relay] kind 10002 이벤트 없음, 폴백 릴레이 사용');
      const lists = { read: FALLBACK_RELAYS, write: FALLBACK_RELAYS };
      await saveRelayLists(storage, lists, 0);
      return lists;
    }

    const lists = parseRelayListEvent(event);

    if (lists.read.length === 0) {
      console.warn('[Relay] 읽기 릴레이 없음, 폴백 사용');
      lists.read = FALLBACK_RELAYS;
    }
    if (lists.write.length === 0) {
      lists.write = FALLBACK_RELAYS;
    }

    await saveRelayLists(storage, lists, event.created_at);
    console.log('[Relay] 릴레이 리스트 캐시됨 — 읽기:', lists.read, '쓰기:', lists.write);
    return lists;
  } catch (err) {
    console.error('[Relay] 릴레이 디스커버리 실패:', err);
    const lists = { read: FALLBACK_RELAYS, write: FALLBACK_RELAYS };
    await saveRelayLists(storage, lists, 0);
    return lists;
  } finally {
    pool.destroy();
  }
}

/** 릴레이 리스트를 저장소에 기록한다. */
async function saveRelayLists(
  storage: StorageAdapter,
  lists: RelayLists,
  createdAt: number,
): Promise<void> {
  const now = Date.now();
  await Promise.all([
    storage.set(STORAGE_KEYS.READ_RELAYS, {
      relays: lists.read,
      fetchedAt: now,
      createdAt,
    } satisfies CachedRelayList),
    storage.set(STORAGE_KEYS.WRITE_RELAYS, {
      relays: lists.write,
      fetchedAt: now,
      createdAt,
    } satisfies CachedRelayList),
  ]);
}
