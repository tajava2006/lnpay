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
  APP_PUBKEY,
  SAJWO_REQUEST_KIND,
  REQUEST_ACTIONS,
  idbHasOrder,
  idbUpsertOrder,
  idbUpsertRequest,
  idbUpsertMessage,
  type AccountInfo,
  type AccountInfoRequest,
  type ChatMessage,
  type DisputeMessagePayload,
} from '@sajwo-tracker/shared';
import type { Event } from 'nostr-tools/core';
import { storage } from './storage';
import { subscribeSajwoRequests, subscribeRequests } from './subscribe';
import { parseEvent, parseAccountInfoEvent } from '../types';
import { upsertOrder, markSynced } from '../order-store';
import { setAccountInfo } from '../account-store';
import { setClaimError } from '../claim-error-store';
import type { AccountInfoEvent } from '../types';

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

  // kind 1111 구독 (account-info + dispute-message 수신)
  const myPubkey = await getUserPubkey(storage);
  cleanupReqs = subscribeRequests(relays, myPubkey, {
    onRequest: (event) => {
      const parsed = parseAccountInfoEvent(event);
      if (parsed) {
        void handleAccountInfo(parsed);
        return;
      }
      const action = event.tags.find(t => t[0] === 'action')?.[1];
      // claim-price-error: 가격 에러 알림
      if (action === REQUEST_ACTIONS.CLAIM_PRICE_ERROR) {
        handleClaimPriceError(event as Event);
        return;
      }
      // dispute-message 백그라운드 IDB 자동 저장
      if (action === REQUEST_ACTIONS.DISPUTE_MESSAGE) {
        void handleDisputeMessage(event as Event);
      }
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
  const request: AccountInfoRequest = {
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

// ── claim-price-error 처리 ────────────────────────────

function handleClaimPriceError(event: Event): void {
  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return;
  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return;
  const orderId = parts[2]!;

  const expectedSats = Number(event.tags.find(t => t[0] === 'expected-sats')?.[1]);
  if (!expectedSats || expectedSats <= 0) return;

  setClaimError(orderId, expectedSats);
  console.log('[Sponsor] Claim price error for', orderId, '- expected:', expectedSats, 'sats');
}

// ── dispute-message 백그라운드 IDB 저장 ──────────────

/**
 * dispute-message 수신 시 NIP-44 복호화 후 IDB에 자동 저장한다.
 * 디테일 페이지 미진입 상태에서도 분쟁 메시지를 영구 보존하기 위함.
 */
async function handleDisputeMessage(event: Event): Promise<void> {
  const aTag = event.tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return;
  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(SAJWO_REQUEST_KIND)) return;
  const orderId = parts[2]!;

  // 클레임한 건만 저장
  if (!await idbHasOrder(orderId)) return;

  const recipientPubkey = event.tags.find(t => t[0] === 'p' && t[1] !== event.pubkey)?.[1];
  if (!recipientPubkey) return;

  const sk = await getSecretKey(storage);
  let plaintext: string;
  try {
    plaintext = nip44Decrypt(event.content, sk, APP_PUBKEY);
  } catch {
    return;
  }

  let payload: DisputeMessagePayload;
  try {
    payload = JSON.parse(plaintext) as DisputeMessagePayload;
  } catch {
    return;
  }

  const msg: ChatMessage = {
    eventId: event.id,
    orderId,
    senderPubkey: event.pubkey,
    recipientPubkey,
    payload,
    createdAt: event.created_at,
  };

  void idbUpsertMessage(msg).catch(err => {
    console.warn('[Sponsor] IDB message auto-save failed for', msg.eventId, err);
  });
}
