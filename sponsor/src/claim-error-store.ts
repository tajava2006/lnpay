/**
 * 반응형 클레임 가격 에러 스토어
 *
 * Admin이 클레임 가격 범위 초과로 거부했을 때 수신한 에러를 보관하고,
 * useSyncExternalStore로 OrderCard UI에 자동 전파한다.
 * 영구 저장 불필요 (세션 알림 목적).
 */

export interface ClaimPriceError {
  orderId: string;
  expectedSats: number;
  receivedAt: number;
}

type ErrorMap = Record<string, ClaimPriceError>;
type Listener = () => void;

let errors: ErrorMap = {};
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribeClaimErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getClaimErrorSnapshot(): ErrorMap {
  return errors;
}

// ── 뮤테이션 API ───────────────────────────────────

export function setClaimError(orderId: string, expectedSats: number): void {
  errors = {
    ...errors,
    [orderId]: { orderId, expectedSats, receivedAt: Math.floor(Date.now() / 1000) },
  };
  notify();
}

export function clearClaimError(orderId: string): void {
  if (!errors[orderId]) return;
  const { [orderId]: _, ...rest } = errors;
  errors = rest;
  notify();
}
