import { STORAGE_KEYS } from './nostr/constants';
import type { SajwoRequest } from './types';

type OrderMap = Record<string, SajwoRequest>;

function loadOrders(): OrderMap {
  const stored = localStorage.getItem(STORAGE_KEYS.ORDERS);
  if (!stored) return {};

  try {
    return JSON.parse(stored) as OrderMap;
  } catch {
    return {};
  }
}

function saveOrders(orders: OrderMap): void {
  localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(orders));
}

/** 저장된 모든 주문을 반환한다. */
export function getAllOrders(): OrderMap {
  return loadOrders();
}

/**
 * 주문을 저장/업데이트한다.
 * 같은 orderId의 기존 이벤트보다 최신(createdAt이 큰)일 때만 업데이트한다.
 * 반환: 실제로 업데이트가 발생했는지 여부
 */
export function upsertOrder(request: SajwoRequest): boolean {
  const orders = loadOrders();
  const existing = orders[request.orderId];

  if (existing && existing.createdAt >= request.createdAt) {
    return false;
  }

  orders[request.orderId] = request;
  saveOrders(orders);
  return true;
}

/** 주문을 삭제한다. 반환: 실제로 삭제가 발생했는지 여부 */
export function deleteOrder(orderId: string): boolean {
  const orders = loadOrders();
  if (!(orderId in orders)) return false;

  delete orders[orderId];
  saveOrders(orders);
  return true;
}
