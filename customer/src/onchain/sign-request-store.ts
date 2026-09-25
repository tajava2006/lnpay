/**
 * 어드민이 보낸 서명 요청 (PSBT)
 *
 * **자동으로 서명하지 않는다.** 화면이 "무엇에 대한 서명이고 얼마가 어디로 가는지"를
 * 보여주고 유저가 누른다 — 릴리스는 특히 그렇다(O-007).
 *
 * ── 목적별로 따로 둔다
 *
 * 전에는 주문당 **하나**만 뒀다. 릴리스 PSBT(후원자 사전서명이 든 것)와 환불 요청이
 * 서로를 덮어써서, 환불 요청이 뒤에 오면 고객은 릴리스를 완성할 방법을 잃었다.
 * 구조(`rescue`)는 UTXO마다 따로 온다.
 */
import type { SignPurpose } from '@sajwo-tracker/shared/onchain';

const STORAGE_KEY = 'onchain:sign-requests-v2';

export interface SignRequest {
  orderId: string;
  purpose: SignPurpose;
  psbt: string;
  receivedAt: number;
  /** `rescue`일 때 소모하는 UTXO (`txid:vout`) — 같은 주문에 여럿일 수 있다 */
  outpoint?: string;
}

type RequestMap = Record<string, SignRequest>;
type Listener = () => void;

export function signRequestKey(r: Pick<SignRequest, 'orderId' | 'purpose' | 'outpoint'>): string {
  return r.purpose === 'rescue' ? `${r.orderId}|rescue|${r.outpoint ?? ''}` : `${r.orderId}|${r.purpose}`;
}

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

/** ⚠️ 맵 참조 그대로 — 새 객체를 만들면 `useSyncExternalStore`가 무한 루프를 돈다 */
export function getSignRequestsSnapshot(): RequestMap {
  return requests;
}

/** 이 주문의 요청들 */
export function signRequestsFor(snapshot: RequestMap, orderId: string): SignRequest[] {
  return Object.values(snapshot).filter(r => r.orderId === orderId);
}

export function putSignRequest(request: SignRequest): void {
  const key = signRequestKey(request);
  const existing = requests[key];
  // 더 나중 것만 남긴다 — 어드민이 다시 보낸 것(수수료를 새로 잡았을 수 있다)이 이긴다.
  if (existing && existing.receivedAt > request.receivedAt) return;
  commit({ ...requests, [key]: request });
}

export function clearSignRequest(request: Pick<SignRequest, 'orderId' | 'purpose' | 'outpoint'>): void {
  const key = signRequestKey(request);
  if (!requests[key]) return;
  const { [key]: _gone, ...rest } = requests;
  commit(rest);
}

/** 이 주문의 요청을 전부 치운다 (종결됐을 때) — 구조 요청은 남긴다(FSM 밖이다) */
export function clearSignRequestsFor(orderId: string): void {
  const rest = Object.fromEntries(
    Object.entries(requests).filter(([, r]) => r.orderId !== orderId || r.purpose === 'rescue'),
  );
  if (Object.keys(rest).length === Object.keys(requests).length) return;
  commit(rest);
}

/** @testing-only */
export function _resetForTesting(): void {
  requests = {};
  localStorage.removeItem(STORAGE_KEY);
}
