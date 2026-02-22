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
import type { OrderState } from '@sajwo-tracker/shared';

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
 * adminState/bolt11이 변경된 경우에만 갱신.
 */
export function applyAdminUpdate(orderId: string, adminState: OrderState, bolt11?: string): void {
  const existing = orders[orderId];
  if (!existing) return;

  const stateChanged = existing.adminState !== adminState;
  const bolt11Changed = bolt11 != null && existing.bolt11 !== bolt11;
  if (!stateChanged && !bolt11Changed) return;

  orders = {
    ...orders,
    [orderId]: {
      ...existing,
      adminState,
      ...(bolt11 != null ? { bolt11 } : {}),
    },
  };
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

// ── 만료 삭제 ─────────────────────────────────────

const CLEANUP_INTERVAL = 60_000; // 60초
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 만료된 주문을 삭제한다. 상태 무관 — expiration 기준으로만 판단.
 */
function purgeExpired(): void {
  const now = Math.floor(Date.now() / 1000);
  const before = Object.keys(orders).length;

  orders = Object.fromEntries(
    Object.entries(orders).filter(([, o]) =>
      o.expiration === 0 || o.expiration > now,
    ),
  );

  if (Object.keys(orders).length === before) return;

  saveToStorage();
  notify();
}

export function startCleanup(): void {
  if (cleanupTimer) return;
  purgeExpired(); // 즉시 1회 실행
  cleanupTimer = setInterval(purgeExpired, CLEANUP_INTERVAL);
}

export function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
