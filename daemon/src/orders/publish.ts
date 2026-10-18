/**
 * 오더 발행 — 두 트랙 공용. 공개 오더는 한 장, 지정 거래는 수신자(고객 · 지정 후원자 · 운영자)마다 암호문 스냅샷 한 장
 * (LN-TRACK §7 · ONCHAIN-TRACK §10 · PROTOCOL §2). 태그 배열은 같다 — 받는 쪽이 스냅샷을 열면 공개 오더와 똑같은 이벤트다.
 *
 * **봉하지 못하는 수신자는 빼고 낸다.** 암호화 실패(곡선 밖 pubkey 등)는 결정적이라 다시 해도 안 낫는다 — 통째로 던지면
 * 효과가 영원히 재시도하고 나머지 수신자도 거래를 못 본다(2026-10-18 리뷰). 뺀 수신자는 부르는 쪽이 경보로 올린다.
 * 릴레이가 안 받은 건 다르다 — 그건 다시 하면 낫는다(`publishAll`).
 */
import type { Event } from 'nostr-tools/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { ORDER_KIND, designatedOrderTemplate } from '@sajwo-tracker/shared/core';
import { raiseAlert } from '../admin/alerts';
import type { AdminContext } from '../admin/context';
import type { RelayTransport } from '../nostr/transport';

export interface OrderEvents {
  events: Event[];
  /** 스냅샷을 봉하지 못해 뺀 수신자 */
  skipped: string[];
}

export function orderEvents(ctx: Pick<AdminContext, 'appKey' | 'operators'>, p: {
  orderId: string;
  customer: string;
  designatedSponsor: string | null | undefined;
  trackTag: string;
  tags: string[][];
  retainUntil: number;
  createdAt: number;
}): OrderEvents {
  const sk = ctx.appKey.secretKey;
  if (!p.designatedSponsor) {
    return { events: [finalizeEvent({ kind: ORDER_KIND, created_at: p.createdAt, tags: p.tags, content: '' }, sk)], skipped: [] };
  }
  const events: Event[] = [];
  const skipped: string[] = [];
  for (const recipient of new Set([p.customer, p.designatedSponsor, ...ctx.operators])) {
    try {
      events.push(finalizeEvent(designatedOrderTemplate({
        orderId: p.orderId, recipient, trackTag: p.trackTag, tags: p.tags, retainUntil: p.retainUntil,
        createdAt: p.createdAt, appSecretKey: sk,
      }), sk));
    } catch {
      skipped.push(recipient);
    }
  }
  return { events, skipped };
}

/**
 * 전부 낸다. 한 장이라도 아무 릴레이도 안 받았으면 실패 사유를 돌려준다(다시 하면 된다 — 그 수신자는 거래를 못 본다).
 * 주소형이라 다시 내도 같은 자리를 덮는다. 다 나갔으면 null
 */
export async function publishAll(transport: RelayTransport, events: readonly Event[]): Promise<string | null> {
  const reports = await Promise.all(events.map(e => transport.publish(e)));
  const failed = reports.filter(r => r.accepted.length === 0);
  if (failed.length === 0) return null;
  return failed.flatMap(r => r.rejected.map(x => x.reason)).join('; ') || '릴레이 없음';
}

/** 뺀 수신자를 운영자에게 — 그 사람은 이 거래를 못 본다. 수신자마다 한 번 */
export function alertSkippedRecipients(
  ctx: AdminContext, track: 'ln' | 'onchain', orderId: string, skipped: readonly string[],
): void {
  for (const recipient of skipped) {
    raiseAlert(ctx, {
      dedup: `${track}:${orderId}:unsealable:${recipient}`, level: 'anomaly', track, orderId,
      message: `지정 거래 스냅샷을 봉하지 못해 이 수신자를 뺐다 — 그 사람은 거래를 못 본다(${recipient.slice(0, 12)}…)`,
    });
  }
}
