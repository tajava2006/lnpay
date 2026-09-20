/**
 * 어드민이 보낸 서명 요청 (PSBT)
 *
 * **자동으로 서명하지 않는다.** 화면이 "무엇에 대한 서명이고 얼마가 나가는지"를
 * 보여주고 유저가 누른다 — 릴리스는 특히 그렇다(O-007).
 */
const STORAGE_KEY = 'onchain:sign-requests';

export interface SignRequest {
  orderId: string;
  purpose: 'release' | 'refund' | 'dispute-customer' | 'dispute-sponsor';
  psbt: string;
  receivedAt: number;
}

type RequestMap = Record<string, SignRequest>;
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

export function subscribeSignRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSignRequestsSnapshot(): RequestMap {
  return requests;
}

export function getSignRequest(orderId: string): SignRequest | undefined {
  return requests[orderId];
}

export function putSignRequest(request: SignRequest): void {
  const existing = requests[request.orderId];
  // 더 나중 것만 남긴다 — 어드민이 수수료를 다시 추정해 새 tx를 보낼 수 있다.
  if (existing && existing.receivedAt > request.receivedAt) return;
  commit({ ...requests, [request.orderId]: request });
}

export function clearSignRequest(orderId: string): void {
  if (!requests[orderId]) return;
  const { [orderId]: _gone, ...rest } = requests;
  commit(rest);
}

/** @testing-only */
export function _resetForTesting(): void {
  requests = {};
  localStorage.removeItem(STORAGE_KEY);
}
