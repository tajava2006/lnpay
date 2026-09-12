/**
 * 유저스크립트 파싱 주문 반응형 스토어
 *
 * 유저스크립트가 쿠팡 페이지에서 감지한 주문을 보관한다.
 * 사용자가 "사줘 요청"으로 전환하면 order-store로 이동하고 여기서 제거된다.
 *
 * useSyncExternalStore 호환 API를 제공한다.
 */
import type { ParsedOrderPayload } from './types';
import { getSnapshot as getOrderSnapshot } from './order-store';

type ParsedOrderMap = Record<string, ParsedOrderPayload>;
type Listener = () => void;

const STORAGE_KEY = 'customer:parsed-orders';

// ── 내부 상태 ──────────────────────────────────────

let parsedOrders: ParsedOrderMap = loadFromStorage();
const listeners = new Set<Listener>();

// ── localStorage 입출력 ────────────────────────────

function loadFromStorage(): ParsedOrderMap {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as ParsedOrderMap;
  } catch {
    return {};
  }
}

function saveToStorage(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(parsedOrders));
}

// ── 리스너 통지 ────────────────────────────────────

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribeParsed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getParsedSnapshot(): ParsedOrderMap {
  return parsedOrders;
}

// ── 뮤테이션 API ───────────────────────────────────

/** 파싱된 주문을 추가한다. 중복 이벤트 ID 또는 이미 요청된 주문은 무시. */
export function addParsedOrder(eventId: string, payload: ParsedOrderPayload): void {
  // 이벤트 ID 중복
  if (parsedOrders[eventId]) return;

  // 이미 order-store에 동일 coupangOrderId가 있으면 무시 (이미 요청한 건)
  const orders = getOrderSnapshot();
  if (orders[payload.coupangOrderId]) return;

  // 동일 coupangOrderId가 다른 이벤트로 이미 파싱되었으면 무시
  const existing = Object.values(parsedOrders).find(
    p => p.coupangOrderId === payload.coupangOrderId,
  );
  if (existing) return;

  parsedOrders = { ...parsedOrders, [eventId]: payload };
  saveToStorage();
  notify();
}

/** 파싱 주문을 제거한다 (무시 또는 사줘 요청 전환 후). */
export function removeParsedOrder(eventId: string): void {
  if (!parsedOrders[eventId]) return;
  const { [eventId]: _, ...rest } = parsedOrders;
  parsedOrders = rest;
  saveToStorage();
  notify();
}

/** 모든 파싱 주문을 제거한다. */
export function clearParsedOrders(): void {
  if (Object.keys(parsedOrders).length === 0) return;
  parsedOrders = {};
  saveToStorage();
  notify();
}
