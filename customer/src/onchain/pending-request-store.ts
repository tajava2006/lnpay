/**
 * 내가 보낸 의뢰 등록 요청 (아직 오더가 안 생긴 것)
 *
 * ── 왜 필요한가
 *
 * 의뢰 등록은 요청 이벤트를 쏘는 것으로 끝나고, **오더는 보증금을 결제해야
 * 생긴다**. 그 사이에 어드민이 요청을 거절하거나(최소 거래액 미달 등)
 * 실패하면(시세·수수료 조회 실패) **유저 쪽에는 흔적이 하나도 안 남는다.**
 *
 * 실제로 그랬다 — 의뢰를 두 번 올렸는데 하나는 인보이스가 오고 하나는
 * 그냥 사라졌다(2026-09-21). 어느 쪽인지 알 방법이 없었다.
 *
 * → 보낸 요청을 로컬에 적어두고, **인보이스나 오더가 도착하면 지운다.**
 *   남아 있으면 그게 곧 "아직 답이 없다"는 뜻이다.
 */
const STORAGE_KEY = 'onchain:pending-requests';

export interface PendingOrderRequest {
  orderId: string;
  amountSat: number;
  reserveKrw?: number;
  expiration: number;
  submittedAt: number;
  /** 어드민이 거절한 사유 (오면 채워진다) */
  rejectedReason?: string;
}

type RequestMap = Record<string, PendingOrderRequest>;
type Listener = () => void;

function load(): RequestMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RequestMap) : {};
  } catch {
    return {};
  }
}

let requests: RequestMap = load();
const listeners = new Set<Listener>();

function commit(next: RequestMap): void {
  requests = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
  for (const l of listeners) l();
}

export function subscribePendingRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPendingRequestsSnapshot(): Readonly<RequestMap> {
  return requests;
}

export function rememberPendingRequest(request: PendingOrderRequest): void {
  commit({ ...requests, [request.orderId]: request });
}

export function markRequestRejected(orderId: string, reason: string): void {
  const existing = requests[orderId];
  if (!existing) return;
  commit({ ...requests, [orderId]: { ...existing, rejectedReason: reason } });
}

/** 인보이스나 오더가 도착했다 — 더 기다릴 게 없다 */
export function forgetPendingRequest(orderId: string): void {
  if (!requests[orderId]) return;
  const { [orderId]: _gone, ...rest } = requests;
  commit(rest);
}

/** @testing-only */
export function _resetForTesting(): void {
  requests = {};
  localStorage.removeItem(STORAGE_KEY);
}
