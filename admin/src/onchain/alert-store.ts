/**
 * 온체인 경보 (PLAN-ONCHAIN-TRACK §9 · P2에서 넘긴 것)
 *
 * 워처가 "사람이 봐야 한다"고 판단한 것들이 여기 쌓인다. **콘솔에만 남기면
 * 아무도 안 본다** — `anomaly`는 자동 진행도 자동 취소도 위험해서 멈춰 선
 * 자리라, 사람이 오지 않으면 거래가 영영 안 끝난다.
 */
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';

export interface OnchainAlert {
  orderId: string;
  level: 'anomaly' | 'warn';
  why: string;
  at: number;
}

type AlertMap = Record<string, OnchainAlert>;
type Listener = () => void;

let alerts: AlertMap = {};
const listeners = new Set<Listener>();

export function subscribeOnchainAlerts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOnchainAlertsSnapshot(): AlertMap {
  return alerts;
}

/**
 * 같은 주문의 경보는 **하나만** 유지한다. 워처가 30초마다 같은 말을 하므로
 * 쌓으면 목록이 같은 줄로 가득 찬다. 대신 `anomaly`는 `warn`에 덮이지 않는다 —
 * 더 위험한 쪽이 남아야 한다.
 */
export function raiseOnchainAlert(
  order: OnchainOrder,
  level: 'anomaly' | 'warn',
  why: string,
): void {
  const existing = alerts[order.orderId];
  if (existing?.level === 'anomaly' && level === 'warn') return;
  if (existing?.level === level && existing.why === why) return;

  alerts = {
    ...alerts,
    [order.orderId]: { orderId: order.orderId, level, why, at: Math.floor(Date.now() / 1000) },
  };
  for (const l of listeners) l();
}

export function clearOnchainAlert(orderId: string): void {
  if (!alerts[orderId]) return;
  const { [orderId]: _gone, ...rest } = alerts;
  alerts = rest;
  for (const l of listeners) l();
}

/** @testing-only */
export function _resetForTesting(): void {
  alerts = {};
}
