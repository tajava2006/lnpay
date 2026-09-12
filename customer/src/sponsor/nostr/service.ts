/**
 * 후원자 역할 이벤트 핸들러
 *
 * 구독 소켓은 갖지 않는다 — 통합 구독(../../nostr/service)이 소켓을 소유하고
 * 이벤트를 역할별 핸들러로 흘려보낸다.
 *
 * 1. Admin kind 30402 → 오더북(order-store) + 내가 클레임한 건 IDB 아카이브
 * 2. kind 1111 → 계좌정보(NIP-44 복호화) / 보증금 / 가격 오류
 */
import {
  nip44Decrypt,
  APP_PUBKEY,
  REQUEST_ACTIONS,
  idbHasOrder,
  idbUpsertOrder,
  idbUpsertRequest,
  extractOrderId,
  getSecretKey,
  storage,
  type AccountInfo,
  type AccountInfoRequest,
} from '@sajwo-tracker/shared';
import type { Event } from 'nostr-tools/core';
import { parseEvent, parseAccountInfoEvent } from '../types';
import { upsertOrder, markSynced } from '../order-store';
import { setAccountInfo } from '../account-store';
import { setClaimError } from '../claim-error-store';
import { setDepositBolt11, setDepositStatus } from '../deposit-store';
import type { AccountInfoEvent } from '../types';

// ── Admin kind 30402 ───────────────────────────────

/** 오더북에 반영하고, 내가 클레임한 건이면 IDB 아카이브도 갱신한다. */
export function handleAdminOrder(event: Event): void {
  const parsed = parseEvent(event);
  if (!parsed) return;

  upsertOrder(parsed);
  void syncOrderToIdb(parsed);
}

export function handleOrdersEose(): void {
  markSynced();
  console.log('[후원자] 오더북 초기 동기화 완료');
}

// ── kind 1111 ──────────────────────────────────────

/** 후원자 역할로 소화할 수 있는 이벤트면 처리하고 true를 돌려준다. */
export function handleInboxEvent(event: Event): boolean {
  const parsedAccount = parseAccountInfoEvent(event);
  if (parsedAccount) {
    void handleAccountInfo(parsedAccount);
    return true;
  }

  const action = event.tags.find(t => t[0] === 'action')?.[1];

  if (action === REQUEST_ACTIONS.DEPOSIT_REQUIRED && event.pubkey === APP_PUBKEY) {
    const orderId = extractOrderId(event.tags);
    const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
    if (orderId && bolt11) {
      setDepositBolt11(orderId, bolt11);
      console.log('[후원자] 보증금 요구:', orderId);
    }
    return true;
  }
  if (action === REQUEST_ACTIONS.DEPOSIT_ACCEPTED && event.pubkey === APP_PUBKEY) {
    const orderId = extractOrderId(event.tags);
    if (orderId) setDepositStatus(orderId, 'accepted');
    return true;
  }
  if (action === REQUEST_ACTIONS.DEPOSIT_CANCELLED && event.pubkey === APP_PUBKEY) {
    const orderId = extractOrderId(event.tags);
    if (orderId) setDepositStatus(orderId, 'cancelled');
    return true;
  }
  if (action === REQUEST_ACTIONS.DEPOSIT_SETTLED && event.pubkey === APP_PUBKEY) {
    const orderId = extractOrderId(event.tags);
    if (orderId) setDepositStatus(orderId, 'settled');
    return true;
  }

  if (action === REQUEST_ACTIONS.CLAIM_PRICE_ERROR) {
    handleClaimPriceError(event);
    return true;
  }

  return false;
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
  const orderId = extractOrderId(event.tags);
  if (!orderId) return;

  const expectedSats = Number(event.tags.find(t => t[0] === 'expected-sats')?.[1]);
  if (!expectedSats || expectedSats <= 0) return;

  setClaimError(orderId, expectedSats);
  console.log('[Sponsor] Claim price error for', orderId, '- expected:', expectedSats, 'sats');
}

