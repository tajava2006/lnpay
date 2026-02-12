/**
 * Chrome Storage 관리
 *
 * 주문 데이터의 CRUD 작업을 담당
 * 상태 전이는 state-machine.ts를 통해 수행
 */

import type { TrackedOrder, VirtualAccountInfo } from './types';

const STORAGE_KEY = 'orders';

/**
 * 모든 주문 조회
 */
export async function getAllOrders(): Promise<Record<string, TrackedOrder>> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? {};
}

/**
 * 모든 주문 저장 (전체 덮어쓰기)
 * 상태 머신에서 원자적 업데이트에 사용
 */
export async function setAllOrders(orders: Record<string, TrackedOrder>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: orders });
}

/**
 * 특정 주문 조회
 */
export async function getOrder(orderId: string): Promise<TrackedOrder | null> {
  const orders = await getAllOrders();
  return orders[orderId] ?? null;
}

/**
 * 신규 주문 생성
 *
 * @param orderData 주문 기본 정보 (orderId, productName, amount, virtualAccount)
 * @returns 생성된 주문 객체
 */
export async function createOrder(orderData: {
  orderId: string;
  productName: string;
  amount: number;
  virtualAccount: VirtualAccountInfo;
  orderedAt: number;
}): Promise<TrackedOrder> {
  const orders = await getAllOrders();

  // 이미 존재하면 기존 주문 반환
  const existing = orders[orderData.orderId];
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const newOrder: TrackedOrder = {
    orderId: orderData.orderId,
    productName: orderData.productName,
    amount: orderData.amount,
    virtualAccount: orderData.virtualAccount,
    status: 'detected', // 초기 상태
    version: 1, // 초기 버전
    createdAt: orderData.orderedAt,
    updatedAt: now,
  };

  orders[orderData.orderId] = newOrder;
  await setAllOrders(orders);

  return newOrder;
}

/**
 * 주문 저장 (기존 호환용, 신규 생성에는 createOrder 사용 권장)
 */
export async function saveOrder(order: TrackedOrder): Promise<void> {
  const orders = await getAllOrders();
  orders[order.orderId] = order;
  await setAllOrders(orders);
}

/**
 * 주문 삭제
 */
export async function deleteOrder(orderId: string): Promise<void> {
  const orders = await getAllOrders();
  delete orders[orderId];
  await setAllOrders(orders);
}

/**
 * 모든 주문 삭제
 */
export async function clearAllOrders(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
