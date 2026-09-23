/**
 * 온체인 경보 (PLAN-ONCHAIN-TRACK §9 · P2에서 넘긴 것)
 *
 * 워처가 "사람이 봐야 한다"고 판단한 것들이 여기 쌓인다. **콘솔에만 남기면
 * 아무도 안 본다** — `anomaly`는 자동 진행도 자동 취소도 위험해서 멈춰 선
 * 자리라, 사람이 오지 않으면 거래가 영영 안 끝난다.
 *
 * ── localStorage에 둔다 (리뷰 #8)
 *
 * 전에는 메모리에만 있어서 **새로고침하면 사라졌다.** 조건이 계속되는 경보는 다음
 * 틱에 되살아나지만, 한 번만 일어나는 것(리오그 복귀, 타임락 회수 관측)은 영영
 * 안 보였다.
 *
 * ── 구조 경보는 따로 둔다
 *
 * 약정 밖의 자금(`rescue`)은 **돌려줘야 할 UTXO 목록**을 들고 있어야 버튼이 된다.
 * 그리고 같은 주문에 anomaly와 구조가 **같이** 걸린다(금액이 틀린 펀딩). 한 칸에
 * 넣으면 하나가 다른 하나를 덮는다.
 */
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';

export interface OnchainAlert {
  orderId: string;
  level: 'anomaly' | 'warn';
  why: string;
  at: number;
}

export interface OnchainRescueAlert {
  orderId: string;
  utxos: Array<{ txid: string; vout: number; valueSat: number }>;
  at: number;
}

type AlertMap = Record<string, OnchainAlert>;
type RescueMap = Record<string, OnchainRescueAlert>;
type Listener = () => void;

const ALERTS_KEY = 'admin:onchain-alerts';
const RESCUES_KEY = 'admin:onchain-rescue-alerts';

function load<T>(key: string): T {
  try {
    const raw = localStorage.getItem(key);
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    return {} as T;
  }
}

let alerts: AlertMap = load<AlertMap>(ALERTS_KEY);
let rescues: RescueMap = load<RescueMap>(RESCUES_KEY);
const listeners = new Set<Listener>();

function emit(): void {
  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
  localStorage.setItem(RESCUES_KEY, JSON.stringify(rescues));
  for (const l of listeners) l();
}

export function subscribeOnchainAlerts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** ⚠️ 맵 참조를 그대로 돌려준다 — 새 객체면 `useSyncExternalStore`가 무한 루프를 돈다 */
export function getOnchainAlertsSnapshot(): AlertMap {
  return alerts;
}

export function getOnchainRescueAlertsSnapshot(): RescueMap {
  return rescues;
}

/**
 * 같은 주문의 경보는 **하나만** 유지한다. 워처가 30초마다 같은 말을 하므로
 * 쌓으면 목록이 같은 줄로 가득 찬다. 대신 `anomaly`는 `warn`에 덮이지 않는다 —
 * 더 위험한 쪽이 남아야 한다.
 *
 * @returns 새 경보였는가 — 운영자 알림은 **새 것에만** 보낸다(30초마다 울리지 않게)
 */
export function raiseOnchainAlert(
  order: OnchainOrder,
  level: 'anomaly' | 'warn',
  why: string,
): boolean {
  const existing = alerts[order.orderId];
  if (existing?.level === 'anomaly' && level === 'warn') return false;
  if (existing?.level === level && existing.why === why) return false;

  alerts = {
    ...alerts,
    [order.orderId]: { orderId: order.orderId, level, why, at: Math.floor(Date.now() / 1000) },
  };
  emit();
  return true;
}

export function clearOnchainAlert(orderId: string): void {
  if (!alerts[orderId]) return;
  const { [orderId]: _gone, ...rest } = alerts;
  alerts = rest;
  emit();
}

/**
 * 구조가 필요한 UTXO를 적는다. **빈 목록이면 경보를 내린다** — 돌려줬거나 사라졌다.
 *
 * @returns 새로 생긴 경보인가 (목록이 바뀌었는가)
 */
export function setOnchainRescueAlert(
  order: OnchainOrder,
  utxos: Array<{ txid: string; vout: number; valueSat: number }>,
): boolean {
  const existing = rescues[order.orderId];
  if (utxos.length === 0) {
    if (!existing) return false;
    const { [order.orderId]: _gone, ...rest } = rescues;
    rescues = rest;
    emit();
    return false;
  }
  const sig = (list: OnchainRescueAlert['utxos']) =>
    list.map(u => `${u.txid}:${u.vout}`).sort().join(',');
  if (existing && sig(existing.utxos) === sig(utxos)) return false;
  rescues = {
    ...rescues,
    [order.orderId]: { orderId: order.orderId, utxos, at: Math.floor(Date.now() / 1000) },
  };
  emit();
  return true;
}

/** @testing-only */
export function _resetForTesting(): void {
  alerts = {};
  rescues = {};
  localStorage.removeItem(ALERTS_KEY);
  localStorage.removeItem(RESCUES_KEY);
}
