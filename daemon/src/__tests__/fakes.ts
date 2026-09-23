/**
 * 테스트용 가짜들 — 특히 **실패하는 릴레이.**
 *
 * 프론트 시절 e2e가 릴레이를 "항상 성공"으로 흉내 내서, 발행 실패·만료 거절 경로가 한 번도 안
 * 걸렸다(PLAN-ONCHAIN-TRACK 리뷰 #8). 여기 릴레이는 일부러 실패시킬 수 있고, 지난 만료를 거절하고,
 * 같은 이벤트를 두 번 줄 수 있다.
 */
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SAJWO_REQUEST_EVENT_KIND, nip44Decrypt, nip44Encrypt } from '@sajwo-tracker/shared/core';
import type { PublishReport, RelayTransport, Subscription } from '../nostr/transport';
import { ADMIN_COMMAND } from '../admin/commands';
import type { AppKey } from '../secrets';

export class FakeRelay implements RelayTransport {
  /** 릴레이가 들고 있는 이벤트 (주입 + 발행) */
  readonly stored: Event[] = [];
  /** 데몬이 발행에 성공한 것 */
  readonly published: Event[] = [];
  /** 다음 N번 발행을 실패시킨다 */
  failNext = 0;
  /** 구독에 같은 이벤트를 두 번 준다 */
  duplicateDelivery = false;
  publishAttempts = 0;

  private readonly subs = new Set<{ filter: Filter; onEvent: (e: Event) => void }>();

  constructor(private readonly nowMs: () => number) {}

  subscribe(filter: Filter, onEvent: (event: Event) => void): Subscription {
    const sub = { filter, onEvent };
    this.subs.add(sub);
    for (const e of this.stored) if (matches(filter, e)) this.deliver(sub, e);
    return { close: () => { this.subs.delete(sub); } };
  }

  async publish(event: Event): Promise<PublishReport> {
    this.publishAttempts += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { accepted: [], rejected: [{ relay: 'wss://fake', reason: 'relay down' }] };
    }
    const exp = Number(event.tags.find(t => t[0] === 'expiration')?.[1] ?? 0);
    if (exp > 0 && exp <= Math.floor(this.nowMs() / 1000)) {
      return { accepted: [], rejected: [{ relay: 'wss://fake', reason: 'invalid: event is expired' }] };
    }
    this.published.push(event);
    this.store(event);
    return { accepted: ['wss://fake'], rejected: [] };
  }

  /** 바깥(유저·운영자)이 발행한 것처럼 넣는다 */
  inject(event: Event): void {
    this.store(event);
  }

  close(): void {
    this.subs.clear();
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  private store(event: Event): void {
    if (!this.stored.some(e => e.id === event.id)) this.stored.push(event);
    for (const sub of this.subs) if (matches(sub.filter, event)) this.deliver(sub, event);
  }

  private deliver(sub: { onEvent: (e: Event) => void }, event: Event): void {
    sub.onEvent(event);
    if (this.duplicateDelivery) sub.onEvent(event);
  }
}

function matches(filter: Filter, e: Event): boolean {
  if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
  if (filter.authors && !filter.authors.includes(e.pubkey)) return false;
  if (filter.since !== undefined && e.created_at < filter.since) return false;
  if (filter.until !== undefined && e.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!e.tags.some(t => t[0] === name && (values as string[]).includes(t[1] ?? ''))) return false;
  }
  return true;
}

// ── 키 ──────────────────────────────────────────────────────

export interface TestKey {
  secretKey: Uint8Array;
  pubkey: string;
}

export function newKey(): TestKey {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export function appKeyOf(key: TestKey): AppKey {
  return { secretKey: key.secretKey, pubkey: key.pubkey };
}

// ── 운영자 명령 ─────────────────────────────────────────────

export function adminCommand(
  operator: TestKey,
  appPubkey: string,
  adminTag: string,
  payload: unknown,
  createdAt: number,
): Event {
  return finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['p', appPubkey],
      ['t', adminTag],
      ['action', ADMIN_COMMAND],
      ['expiration', String(createdAt + 600)],
    ],
    content: nip44Encrypt(JSON.stringify(payload), operator.secretKey, appPubkey),
  }, operator.secretKey);
}

/** 결과 이벤트를 운영자 키로 연다 */
export function openResult(result: Event, operator: TestKey, appPubkey: string): unknown {
  return JSON.parse(nip44Decrypt(result.content, operator.secretKey, appPubkey));
}
