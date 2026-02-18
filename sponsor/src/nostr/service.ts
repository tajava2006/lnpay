/**
 * Nostr 구독 서비스
 *
 * 앱 레벨에서 한 번 시작하여 사줘 요청 이벤트를 실시간 구독하고,
 * 수신한 이벤트를 order-store에 반영한다.
 *
 * UI 컴포넌트는 이 서비스를 직접 참조하지 않으며,
 * order-store를 통해 간접적으로 데이터를 읽는다.
 */
import type { Event } from 'nostr-tools/core';
import { getReadRelays } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeSajwoRequests } from './subscribe';
import { parseEvent } from '../types';
import { upsertOrder, deleteOrder, markSynced } from '../order-store';

let cleanup: (() => void) | null = null;

/** 사줘 요청 구독을 시작한다. 이미 실행 중이면 무시한다. */
export async function startOrderSubscription(): Promise<void> {
  if (cleanup) return;

  const relays = await getReadRelays(storage);

  cleanup = subscribeSajwoRequests(relays, {
    onActive: (event: Event) => {
      const parsed = parseEvent(event);
      if (parsed) upsertOrder(parsed);
    },
    onSold: (event: Event) => {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (dTag) deleteOrder(dTag, event.pubkey);
    },
    onEose: () => {
      markSynced();
    },
  });
}

/** 구독을 중지한다. */
export function stopOrderSubscription(): void {
  cleanup?.();
  cleanup = null;
}
