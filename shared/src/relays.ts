import { SimplePool } from 'nostr-tools/pool';
import {
  APP_PUBKEY,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  STORAGE_KEYS,
  RELAY_REFRESH_INTERVAL_MS,
} from './constants';
import type { StorageAdapter, CachedRelayList } from './types';

/**
 * 앱 pubkey의 NIP-65 (kind 10002) 이벤트에서 READ 릴레이 목록을 가져온다.
 * Outbox model: customer는 앱의 read relay에 write하고, sponsor는 거기서 read한다.
 */
async function fetchAppReadRelays(): Promise<string[]> {
  const pool = new SimplePool();

  try {
    const event = await pool.get(DISCOVERY_RELAYS, {
      kinds: [10002],
      authors: [APP_PUBKEY],
    });

    if (!event) {
      console.warn('[Nostr] No kind 10002 event found for app pubkey, using fallbacks');
      return FALLBACK_RELAYS;
    }

    const readRelays = event.tags
      .filter((tag): tag is [string, string, ...string[]] =>
        tag[0] === 'r' && typeof tag[1] === 'string'
      )
      .filter(tag => !tag[2] || tag[2] === 'read')
      .map(tag => tag[1]);

    if (readRelays.length === 0) {
      console.warn('[Nostr] App has no read relays in kind 10002, using fallbacks');
      return FALLBACK_RELAYS;
    }

    console.log('[Nostr] Discovered app read relays:', readRelays);
    return readRelays;
  } catch (err) {
    console.error('[Nostr] Failed to discover relays:', err);
    return FALLBACK_RELAYS;
  } finally {
    pool.destroy();
  }
}

/**
 * 캐시된 릴레이 목록을 반환한다. stale이면(10분 초과) 자동 갱신.
 */
export async function getRelays(storage: StorageAdapter): Promise<string[]> {
  const cached = await storage.get<CachedRelayList>(STORAGE_KEYS.RELAYS);

  if (cached && cached.relays.length > 0 && Date.now() - cached.fetchedAt < RELAY_REFRESH_INTERVAL_MS) {
    return cached.relays;
  }

  return refreshRelays(storage);
}

/**
 * 릴레이 목록을 네트워크에서 새로 조회하고 캐시를 업데이트한다.
 */
export async function refreshRelays(storage: StorageAdapter): Promise<string[]> {
  const relays = await fetchAppReadRelays();

  const cached: CachedRelayList = {
    relays,
    fetchedAt: Date.now(),
  };

  await storage.set(STORAGE_KEYS.RELAYS, cached);
  console.log('[Nostr] Relay list cached:', relays);

  return relays;
}
