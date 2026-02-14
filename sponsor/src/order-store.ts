/**
 * 반응형 주문 스토어
 *
 * localStorage에 영구 저장하면서, React의 useSyncExternalStore와 호환되는
 * subscribe/getSnapshot 인터페이스를 제공한다.
 *
 * 구조:
 *   Nostr 구독 서비스 → order-store (upsert/remove) → localStorage + listeners
 *   OrderBook → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 */
import type { SajwoRequest } from './types';

type OrderMap = Record<string, SajwoRequest>;
type Listener = () => void;

const ORDERS_KEY = 'nostr:orders';

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

/** 리스너 등록. useSyncExternalStore의 첫 번째 인자. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 현재 주문 맵 스냅샷. useSyncExternalStore의 두 번째 인자. */
export function getSnapshot(): OrderMap {
  return orders;
}

/** 초기 동기화(EOSE) 완료 여부. */
export function getSyncedSnapshot(): boolean {
  return synced;
}

// ── 뮤테이션 API (Nostr 서비스에서 호출) ───────────

/**
 * 주문을 추가/갱신한다.
 * - 같은 orderId의 기존 이벤트보다 최신(createdAt이 큰)일 때만 업데이트.
 * - 기존 주문이 있으면 최초 발행자(pubkey)가 일치해야만 갱신 허용.
 */
export function upsertOrder(request: SajwoRequest): boolean {
  const existing = orders[request.orderId];
  if (existing) {
    if (existing.pubkey !== request.pubkey) return false;
    if (existing.createdAt >= request.createdAt) return false;
  }

  orders = { ...orders, [request.orderId]: request };
  saveToStorage();
  notify();
  return true;
}

/**
 * 주문을 삭제한다 (sold 이벤트 수신 시).
 * 최초 발행자(pubkey)가 일치해야만 삭제 허용.
 */
export function deleteOrder(orderId: string, pubkey: string): boolean {
  const existing = orders[orderId];
  if (!existing) return false;
  if (existing.pubkey !== pubkey) return false;

  const { [orderId]: _, ...rest } = orders;
  orders = rest;
  saveToStorage();
  notify();
  return true;
}

/** EOSE 수신 시 호출. 초기 동기화 완료를 표시한다. */
export function markSynced(): void {
  synced = true;
  notify();
}
