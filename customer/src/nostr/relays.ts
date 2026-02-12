import { SimplePool } from 'nostr-tools/pool';
import {
  STORAGE_KEYS,
  APP_PUBKEY,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  RELAY_REFRESH_INTERVAL_MINUTES,
} from './constants';
import type { CachedRelayList } from '../shared/types';

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

    // NIP-65: ['r', url] 또는 ['r', url, 'read'] 또는 ['r', url, 'write']
    // marker 없으면 read+write, 'read'면 read relay
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
 * 캐시된 릴레이 목록을 반환한다. stale이면 자동 갱신.
 */
export async function getRelays(): Promise<string[]> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.RELAYS);
  const cached = result[STORAGE_KEYS.RELAYS] as CachedRelayList | undefined;

  const maxAge = RELAY_REFRESH_INTERVAL_MINUTES * 60 * 1000;
  const isStale = !cached || Date.now() - cached.fetchedAt > maxAge;

  if (!isStale && cached.relays.length > 0) {
    return cached.relays;
  }

  return refreshRelays();
}

/**
 * 릴레이 목록을 네트워크에서 새로 조회하고 캐시를 업데이트한다.
 */
export async function refreshRelays(): Promise<string[]> {
  const relays = await fetchAppReadRelays();

  const cached: CachedRelayList = {
    relays,
    fetchedAt: Date.now(),
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.RELAYS]: cached });
  console.log('[Nostr] Relay list cached:', relays);

  return relays;
}
