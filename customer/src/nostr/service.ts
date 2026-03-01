/**
 * Nostr 구독 오케스트레이터
 *
 * 1. Admin kind 30402 이벤트를 구독하고 order-store에 상태를 반영한다.
 * 2. 유저스크립트 kind 1111 이벤트를 구독하고 parsed-store에 반영한다.
 * 3. 파싱 주문이 verified 단계에 도달하면 계좌정보를 자동 전송한다.
 */
import { getReadRelays, getUserPubkey } from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeAdminOrders, subscribeUserscriptEvents } from './subscribe';
import { publishAccountInfo } from './publish';
import { parseAdminEvent, parseParsedOrderEvent } from '../types';
import { applyAdminUpdate, getSnapshot, setAccountInfo, markSynced } from '../order-store';
import { addParsedOrder } from '../parsed-store';

let cleanupAdmin: (() => void) | null = null;
let cleanupUserscript: (() => void) | null = null;

// ── Admin kind 30402 구독 ──────────────────────────

async function startAdminSubscription(): Promise<void> {
  if (cleanupAdmin) return;

  const [relays, myPubkey] = await Promise.all([
    getReadRelays(storage),
    getUserPubkey(storage),
  ]);

  cleanupAdmin = subscribeAdminOrders(relays, {
    onOrder: (event) => {
      const update = parseAdminEvent(event, myPubkey);
      if (!update) return;

      applyAdminUpdate(update.orderId, update.adminState, update.bolt11, update.sponsorPubkey);

      // 파싱 주문 verified 도달 시 계좌정보 자동 전송
      if (update.adminState === 'verified' && update.sponsorPubkey) {
        const order = getSnapshot()[update.orderId];
        if (order?.source === 'parsed' && order.fixedAccountInfo && !order.accountInfo) {
          void autoSendAccountInfo(order.orderId);
        }
      }
    },
    onEose: () => {
      markSynced();
      console.log('[Customer] Admin orders EOSE');
    },
  });
}

// ── 유저스크립트 kind 1111 구독 ────────────────────

async function startUserscriptSubscription(): Promise<void> {
  if (cleanupUserscript) return;

  const [relays, myPubkey] = await Promise.all([
    getReadRelays(storage),
    getUserPubkey(storage),
  ]);

  cleanupUserscript = subscribeUserscriptEvents(relays, myPubkey, {
    onEvent: (event) => {
      const payload = parseParsedOrderEvent(event);
      if (payload) {
        addParsedOrder(event.id, payload);
      }
    },
    onEose: () => {
      console.log('[Customer] Userscript events EOSE');
    },
  });
}

// ── 계좌정보 자동 전송 ────────────────────────────

async function autoSendAccountInfo(orderId: string): Promise<void> {
  const order = getSnapshot()[orderId];
  if (!order?.fixedAccountInfo || !order.sponsorPubkey) return;

  console.log('[Customer] Auto-sending account info for parsed order', orderId);

  try {
    const result = await publishAccountInfo(order, order.fixedAccountInfo);
    if (result.success) {
      setAccountInfo(orderId, order.fixedAccountInfo);
      console.log('[Customer] Account info auto-sent for', orderId);
    } else {
      console.warn('[Customer] Account info auto-send failed for', orderId, result.errors);
    }
  } catch (e) {
    console.error('[Customer] Account info auto-send error for', orderId, e);
  }
}

// ── 공개 API ───────────────────────────────────────

export async function startSubscriptions(): Promise<void> {
  await Promise.all([
    startAdminSubscription(),
    startUserscriptSubscription(),
  ]);
}

export function stopSubscriptions(): void {
  cleanupAdmin?.();
  cleanupAdmin = null;
  cleanupUserscript?.();
  cleanupUserscript = null;
}
