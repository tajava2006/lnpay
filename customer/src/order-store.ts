/**
 * 반응형 주문 스토어
 *
 * Customer가 수동 생성한 주문을 관리하고,
 * Admin kind 30402 이벤트로 수신한 상태를 오버레이한다.
 *
 * 구조:
 *   OrderForm → addOrder → localStorage + listeners
 *   Nostr 구독 → applyAdminUpdate → localStorage + listeners
 *   Dashboard → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 */
import type { CustomerOrder } from './types';
import type { OrderState, AccountInfo } from '@sajwo-tracker/shared';

type OrderMap = Record<string, CustomerOrder>;
type Listener = () => void;

const ORDERS_KEY = 'customer:orders';

// ── 내부 상태 ──────────────────────────────────────

let orders: OrderMap = loadFromStorage();
let synced = false;
const listeners = new Set<Listener>();

// ── localStorage 입출력 ────────────────────────────

function loadFromStorage(): OrderMap {
  const stored = localStorage.getItem(ORDERS_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as OrderMap;
  } catch {
    return {};
  }
}

function saveToStorage(): void {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

// ── 리스너 통지 ────────────────────────────────────

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): OrderMap {
  return orders;
}

export function getSyncedSnapshot(): boolean {
  return synced;
}

// ── 뮤테이션 API ───────────────────────────────────

/** 새 주문을 추가한다 (수동 입력 폼에서 호출). */
export function addOrder(order: CustomerOrder): void {
  if (orders[order.orderId]) return;
  orders = { ...orders, [order.orderId]: order };
  saveToStorage();
  notify();
}

/** 사줘 요청 발행 성공 시 raw 필드를 저장한다. */
export function markPublished(orderId: string, raw: string): void {
  const existing = orders[orderId];
  if (!existing) return;
  orders = { ...orders, [orderId]: { ...existing, raw } };
  saveToStorage();
  notify();
}

/**
 * Admin 오더 상태를 오버레이한다.
 * adminState/bolt11/sponsorPubkey가 변경된 경우에만 갱신.
 */
export function applyAdminUpdate(
  orderId: string,
  adminState: OrderState,
  bolt11?: string,
  sponsorPubkey?: string,
): void {
  const existing = orders[orderId];
  if (!existing) return;

  const stateChanged = existing.adminState !== adminState;
  const bolt11Changed = bolt11 != null && existing.bolt11 !== bolt11;
  const sponsorChanged = sponsorPubkey != null && existing.sponsorPubkey !== sponsorPubkey;
  if (!stateChanged && !bolt11Changed && !sponsorChanged) return;

  orders = {
    ...orders,
    [orderId]: {
      ...existing,
      adminState,
      ...(bolt11 != null ? { bolt11 } : {}),
      ...(sponsorPubkey != null ? { sponsorPubkey } : {}),
    },
  };
  saveToStorage();
  notify();
}

/** 보증금 인보이스를 주문에 저장한다 (deposit-required 알림 수신 시). */
export function applyDepositRequired(orderId: string, depositBolt11: string): void {
  const existing = orders[orderId];
  if (!existing) return;
  if (existing.depositBolt11 === depositBolt11) return;
  orders = { ...orders, [orderId]: { ...existing, depositBolt11 } };
  saveToStorage();
  notify();
}

/** 계좌정보 전달 완료 시 로컬 저장 */
export function setAccountInfo(orderId: string, accountInfo: AccountInfo): void {
  const existing = orders[orderId];
  if (!existing) return;
  orders = { ...orders, [orderId]: { ...existing, accountInfo } };
  saveToStorage();
  notify();
}

/** 주문을 삭제한다. */
export function deleteOrder(orderId: string): void {
  if (!orders[orderId]) return;
  const { [orderId]: _, ...rest } = orders;
  orders = rest;
  saveToStorage();
  notify();
}

/** 삭제 가능한 주문을 모두 삭제한다. 거래 중인 건이 있으면 false 반환. */
export function clearDeletableOrders(canDelete: (o: CustomerOrder) => boolean): boolean {
  const allDeletable = Object.values(orders).every(canDelete);
  if (!allDeletable) return false;
  orders = {};
  saveToStorage();
  notify();
  return true;
}

export function markSynced(): void {
  synced = true;
  notify();
}
