/**
 * APP의 릴레이 목록 찾기 (NIP-65)
 *
 * 유저 앱은 APP의 kind 10002 읽기 목록으로 오더를 읽고 요청을 보낸다(`shared/relays.ts`). 데몬이 다른
 * 릴레이를 보면 서로 못 만난다 — 그래서 설정으로 고정하지 않았으면 같은 목록을 쓴다.
 */
import type { Event } from 'nostr-tools/core';
import { SimplePool } from 'nostr-tools/pool';
import { DISCOVERY_RELAYS, FALLBACK_RELAYS } from '@sajwo-tracker/shared/core';

/** kind 10002에서 읽기 릴레이 — 표시가 없거나 `read`인 `r` 태그 */
export function readRelaysOf(event: Pick<Event, 'tags'>): string[] {
  const urls = event.tags
    .filter(t => t[0] === 'r' && typeof t[1] === 'string' && /^wss?:\/\//.test(t[1]) && (t[2] === undefined || t[2] === 'read'))
    .map(t => t[1]!);
  return [...new Set(urls)];
}

export async function discoverAppRelays(appPubkey: string, timeoutMs = 8_000): Promise<{ relays: string[]; fallback: boolean }> {
  const pool = new SimplePool();
  try {
    const event = await pool.get(DISCOVERY_RELAYS, { kinds: [10002], authors: [appPubkey] }, { maxWait: timeoutMs });
    const relays = event ? readRelaysOf(event) : [];
    return relays.length > 0 ? { relays, fallback: false } : { relays: [...FALLBACK_RELAYS], fallback: true };
  } catch {
    return { relays: [...FALLBACK_RELAYS], fallback: true };
  } finally {
    pool.destroy();
  }
}
