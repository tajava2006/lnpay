/**
 * 요청 스토어 (kind 1111 이벤트 저장)
 *
 * Nostr 서비스 → request-store → localStorage + listeners
 * UI → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 *
 * PK: eventId (Nostr event ID, 릴레이 중복 수신 방어)
 */
import type { Request } from '@sajwo-tracker/shared';

type RequestMap = Record<string, Request>;
type Listener = () => void;

const REQUESTS_KEY = 'admin:requests';

// ── 내부 상태 ──────────────────────────────────────

let requests: RequestMap = loadFromStorage();
let synced = false;
const listeners = new Set<Listener>();

// ── localStorage 입출력 ────────────────────────────

function loadFromStorage(): RequestMap {
  const stored = localStorage.getItem(REQUESTS_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as RequestMap;
  } catch {
    return {};
  }
}

function saveToStorage(): void {
  localStorage.setItem(REQUESTS_KEY, JSON.stringify(requests));
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

export function getSnapshot(): RequestMap {
  return requests;
}

export function getSyncedSnapshot(): boolean {
  return synced;
}

// ── 뮤테이션 API ───────────────────────────────────

/**
 * 요청을 추가한다. 같은 eventId가 이미 있으면 무시 (릴레이 중복 방어).
 */
export function upsertRequest(request: Request): boolean {
  const existing = requests[request.eventId];
  if (existing) return false;

  requests = { ...requests, [request.eventId]: request };
  saveToStorage();
  notify();
  return true;
}

/**
 * 인보이스 유동성 검증 결과를 기록한다.
 */
export function updateLiquidityVerified(eventId: string, verified: boolean): boolean {
  const req = requests[eventId];
  if (!req || req.action !== 'claim' || !req.invoice) return false;

  requests = {
    ...requests,
    [eventId]: {
      ...req,
      invoice: { ...req.invoice, liquidityVerified: verified },
    },
  };
  saveToStorage();
  notify();
  return true;
}

export function markSynced(): void {
  synced = true;
  notify();
}

/**
 * 특정 orderIds에 속하는 모든 요청을 삭제한다.
 * 만료 오더 삭제 시 연관 요청도 함께 정리하기 위해 사용.
 */
export function purgeByOrderIds(orderIds: string[]): void {
  if (orderIds.length === 0) return;

  const idSet = new Set(orderIds);
  const before = Object.keys(requests).length;

  requests = Object.fromEntries(
    Object.entries(requests).filter(([, req]) => !idSet.has(req.orderId)),
  );

  if (Object.keys(requests).length === before) return;

  saveToStorage();
  notify();
}
