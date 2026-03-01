/**
 * Nostr 구독 모듈
 *
 * 1. Admin kind 30402 오더 구독
 * 2. 유저스크립트 kind 1111 이벤트 구독 (#p=self)
 */
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import { SAJWO_REQUEST_KIND, SAJWO_REQUEST_EVENT_KIND, APP_PUBKEY, CLIENT_TAG, NOSTR_SINCE } from '@sajwo-tracker/shared';

export interface CustomerSubscriptionCallbacks {
  onOrder: (event: Event) => void;
  onEose: () => void;
}

/**
 * Admin kind 30402 오더를 구독한다.
 * 반환: cleanup 함수
 */
export function subscribeAdminOrders(
  relays: string[],
  callbacks: CustomerSubscriptionCallbacks,
): () => void {
  const pool = new SimplePool();

  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_KIND],
      authors: [APP_PUBKEY],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    {
      onevent: callbacks.onOrder,
      oneose: callbacks.onEose,
    },
  );

  console.log('[Customer] Subscribed to Admin orders on', relays.length, 'relays');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[Customer] Admin order subscription closed');
  };
}

// ── 유저스크립트 kind 1111 구독 ──────────────────────

export interface UserscriptSubscriptionCallbacks {
  onEvent: (event: Event) => void;
  onEose: () => void;
}

/**
 * 자기 pubkey로 발행된 kind 1111 이벤트를 구독한다.
 * 유저스크립트가 발행한 parsed-order 등을 수신.
 */
export function subscribeUserscriptEvents(
  relays: string[],
  myPubkey: string,
  callbacks: UserscriptSubscriptionCallbacks,
): () => void {
  const pool = new SimplePool();

  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [SAJWO_REQUEST_EVENT_KIND],
      '#p': [myPubkey],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    {
      onevent: callbacks.onEvent,
      oneose: callbacks.onEose,
    },
  );

  console.log('[Customer] Subscribed to userscript events on', relays.length, 'relays');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[Customer] Userscript event subscription closed');
  };
}
