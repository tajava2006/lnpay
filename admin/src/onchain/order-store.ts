/**
 * 온체인 오더 스토어 (PLAN-ONCHAIN-TRACK §1.1)
 *
 * 라이트닝 스토어(`../order-store.ts`)와 **완전히 별도**다. 상태 집합이 다르고,
 * 한 스토어에 섞으면 모든 읽기가 `if (track === 'onchain')`로 갈라진다.
 * 저장 키도 다르므로 **라이트닝 트랙을 건드리지 않고 붙였다 뗐다 할 수 있다**(§1.2).
 *
 * 헌법 그대로: 서비스가 릴레이를 구독해 여기에 반영하고, UI는 여기만 구독한다.
 */
import {
  canOnchainTransition, isOnchainTerminal,
  type OnchainOrder, type OnchainState,
} from '@sajwo-tracker/shared/onchain';

type OrderMap = Record<string, OnchainOrder>;
type Listener = () => void;

const STORE_KEY = 'admin:onchain-orders';

let orders: OrderMap = loadFromStorage();
const listeners = new Set<Listener>();

function loadFromStorage(): OrderMap {
  const stored = localStorage.getItem(STORE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as OrderMap;
  } catch {
    return {};
  }
}

function saveToStorage(): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(orders));
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): OrderMap {
  return orders;
}

export function getOnchainOrder(orderId: string): OnchainOrder | undefined {
  return orders[orderId];
}

/** 릴레이 에코·로컬 갱신 공용. 최신 것만 남긴다 */
export function upsertOnchainOrder(order: OnchainOrder): void {
  const existing = orders[order.orderId];
  if (existing && existing.updatedAt > order.updatedAt) return;

  orders = { ...orders, [order.orderId]: order };
  saveToStorage();
  notify();
}

export interface OnchainPatch extends Partial<Omit<OnchainOrder, 'orderId' | 'state'>> {
  state?: OnchainState;
}

/**
 * 상태 전이 + 필드 갱신을 **한 번에** 한다.
 *
 * 둘을 갈라 두면 "전이는 됐는데 그 상태가 요구하는 값이 아직 안 들어간" 순간이
 * 생기고, 그 사이에 발행이 나가면 **태그가 빠진 채로 덮어쓴다**(kind 30402는
 * addressable이라 복구 불가 — 라이트닝에서 주문 두 건을 그렇게 잃었다).
 *
 * 전이가 규칙에 안 맞으면 **아무것도 바꾸지 않는다.**
 */
export function applyOnchainTransition(
  orderId: string,
  patch: OnchainPatch,
): { success: true; order: OnchainOrder } | { success: false; error: string } {
  const order = orders[orderId];
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  const to = patch.state ?? order.state;
  if (to !== order.state && !canOnchainTransition(order.state, to)) {
    return { success: false, error: `INVALID_TRANSITION: ${order.state} → ${to}` };
  }

  const updated: OnchainOrder = {
    ...order,
    ...patch,
    state: to,
    status: isOnchainTerminal(to) ? 'sold' : 'active',
    // 같은 초에 두 번 갱신되면 릴레이·스토어가 나중 것을 버린다. 항상 앞으로 간다.
    updatedAt: Math.max(Math.floor(Date.now() / 1000), order.updatedAt + 1),
  };

  orders = { ...orders, [orderId]: updated };
  saveToStorage();
  notify();
  return { success: true, order: updated };
}

/** @testing-only */
export function _resetForTesting(): void {
  orders = {};
  localStorage.removeItem(STORE_KEY);
}
