/**
 * 종결 대기 (PLAN-ONCHAIN-TRACK §5.2 R1-M4)
 *
 * ── 왜 필요한가
 *
 * **"마감 초과 → 자동 환불"이 진짜 자동이 아니다.** `{A,C}`를 쓰는 종결은
 * 전부 고객 서명이 필요하다 — 환불도, 고객승 분쟁도. 즉 **어드민 혼자서는
 * 환불도 못 한다.**
 *
 * 그래서 어드민이 tx를 만들어 자기 서명을 얹어두고, **상대가 돌아와 서명할
 * 때까지 기다린다.** 그 대기는 **FSM 상태가 아니다** — 오더는 아직 `funded`나
 * `presigned`에 머물러 있고, 체인에는 아무 일도 안 일어났다.
 * (라이트닝의 `pending-deposit-store`와 같은 자리다.)
 *
 * ⚠️ 이게 있어야 워처가 **멱등**해진다. 없으면 마감이 지난 주문에 매 틱마다
 * 새 환불 tx를 만들어 상대에게 쏜다.
 */
import type { SettlementKind, SettlementPath } from '@sajwo-tracker/shared/onchain';

export interface PendingSettlement {
  orderId: string;
  /** 장부상 사유 (보증금 처리가 여기서 갈린다 — §4.1) */
  settlementKind: SettlementKind;
  /** 어느 리프로 소모하는가 */
  path: SettlementPath;
  /** 어드민 서명이 든 PSBT (base64) */
  psbt: string;
  /** 받는 주소 — 상대 서명을 검증할 때 우리가 기대하는 출력 */
  destination: string;
  feeSat: number;
  /** 서명해야 하는 쪽 */
  awaiting: 'customer' | 'sponsor';
  createdAt: number;
  /** 마지막으로 서명 요청을 보낸 시각 (재촉 간격 계산용) */
  lastRequestedAt: number;
}

type PendingMap = Record<string, PendingSettlement>;
type Listener = () => void;

const STORE_KEY = 'admin:onchain-pending-settlement';

let pending: PendingMap = load();
const listeners = new Set<Listener>();

function load(): PendingMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as PendingMap) : {};
  } catch {
    return {};
  }
}

function save(): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(pending));
  for (const l of listeners) l();
}

export function subscribePendingSettlements(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * `useSyncExternalStore`가 읽는 스냅샷.
 *
 * ⚠️ **맵 참조를 그대로 돌려준다.** `Object.values()`처럼 호출마다 새 객체를
 * 만들면 React가 "바뀌었다"로 읽어 **무한 렌더 루프**에 빠진다
 * (실제로 그래서 어드민 화면이 안 떴다 — 2026-09-21). 목록이 필요하면
 * 호출부가 렌더 안에서 `Object.values()`를 하면 된다.
 */
export function getPendingSettlementsSnapshot(): Readonly<PendingMap> {
  return pending;
}

export function getPendingSettlements(): PendingSettlement[] {
  return Object.values(pending);
}

export function getPendingSettlement(orderId: string): PendingSettlement | undefined {
  return pending[orderId];
}

/**
 * 종결 대기를 만든다. **이미 있으면 덮어쓰지 않는다** — 그 PSBT에는 이미
 * 어드민 서명이 들어 있고, 상대가 그걸 받아 서명 중일 수 있다. 새로 만들면
 * 상대가 서명한 tx와 우리가 기다리는 tx가 갈린다.
 */
export function putPendingSettlement(entry: PendingSettlement): boolean {
  if (pending[entry.orderId]) return false;
  pending = { ...pending, [entry.orderId]: entry };
  save();
  return true;
}

/** 재촉을 보낸 시각을 갱신한다 */
export function markSettlementRequested(orderId: string, at: number): void {
  const entry = pending[orderId];
  if (!entry) return;
  pending = { ...pending, [orderId]: { ...entry, lastRequestedAt: at } };
  save();
}

/** 브로드캐스트까지 끝나 `settling`으로 넘어갔을 때 치운다 */
export function deletePendingSettlement(orderId: string): void {
  if (!pending[orderId]) return;
  const { [orderId]: _removed, ...rest } = pending;
  pending = rest;
  save();
}

/** @testing-only */
export function _resetForTesting(): void {
  pending = {};
  localStorage.removeItem(STORE_KEY);
}
