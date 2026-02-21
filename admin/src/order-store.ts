/**
 * 오더 스토어 (Admin이 유일한 상태 소유자)
 *
 * Nostr 서비스 → order-store → localStorage + listeners
 * UI → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 */
import type { Order, OrderState } from '@sajwo-tracker/shared';
import { canTransition } from './state-machine';

type OrderMap = Record<string, Order>;
type Listener = () => void;

const ORDERS_KEY = 'admin:orders';

let orders: OrderMap = loadFromStorage();
const listeners = new Set<Listener>();

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

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): OrderMap {
  return orders;
}

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
 * 오더의 FSM 상태를 전이한다.
 * canTransition 검증 후 상태 변경 + 저장.
 */
export function updateOrderState(
  orderId: string,
  to: OrderState,
): { success: boolean; error?: string } {
  const order = orders[orderId];
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (!canTransition(order.state, to)) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → ${to}` };
  }

  const now = Math.floor(Date.now() / 1000);
  const TERMINAL_STATES: ReadonlySet<OrderState> = new Set([
    'paid', 'cancelled', 'sponsor_wins', 'customer_wins',
  ]);
  const status = TERMINAL_STATES.has(to) ? 'sold' as const : 'active' as const;

  orders = {
    ...orders,
    [orderId]: { ...order, state: to, status, updatedAt: now },
  };
  saveToStorage();
  notify();

  return { success: true };
}

/**
 * orderId로 오더를 조회한다.
 */
export function getOrder(orderId: string): Order | undefined {
  return orders[orderId];
}

/**
 * 만료된 오더를 삭제하고, 삭제된 orderId 목록을 반환한다.
 * request-store 연쇄 삭제에 사용.
 */
export function purgeExpired(): string[] {
  const now = Math.floor(Date.now() / 1000);
  const expiredIds: string[] = [];

  for (const [id, order] of Object.entries(orders)) {
    if (order.expiration > 0 && order.expiration <= now) {
      expiredIds.push(id);
    }
  }

  if (expiredIds.length === 0) return [];

  const idSet = new Set(expiredIds);
  orders = Object.fromEntries(
    Object.entries(orders).filter(([id]) => !idSet.has(id)),
  );
  saveToStorage();
  notify();
  return expiredIds;
}
