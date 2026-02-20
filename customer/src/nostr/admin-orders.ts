/**
 * Admin kind 30402 오더 구독
 *
 * Admin이 발행한 오더를 구독하여 자기 주문의 상태를 추적한다.
 * customer 태그가 자신의 pubkey와 일치하는 오더만 처리한다.
 */
import { SimplePool } from 'nostr-tools/pool';
import {
  SAJWO_REQUEST_KIND,
  APP_PUBKEY,
  CLIENT_TAG,
  NOSTR_SINCE,
  ensureKeypair,
  getReadRelays,
  type OrderState,
} from '@sajwo-tracker/shared';
import { storage } from './storage';
import { getOrder, saveOrder } from '../shared/storage';
import { transitionOrderWithRetry } from '../shared/state-machine';

let cleanup: (() => void) | null = null;

/**
 * Admin 오더 구독을 시작한다.
 * customer 태그로 자기 주문을 필터링하고, adminState를 chrome.storage.local에 반영한다.
 */
export async function startAdminOrderSubscription(): Promise<void> {
  if (cleanup) return;

  const [keypair, relays] = await Promise.all([
    ensureKeypair(storage),
    getReadRelays(storage),
  ]);
  const myPubkey = keypair.publicKey;

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
      onevent: (event) => {
        const customerTag = event.tags.find(t => t[0] === 'customer')?.[1];
        if (customerTag !== myPubkey) return;

        const orderId = event.tags.find(t => t[0] === 'd')?.[1];
        if (!orderId) return;

        const adminState = (event.tags.find(t => t[0] === 'state')?.[1] ?? 'requested') as OrderState;

        void handleAdminOrderUpdate(orderId, adminState);
      },
      oneose: () => {
        console.log('[Customer] Admin orders EOSE');
      },
    },
  );

  cleanup = () => {
    sub.close();
    pool.destroy();
    console.log('[Customer] Admin order subscription closed');
  };

  console.log('[Customer] Subscribed to Admin orders on', relays.length, 'relays');
}

export function stopAdminOrderSubscription(): void {
  cleanup?.();
  cleanup = null;
}

/**
 * Admin 오더 상태 갱신을 로컬 스토리지에 반영한다.
 * - adminState 필드를 항상 갱신
 * - 최종 상태(paid, rejected, cancelled)는 로컬 상태도 전이
 */
async function handleAdminOrderUpdate(orderId: string, adminState: OrderState): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) return;

  // adminState 갱신
  if (order.adminState !== adminState) {
    await saveOrder({ ...order, adminState });
    console.log('[Customer] Order', orderId, 'adminState →', adminState);
  }

  // 최종 상태 반영: Admin에서 완료/거절/취소 시 로컬도 전이
  if (adminState === 'paid' && order.status !== 'paid') {
    await transitionOrderWithRetry(orderId, 'paid');
  } else if (
    (adminState === 'rejected' || adminState === 'cancelled')
    && order.status !== 'cancelled'
  ) {
    await transitionOrderWithRetry(orderId, 'cancelled');
  }
}
