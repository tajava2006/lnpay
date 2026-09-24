/**
 * `useSyncExternalStore` 스냅샷 안정성
 *
 * ── 왜 이 테스트가 생겼나
 *
 * `OnchainPanel`이 `() => getPendingSettlements()`를 스냅샷으로 줬다.
 * 그 함수는 `Object.values()`라 **호출마다 새 배열**이고, React는 그걸
 * "바뀌었다"로 읽어 **무한 렌더 루프**에 빠진다.
 *
 * 결과가 나빴다 — 어드민 화면이 통째로 안 떴다(2026-09-21). 타입도 빌드도
 * 테스트도 전부 통과했는데, 화면을 열어야만 드러나는 종류다.
 *
 * 그래서 스토어의 스냅샷 getter를 **전수로** 돌며 "안 바뀌었으면 같은 참조"를
 * 단언한다. 새 스토어를 추가하면 여기 한 줄을 늘린다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as orderStore from '../onchain/order-store';
import * as alerts from '../onchain/alert-store';

const SNAPSHOTS: Array<[string, () => unknown]> = [
  ['order-store', orderStore.getSnapshot],
  ['alert-store', alerts.getOnchainAlertsSnapshot],
  ['alert-store (구조)', alerts.getOnchainRescueAlertsSnapshot],
];

beforeEach(() => {
  orderStore._resetForTesting();
  alerts._resetForTesting();
});

describe('스냅샷은 바뀌지 않으면 같은 참조여야 한다', () => {
  it.each(SNAPSHOTS)('%s', (_name, getSnapshot) => {
    expect(getSnapshot()).toBe(getSnapshot());
  });
});

describe('바뀌면 새 참조여야 한다 (안 그러면 화면이 안 갱신된다)', () => {
  it('order-store', () => {
    const before = orderStore.getSnapshot();
    orderStore.upsertOnchainOrder({
      orderId: 'o-1', state: 'listed', status: 'active', customerPubkey: 'c',
      amountSat: 1000, createdAt: 1, updatedAt: 1, expiration: 2, network: 'signet', raw: {},
    });
    expect(orderStore.getSnapshot()).not.toBe(before);
    expect(orderStore.getSnapshot()).toBe(orderStore.getSnapshot());
  });

  it('alert-store (구조)', () => {
    const before = alerts.getOnchainRescueAlertsSnapshot();
    alerts.setOnchainRescueAlert({ orderId: 'o-1' } as never, [{ txid: 'a'.repeat(64), vout: 0, valueSat: 1 }]);
    expect(alerts.getOnchainRescueAlertsSnapshot()).not.toBe(before);
    expect(alerts.getOnchainRescueAlertsSnapshot()).toBe(alerts.getOnchainRescueAlertsSnapshot());
  });

  it('alert-store', () => {
    const before = alerts.getOnchainAlertsSnapshot();
    alerts.raiseOnchainAlert(
      { orderId: 'o-1' } as never, 'anomaly', '이상',
    );
    expect(alerts.getOnchainAlertsSnapshot()).not.toBe(before);
  });
});
