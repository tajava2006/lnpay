/**
 * 주문 참조 스토어 (읽기 전용 참조 데이터)
 *
 * kind 30402 이벤트를 저장하여 클레임의 주문 정보(금액, 만료일 등)를 표시하기 위한 용도.
 * 클레임 스토어와 교차 참조된다.
 */
import type { OrderRef } from './types';

type OrderMap = Record<string, OrderRef>;
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
 * 주문을 추가/갱신한다. 최신 이벤트만 유지.
 */
export function upsertOrder(order: OrderRef): void {
  const existing = orders[order.orderId];
  if (existing && existing.createdAt >= order.createdAt) return;

  orders = { ...orders, [order.orderId]: order };
  saveToStorage();
  notify();
}

/**
 * 주문을 삭제한다 (sold 이벤트 수신 시).
 */
export function deleteOrder(orderId: string): void {
  if (!orders[orderId]) return;

  const { [orderId]: _, ...rest } = orders;
  orders = rest;
  saveToStorage();
  notify();
}
