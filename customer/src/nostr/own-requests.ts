/**
 * 내가 보낸 라이트닝 요청으로 로컬 기록을 다시 채운다 — 키만 있으면 새 브라우저·다른 기기에서 거래가 살아난다
 *
 * 로컬에만 있던 것 중 거래에 필요한 건 **내가 보낸 요청 안에** 있다. 요청은 APP이나 상대에게 NIP-44로 암호화돼
 * 있지만 NIP-44 대화 키는 양쪽 공통이라 보낸 사람도 자기 키로 푼다. 나머지(공개 오더, 나에게 온 통지·채팅)는
 * 원래 구독이 다시 받는다.
 *
 * | 요청 | 되살리는 것 |
 * |---|---|
 * | `order-request` | 고객 의뢰 기록 — 이게 있어야 계좌 전달 버튼이 열린다 |
 * | `designated-order-request` | 같은 기록 + 지정 상대 (조건이 APP에게 암호화돼 있다) |
 * | `account-info` | 보낸 계좌 — 두 번 보내지 않게 |
 *
 * **이미 있는 기록은 덮지 않는다.** 원래 기기에서는 로컬이 진실이고, 여기는 비어 있을 때만 채운다.
 * 릴레이 보존(요청 7일) 안의 것만 온다 — 그보다 오래된 거래는 공개 오더·내역으로만 보인다.
 */
import type { Event } from 'nostr-tools/core';
import {
  APP_PUBKEY, REQUEST_ACTIONS, extractOrderId, isLnDesignatedOrderPayload, nip44Decrypt, parseAccountInfoEnvelope,
  type AccountInfo,
} from '@sajwo-tracker/shared';
import type { CustomerOrder } from '../buyer/types';
import { addOrder, getSnapshot as getLocalOrders, setAccountInfo } from '../buyer/order-store';
import { handleAdminOrder } from '../buyer/nostr/service';
import { getSnapshot as getPublicOrders } from '../sponsor/order-store';

/** 의뢰 기록보다 먼저 도착한 계좌 (같은 구독 안에서도 순서가 보장되지 않는다) */
const accountBeforeOrder = new Map<string, AccountInfo>();

const tag = (event: Event, name: string) => event.tags.find(t => t[0] === name)?.[1];

export function handleOwnLnRequest(event: Event, sk: Uint8Array, myPubkey: string): void {
  if (event.pubkey !== myPubkey) return;
  const orderId = extractOrderId(event.tags);
  if (!orderId) return;

  switch (tag(event, 'action')) {
    case REQUEST_ACTIONS.ORDER_REQUEST:
      restoreOrderRequest(event, orderId, myPubkey);
      return;
    case REQUEST_ACTIONS.DESIGNATED_ORDER_REQUEST:
      restoreDesignatedOrderRequest(event, orderId, sk, myPubkey);
      return;
    case REQUEST_ACTIONS.ACCOUNT_INFO:
      restoreSentAccount(event, orderId, sk);
      return;
  }
}

function restoreOrderRequest(event: Event, orderId: string, myPubkey: string): void {
  if (getLocalOrders()[orderId]) return;
  const price = Number(tag(event, 'price'));
  // `expiration`은 보존이다 — 기한으로 읽지 않는다(DM-009, 데몬과 같다)
  const deadline = Number(tag(event, 'deadline'));
  if (!Number.isInteger(price) || price <= 0 || !Number.isInteger(deadline)) return;
  restore({ orderId, price, memo: '', createdAt: event.created_at, expiration: deadline, raw: JSON.stringify(event) }, myPubkey);
}

/** 지정 거래 의뢰 — 조건이 APP에게 암호화돼 있다. 보낸 사람(나)도 같은 대화 키로 푼다 */
function restoreDesignatedOrderRequest(event: Event, orderId: string, sk: Uint8Array, myPubkey: string): void {
  if (getLocalOrders()[orderId]) return;
  let payload: unknown;
  try {
    payload = JSON.parse(nip44Decrypt(event.content, sk, APP_PUBKEY));
  } catch {
    return;
  }
  if (!isLnDesignatedOrderPayload(payload)) return;
  restore({
    orderId, price: payload.price, memo: '', createdAt: event.created_at, expiration: payload.deadline,
    raw: JSON.stringify(event), designatedSponsor: payload.designatedSponsor,
  }, myPubkey);
}

function restore(order: CustomerOrder, myPubkey: string): void {
  const { orderId } = order;
  addOrder(order);

  // 공개 오더가 먼저 와 있었으면 그 상태를 지금 입힌다 — 기다리면 다음 발행까지 상태가 빈다
  const published = getPublicOrders()[orderId];
  if (published?.raw) handleAdminOrder(published.raw as Event, myPubkey);

  const account = accountBeforeOrder.get(orderId);
  if (account) {
    accountBeforeOrder.delete(orderId);
    setAccountInfo(orderId, account);
  }
}

function restoreSentAccount(event: Event, orderId: string, sk: Uint8Array): void {
  // 계좌는 후원자에게 암호화된다 — 받는 쪽(p 중 APP이 아닌 것)과의 대화 키로 푼다
  const sponsor = event.tags.find(t => t[0] === 'p' && t[1] !== APP_PUBKEY)?.[1];
  if (!sponsor) return;
  let accountInfo: AccountInfo | undefined;
  try {
    accountInfo = parseAccountInfoEnvelope(nip44Decrypt(event.content, sk, sponsor))?.accountInfo;
  } catch {
    return;
  }
  if (!accountInfo) return;

  const local = getLocalOrders()[orderId];
  if (!local) {
    accountBeforeOrder.set(orderId, accountInfo);
    return;
  }
  if (!local.accountInfo) setAccountInfo(orderId, accountInfo);
}
