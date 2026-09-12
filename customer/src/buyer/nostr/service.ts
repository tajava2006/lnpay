/**
 * 고객 역할 이벤트 핸들러
 *
 * 구독 소켓은 갖지 않는다 — 통합 구독(../../nostr/service)이 소켓을 소유하고
 * 이벤트를 역할별 핸들러로 흘려보낸다. 여기는 "고객으로서 이 이벤트를 어떻게
 * 소화할 것인가"만 담당한다.
 *
 * 1. Admin kind 30402 → order-store 상태 반영 + IDB 아카이브
 * 2. kind 1111 → parsed-store / 보증금 / 분쟁 채팅
 * 3. 파싱 주문이 escrowed에 도달하면 계좌정보 자동 전송
 */
import {
  nip44Decrypt,
  APP_PUBKEY,
  REQUEST_ACTIONS,
  extractOrderId,
  processDisputeEvent,
  idbUpsertOrder,
} from '@sajwo-tracker/shared';
import type { Event } from 'nostr-tools/core';
import { publishAccountInfo, publishNotification } from './publish';
import { parseAdminEvent, parseParsedOrderEvent, parseCoupangStatusEvent } from '../types';
import { parseEvent as parseOrderEvent } from '../../sponsor/types';
import { applyAdminUpdate, applyDepositRequired, applyDepositStatus, getSnapshot, setAccountInfo, markSynced } from '../order-store';
import { addParsedOrder } from '../parsed-store';


// ── Admin kind 30402 ───────────────────────────────

/**
 * 내가 고객으로 올린 주문이면 상태를 반영하고 IDB에 아카이브한다.
 * 내 주문이 아니면 아무것도 하지 않는다(오더북 몫은 후원자 역할이 가져간다).
 */
export function handleAdminOrder(event: Event, myPubkey: string): void {
  const update = parseAdminEvent(event, myPubkey);
  if (!update) return;

  applyAdminUpdate(update.orderId, update.adminState, update.bolt11, update.sponsorPubkey);

  // 릴레이는 만료 시 오더를 지운다. 내가 관여한 거래의 영구 기록은 IDB뿐이다.
  void archiveOrder(event);

  // 파싱 주문 escrowed 도달 시 계좌정보 자동 전송
  if (update.adminState === 'escrowed' && update.sponsorPubkey) {
    const order = getSnapshot()[update.orderId];
    if (order?.source === 'parsed' && order.fixedAccountInfo && !order.accountInfo) {
      void autoSendAccountInfo(order.orderId);
    }
  }
}

export function handleOrdersEose(): void {
  markSynced();
  console.log('[고객] 오더 초기 동기화 완료');
}

// ── kind 1111 ──────────────────────────────────────

/**
 * 고객 역할로 소화할 수 있는 이벤트면 처리하고 true를 돌려준다.
 * false면 통합 구독이 후원자 역할 핸들러로 넘긴다.
 */
export function handleInboxEvent(event: Event, sk: Uint8Array): boolean {
  const action = event.tags.find(t => t[0] === 'action')?.[1];

  // dispute-message 백그라운드 IDB 자동 저장.
  // 역할과 무관한 공통 처리라 여기서 한 번만 한다 — 후원자 핸들러는 손대지 않는다.
  if (action === REQUEST_ACTIONS.DISPUTE_MESSAGE) {
    void handleDisputeMessage(event, sk);
    return true;
  }

  // 보증금 알림은 어드민이 고객에게도 후원자에게도 같은 모양으로 보낸다.
  // 이벤트만 봐서는 어느 역할인지 알 수 없으므로 로컬 주문 존재 여부로 가른다 —
  // 고객 주문은 '사줘' 발행 전부터 order-store에 있으므로 판별이 가능하다.
  if (isDepositAction(action) && event.pubkey === APP_PUBKEY) {
    const orderId = extractOrderId(event.tags);
    if (!orderId || !getSnapshot()[orderId]) return false; // 내 고객 주문이 아님 → 후원자 역할로

    if (action === REQUEST_ACTIONS.DEPOSIT_REQUIRED) {
      const bolt11 = event.tags.find(t => t[0] === 'bolt11')?.[1];
      if (bolt11) {
        applyDepositRequired(orderId, bolt11);
        console.log('[고객] 보증금 요구:', orderId);
      }
      return true;
    }
    if (action === REQUEST_ACTIONS.DEPOSIT_ACCEPTED) { applyDepositStatus(orderId, 'accepted'); return true; }
    if (action === REQUEST_ACTIONS.DEPOSIT_CANCELLED) { applyDepositStatus(orderId, 'cancelled'); return true; }
    if (action === REQUEST_ACTIONS.DEPOSIT_SETTLED) { applyDepositStatus(orderId, 'settled'); return true; }
  }

  // 유저스크립트가 감지한 쿠팡 입금/취소. 유저스크립트는 sajwo orderId를 모르므로
  // 쿠팡 번호만 보내고, 여기서 로컬 주문을 찾아 진짜 요청을 어드민에 발행한다.
  const coupangStatus = parseCoupangStatusEvent(event, sk);
  if (coupangStatus) {
    void relayCoupangStatus(coupangStatus.coupangOrderId, coupangStatus.status);
    return true;
  }

  // 유저스크립트가 보낸 파싱 주문 (자기 자신에게 NIP-44 자기암호화)
  const payload = parseParsedOrderEvent(event, sk);
  if (payload) {
    addParsedOrder(event.id, payload);
    return true;
  }

  return false;
}

