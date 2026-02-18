import { SimplePool } from 'nostr-tools/pool';
import {
  APP_PUBKEY,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  STORAGE_KEYS,
  RELAY_REFRESH_INTERVAL_MS,
} from './constants';
import type { StorageAdapter, CachedRelayList } from './types';

interface RelayLists {
  read: string[];
  write: string[];
}

/**
 * 앱 pubkey의 NIP-65 (kind 10002) 이벤트에서 읽기/쓰기 릴레이 목록을 가져온다.
 * Outbox model: customer는 앱의 read relay에 write하고, sponsor는 거기서 read한다.
 */
async function fetchAppRelayLists(): Promise<RelayLists> {
  const pool = new SimplePool();

  try {
    const event = await pool.get(DISCOVERY_RELAYS, {
      kinds: [10002],
      authors: [APP_PUBKEY],
    });

    if (!event) {
      console.warn('[Nostr] No kind 10002 event found for app pubkey, using fallbacks');
      return { read: FALLBACK_RELAYS, write: FALLBACK_RELAYS };
    }

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

    if (read.length === 0) {
      console.warn('[Nostr] App has no read relays in kind 10002, using fallbacks');
      return { read: FALLBACK_RELAYS, write: write.length > 0 ? write : FALLBACK_RELAYS };
    }

    console.log('[Nostr] Discovered relay lists — read:', read, 'write:', write);
    return { read, write: write.length > 0 ? write : FALLBACK_RELAYS };
  } catch (err) {
    console.error('[Nostr] Failed to discover relays:', err);
    return { read: FALLBACK_RELAYS, write: FALLBACK_RELAYS };
  } finally {
    pool.destroy();
  }
}

/**
 * 캐시된 읽기 릴레이 목록을 반환한다. stale이면(10분 초과) 자동 갱신.
 */
export async function getReadRelays(storage: StorageAdapter): Promise<string[]> {
  const cached = await storage.get<CachedRelayList>(STORAGE_KEYS.READ_RELAYS);

  if (cached && cached.relays.length > 0 && Date.now() - cached.fetchedAt < RELAY_REFRESH_INTERVAL_MS) {
    return cached.relays;
  }

  const { read } = await refreshRelayLists(storage);
  return read;
}

/**
 * 캐시된 쓰기 릴레이 목록을 반환한다. stale이면(10분 초과) 자동 갱신.
 */
export async function getWriteRelays(storage: StorageAdapter): Promise<string[]> {
  const cached = await storage.get<CachedRelayList>(STORAGE_KEYS.WRITE_RELAYS);

  if (cached && cached.relays.length > 0 && Date.now() - cached.fetchedAt < RELAY_REFRESH_INTERVAL_MS) {
    return cached.relays;
  }

  const { write } = await refreshRelayLists(storage);
  return write;
}

/**
 * 릴레이 목록을 네트워크에서 새로 조회하고 읽기/쓰기 캐시를 모두 업데이트한다.
 */
export async function refreshRelayLists(storage: StorageAdapter): Promise<RelayLists> {
  const lists = await fetchAppRelayLists();
  const now = Date.now();

  await Promise.all([
    storage.set(STORAGE_KEYS.READ_RELAYS, { relays: lists.read, fetchedAt: now } satisfies CachedRelayList),
    storage.set(STORAGE_KEYS.WRITE_RELAYS, { relays: lists.write, fetchedAt: now } satisfies CachedRelayList),
  ]);

  console.log('[Nostr] Relay lists cached — read:', lists.read, 'write:', lists.write);
  return lists;
}
