/**
 * 릴레이 입출력 — 데몬과 nostr 사이의 유일한 문
 *
 * 인터페이스로 둔 이유는 테스트다: e2e에서 **실패하는 릴레이**(지난 만료 거절, 발행 실패, 중복·순서
 * 뒤섞임)를 흉내 내야 한다. 프론트 시절 "항상 성공" 흉내가 사각지대였다.
 */
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';

export interface PublishReport {
  accepted: string[];
  rejected: Array<{ relay: string; reason: string }>;
}

export interface Subscription {
  close(): void;
}

export interface RelayTransport {
  subscribe(filter: Filter, onEvent: (event: Event) => void): Subscription;
  publish(event: Event): Promise<PublishReport>;
  close(): void;
}

/** 실제 릴레이. 연결 복구는 라이브러리의 ping·재연결에 맡기고, 조용한 죽음은 주기적 재구독이 덮는다(ingress) */
export function createPoolTransport(relays: string[]): RelayTransport {
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  return {
    subscribe(filter, onEvent) {
      const sub = pool.subscribeMany(relays, filter, { onevent: onEvent });
      return { close: () => sub.close() };
    },
    async publish(event) {
      const results = await Promise.allSettled(pool.publish(relays, event));
      const report: PublishReport = { accepted: [], rejected: [] };
      results.forEach((r, i) => {
        const relay = relays[i] ?? '?';
        if (r.status === 'fulfilled') report.accepted.push(relay);
        else report.rejected.push({ relay, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
      });
      return report;
    },
    close() {
      pool.destroy();
    },
  };
}
