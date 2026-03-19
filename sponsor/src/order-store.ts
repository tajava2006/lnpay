/**
 * 반응형 주문 스토어 (읽기 전용)
 *
 * Admin이 발행한 kind 30402 오더를 저장한다.
 * Sponsor는 상태를 직접 변경하지 않으며, 릴레이에서 수신한 이벤트로만 갱신된다.
 *
 * 구조:
 *   Nostr 구독 서비스 → order-store (upsert) → localStorage + listeners
 *   OrderBook → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 */
import type { Order } from '@sajwo-tracker/shared';

type OrderMap = Record<string, Order>;
type Listener = () => void;

const ORDERS_KEY = 'sponsor:orders';

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

// ── 뮤테이션 API (Nostr 서비스에서 호출) ───────────

/**
 * 오더를 추가/갱신한다. 최신 이벤트만 유지 (updatedAt 비교).
 */
export function upsertOrder(order: Order): void {
  const existing = orders[order.orderId];
  if (existing && existing.updatedAt >= order.updatedAt) return;

  orders = { ...orders, [order.orderId]: order };
  saveToStorage();
  notify();
}

/**
 * 오더를 삭제한다 (sold 이벤트 수신 시).
 */
export function deleteOrder(orderId: string): void {
  if (!orders[orderId]) return;

  const { [orderId]: _, ...rest } = orders;
  orders = rest;
  saveToStorage();
  notify();
}

export function markSynced(): void {
  synced = true;
  notify();
}

// ── 만료 삭제 ─────────────────────────────────────

const CLEANUP_INTERVAL = 60_000; // 60초
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 만료된 오더를 삭제한다. 상태 무관 — expiration 기준으로만 판단.
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
