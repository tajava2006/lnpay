/**
 * 통합 구독 (고객 역할 + 후원자 역할 공용)
 *
 * 합치기 전 두 앱은 각자 구독을 돌렸지만 필터가 문자 그대로 같았다:
 *   { kinds:[ORDER_KIND],   authors:[APP_PUBKEY], '#t':[CLIENT_TAG] }
 *   { kinds:[MESSAGE_KIND], '#p':[myPubkey],      '#t':[CLIENT_TAG] }
 *
 * 어느 쪽도 서버에서 역할별로 좁힐 수 없다 — 오더 이벤트는 오더북에 남의 주문까지
 * 다 필요하고, `customer`/`sponsor`는 다중 문자 태그라 릴레이 인덱싱이
 * 보장되지 않는다. 그래서 원래부터 전부 받아 클라이언트에서 갈랐다.
 * 합치면 소켓 구독이 두 벌에서 한 벌로 줄고, 갈라내는 위치만 한 군데가 된다.
 */
import type { Event } from 'nostr-tools/core';
import {
  createSubscriptionPool,
  ORDER_KIND,
  MESSAGE_KIND,
  CLIENT_TAG,
  APP_PUBKEY,
  NOSTR_SINCE,
} from '@sajwo-tracker/shared';

export interface OrderSubscriptionCallbacks {
  /** Admin이 발행한 오더 이벤트 (내 주문 + 오더북 전부) */
  onOrder: (event: Event) => void;
  onEose: () => void;
}

export interface InboxSubscriptionCallbacks {
  /** 나에게 온 요청·통지 이벤트 (계좌정보·보증금·파싱주문·분쟁 등) */
  onEvent: (event: Event) => void;
  onEose: () => void;
}

/** Admin 발행 오더를 구독한다. 역할 구분 없이 전부 받는다. */
export function subscribeOrders(
  relays: string[],
  callbacks: OrderSubscriptionCallbacks,
): () => void {
  const pool = createSubscriptionPool();

  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [ORDER_KIND],
      authors: [APP_PUBKEY],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    { onevent: callbacks.onOrder, oneose: callbacks.onEose },
  );

  console.log('[Nostr] 오더 구독 시작 —', relays.length, '릴레이');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[Nostr] 오더 구독 종료');
  };
}

/** 나에게 향하는 요청 이벤트를 구독한다. action 분기는 호출자가 한다. */
export function subscribeInbox(
  relays: string[],
  myPubkey: string,
  callbacks: InboxSubscriptionCallbacks,
): () => void {
  const pool = createSubscriptionPool();

  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [MESSAGE_KIND],
      '#p': [myPubkey],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    { onevent: callbacks.onEvent, oneose: callbacks.onEose },
  );

  console.log('[Nostr] 수신함 구독 시작 —', myPubkey.slice(0, 8), '/', relays.length, '릴레이');

  return () => {
    sub.close();
    pool.destroy();
    console.log('[Nostr] 수신함 구독 종료');
  };
}

/**
 * 내가 보낸 요청 이벤트를 구독한다 — 로컬에만 있던 기록을 릴레이에서 되살린다(`own-requests.ts`).
 * 키를 다른 기기로 옮겨도 거래가 이어지는 이유가 이 구독이다.
 */
export function subscribeOwnRequests(
  relays: string[],
  myPubkey: string,
  onEvent: (event: Event) => void,
): () => void {
  const pool = createSubscriptionPool();
  const sub = pool.subscribeMany(
    relays,
    {
      kinds: [MESSAGE_KIND],
      authors: [myPubkey],
      '#t': [CLIENT_TAG],
      ...(NOSTR_SINCE != null && { since: NOSTR_SINCE }),
    },
    { onevent: onEvent },
  );
  return () => {
    sub.close();
    pool.destroy();
  };
}