function isDepositAction(action: string | undefined): boolean {
  return action === REQUEST_ACTIONS.DEPOSIT_REQUIRED
    || action === REQUEST_ACTIONS.DEPOSIT_ACCEPTED
    || action === REQUEST_ACTIONS.DEPOSIT_CANCELLED
    || action === REQUEST_ACTIONS.DEPOSIT_SETTLED;
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

// ── dispute-message 백그라운드 IDB 저장 ──────────────

async function handleDisputeMessage(event: Event, sk: Uint8Array): Promise<void> {
  const orderId = extractOrderId(event.tags);
  if (!orderId) return;
  await processDisputeEvent(event, orderId, (content) => nip44Decrypt(content, sk, APP_PUBKEY));
}

// ── IDB 아카이브 ───────────────────────────────────

/**
 * 내가 고객으로 관여한 주문을 IDB에 영구 보존한다.
 *
 * 원래 설계(STORAGE-STRATEGY §6)는 "Customer/Sponsor는 IDB 불필요, 필요하면
 * 릴레이에서 재조회"였는데, 같은 문서가 모든 오더 이벤트에 만료 태그를 붙이기로
 * 정해서 만료가 지나면 릴레이에 아무것도 남지 않는다. 후원자 쪽은 이미 클레임
 * 시점에 IDB로 옮기고 있었고(대칭), 고객 쪽만 빠져 있었다.
 *
 * 이게 있어야 localStorage를 만료 기준으로 지울 수 있다 — 지워도 기록이 남으니까.
 */
async function archiveOrder(event: Event): Promise<void> {
  const order = parseOrderEvent(event);
  if (!order) return;
  try {
    await idbUpsertOrder(order);
  } catch (err) {
    console.warn('[고객] IDB 아카이브 실패:', order.orderId, err);
  }
}

// ── 쿠팡 상태 → 어드민 요청 중계 ─────────────────────

/**
 * 유저스크립트가 알려준 쿠팡 상태 변화를 어드민 요청으로 옮긴다.
 *
 * 유저스크립트는 쿠팡 페이지에서 돌기 때문에 웹앱이 만든 랜덤 orderId를 알 수 없다.
 * 그래서 쿠팡 번호만 보내고, 매핑은 로컬 주문(coupangOrderId 필드)이 쥐고 있다.
 */
async function relayCoupangStatus(
  coupangOrderId: string,
  status: 'paid' | 'cancelled',
): Promise<void> {
  const order = Object.values(getSnapshot()).find(o => o.coupangOrderId === coupangOrderId);
  if (!order) {
    console.warn('[고객] 쿠팡 상태 알림을 받았지만 해당 주문이 없음:', coupangOrderId);
    return;
  }
  // 아직 어드민에 등록되지 않은 주문은 보낼 곳이 없다.
  if (!order.adminState) return;

  const action = status === 'paid' ? REQUEST_ACTIONS.PAYMENT_CONFIRM : REQUEST_ACTIONS.CANCEL_REQUEST;
  const result = await publishNotification(order, action);
  console.log(
    result.success ? '[고객] 쿠팡 상태 중계 완료:' : '[고객] 쿠팡 상태 중계 실패:',
    action, order.orderId,
  );
}
