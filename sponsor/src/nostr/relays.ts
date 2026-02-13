import { SimplePool } from 'nostr-tools/pool';
import {
  APP_PUBKEY,
  DISCOVERY_RELAYS,
  FALLBACK_RELAYS,
  STORAGE_KEYS,
  RELAY_REFRESH_INTERVAL_MS,
} from './constants';

interface CachedRelayList {
  relays: string[];
  fetchedAt: number;
}

/**
 * 앱 pubkey의 NIP-65 (kind 10002) 이벤트에서 READ 릴레이 목록을 가져온다.
 * Outbox model: sponsor는 앱의 read relay에서 사줘 요청을 구독한다.
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

function loadCache(): CachedRelayList | null {
  const stored = localStorage.getItem(STORAGE_KEYS.RELAYS);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as CachedRelayList;
    if (parsed.relays?.length > 0 && parsed.fetchedAt) {
      return parsed;
    }
  } catch {
    // 파싱 실패
  }
  return null;
}

function saveCache(relays: string[]): void {
  const data: CachedRelayList = { relays, fetchedAt: Date.now() };
  localStorage.setItem(STORAGE_KEYS.RELAYS, JSON.stringify(data));
}

/**
 * 릴레이 목록을 반환한다.
 * localStorage 캐시가 유효하면(10분 이내) 즉시 반환, stale이면 네트워크 갱신.
 */
export async function getRelays(): Promise<string[]> {
  const cached = loadCache();

  if (cached && Date.now() - cached.fetchedAt < RELAY_REFRESH_INTERVAL_MS) {
    return cached.relays;
  }

  return refreshRelays();
}

/**
 * 릴레이 목록을 네트워크에서 새로 조회하고 localStorage에 저장한다.
 */
export async function refreshRelays(): Promise<string[]> {
  const relays = await fetchAppReadRelays();
  saveCache(relays);
  console.log('[Nostr] Relay list cached to localStorage:', relays);
  return relays;
}
