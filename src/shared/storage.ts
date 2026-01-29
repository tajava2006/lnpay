import type { StorageData, TrackedOrder } from './types';

const STORAGE_KEY = 'orders';

// 모든 주문 조회
export async function getAllOrders(): Promise<Record<string, TrackedOrder>> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? {};
}

// 특정 주문 조회
export async function getOrder(orderId: string): Promise<TrackedOrder | null> {
  const orders = await getAllOrders();
  return orders[orderId] ?? null;
}

// 주문 저장 (신규 또는 업데이트)
export async function saveOrder(order: TrackedOrder): Promise<void> {
  const orders = await getAllOrders();
  orders[order.orderId] = order;
  await chrome.storage.local.set({ [STORAGE_KEY]: orders });
}

// 주문 상태 업데이트
export async function updateOrderStatus(
  orderId: string,
  status: TrackedOrder['status']
): Promise<void> {
  const orders = await getAllOrders();
  const order = orders[orderId];
  if (order) {
    order.status = status;
    order.updatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: orders });
  }
}

// 주문 삭제
export async function deleteOrder(orderId: string): Promise<void> {
  const orders = await getAllOrders();
  delete orders[orderId];
  await chrome.storage.local.set({ [STORAGE_KEY]: orders });
}

// 모든 주문 삭제 (디버깅용)
export async function clearAllOrders(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
