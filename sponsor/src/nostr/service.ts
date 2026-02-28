/**
 * Nostr 구독 서비스
 *
 * Admin 발행 오더를 실시간 구독하고,
 * 수신한 이벤트를 order-store에 반영한다.
 *
 * kind 1111 구독으로 Customer → Sponsor account-info를 수신하여
 * NIP-44 복호화 후 IDB + 반응형 스토어에 반영한다.
 */
import {
  getReadRelays,
  getUserPubkey,
  getSecretKey,
  nip44Decrypt,
  type AccountInfo,
} from '@sajwo-tracker/shared';
import { storage } from './storage';
import { subscribeSajwoRequests, subscribeRequests } from './subscribe';
import { parseEvent, parseAccountInfoEvent } from '../types';
import { upsertOrder, markSynced } from '../order-store';
import { idbHasOrder, idbUpsertOrder, idbUpsertRequest } from '../idb-store';
import { setAccountInfo } from '../account-store';
import type { AccountInfoEvent, SponsorRequest } from '../types';

let cleanupOrders: (() => void) | null = null;
let cleanupReqs: (() => void) | null = null;

export async function startOrderSubscription(): Promise<void> {
  if (cleanupOrders) return;

  const relays = await getReadRelays(storage);

  // kind 30402 구독 (기존)
  cleanupOrders = subscribeSajwoRequests(relays, {
    onOrder: (event) => {
      const parsed = parseEvent(event);
      if (!parsed) return;

      upsertOrder(parsed);

      // IDB 동기화 (클레임한 건만)
      void syncOrderToIdb(parsed);
    },
    onEose: () => {
      markSynced();
    },
  });

  // kind 1111 구독 (account-info 수신)
  const myPubkey = await getUserPubkey(storage);
  cleanupReqs = subscribeRequests(relays, myPubkey, {
    onRequest: (event) => {
      const parsed = parseAccountInfoEvent(event);
      if (parsed) void handleAccountInfo(parsed);
    },
    onEose: () => {
      console.log('[Sponsor] Request subscription EOSE');
    },
  });
}

export function stopOrderSubscription(): void {
  cleanupOrders?.();
  cleanupOrders = null;
  cleanupReqs?.();
  cleanupReqs = null;
}

// ── IDB 동기화 (fire-and-forget) ─────────────────────

async function syncOrderToIdb(order: Parameters<typeof idbUpsertOrder>[0]): Promise<void> {
  try {
    const exists = await idbHasOrder(order.orderId);
    if (exists) await idbUpsertOrder(order);
  } catch (err) {
    console.warn('[Sponsor] IDB order sync failed for', order.orderId, err);
  }
}

// ── account-info 처리 ────────────────────────────────

async function handleAccountInfo(event: AccountInfoEvent): Promise<void> {
  const sk = await getSecretKey(storage);
  let info: AccountInfo;
  try {
    const plaintext = nip44Decrypt(event.encryptedContent, sk, event.customerPubkey);
    info = JSON.parse(plaintext) as AccountInfo;
  } catch (e) {
    console.error('[Sponsor] account-info 복호화 실패:', event.orderId, e);
    return;
  }

  // 반응형 스토어에 반영 (UI 즉시 갱신)
  setAccountInfo(event.orderId, info);

  // IDB에 request로 저장 (영구 보존)
  const request: SponsorRequest = {
    eventId: event.eventId,
    orderId: event.orderId,
    action: 'account-info',
    pubkey: event.customerPubkey,
    createdAt: event.createdAt,
    expiration: event.expiration,
    accountInfo: info,
    raw: {},
  };

  try {
    await idbUpsertRequest(request);
  } catch (err) {
    console.warn('[Sponsor] IDB account-info save failed for', event.orderId, err);
  }
}
