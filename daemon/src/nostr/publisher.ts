/**
 * 발행 효과 — 서명된 이벤트를 릴레이에 낸다 (PLAN-DAEMON §4.4)
 *
 * **서명은 의도를 쌓을 때 한 번** 한다. 재시도가 같은 id의 같은 이벤트를 다시 내므로 멱등이다 —
 * 매번 새로 서명하면 재시도마다 id가 다른 이벤트가 쌓일 수 있다.
 *
 * 한 릴레이라도 받으면 성공으로 친다. 만료(NIP-40)가 지난 이벤트는 릴레이가 어차피 거절하므로 포기한다.
 */
import type { Event } from 'nostr-tools/core';
import type { EffectExecutor } from '../effects';
import type { RelayTransport } from './transport';

export const PUBLISH_EFFECT = 'nostr.publish';

export interface PublishPayload {
  event: Event;
}

export function createPublishExecutor(transport: RelayTransport, nowMs: () => number): EffectExecutor<PublishPayload> {
  return {
    async run({ event }) {
      const expiration = Number(event.tags.find(t => t[0] === 'expiration')?.[1] ?? 0);
      if (expiration > 0 && expiration <= Math.floor(nowMs() / 1000)) {
        return { status: 'dead', error: '만료가 지나 릴레이가 받지 않는다' };
      }
      const report = await transport.publish(event);
      if (report.accepted.length > 0) return { status: 'done', result: report };
      const reasons = report.rejected.map(r => `${r.relay}: ${r.reason}`).join('; ') || '릴레이 없음';
      return { status: 'retry', error: reasons };
    },
  };
}
