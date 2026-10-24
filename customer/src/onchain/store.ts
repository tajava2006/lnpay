/**
 * 온체인 오더 스토어 (유저 앱)
 *
 * 헌법 그대로: **UI는 릴레이를 직접 안 본다.** 구독 서비스가 여기에 반영하고
 * UI는 `useSyncExternalStore`로 여기만 본다.
 *
 * 라이트닝 스토어와 **따로 둔다** — 상태 집합이 다르고, 저장 키가 갈려야
 * 온체인 트랙을 붙였다 뗐다 할 수 있다.
 */
import { createStore, recordOf } from '@sajwo-tracker/shared';
import { isStoredOnchainOrder, type OnchainOrder } from '@sajwo-tracker/shared/onchain';

type OrderMap = Record<string, OnchainOrder>;

const store = createStore<OrderMap>({}, { key: 'onchain:orders', parse: recordOf(isStoredOnchainOrder) });

export const subscribeOnchainOrders = store.subscribe;
export const getOnchainOrdersSnapshot = store.get;

export function getOnchainOrder(orderId: string): OnchainOrder | undefined {
  return store.get()[orderId];
}

/** 릴레이 에코 반영. 더 오래된 이벤트는 버린다 */
export function upsertOnchainOrder(order: OnchainOrder): boolean {
  const existing = store.get()[order.orderId];
  if (existing && existing.updatedAt > order.updatedAt) return false;
  store.update(prev => ({ ...prev, [order.orderId]: order }));
  return true;
}

/** 오더북 — 아직 안 팔린 남의 **공개** 의뢰. 지정 거래는 오더북이 아니다(`designatedToMe`) */
export function listedOrders(myPubkey: string): OnchainOrder[] {
  return Object.values(store.get())
    .filter(o => o.state === 'listed' && o.customerPubkey !== myPubkey && !o.designatedSponsor)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 나를 상대로 지정한, 아직 맡지 않은 의뢰 — 사기 탭 맨 위 */
export function designatedToMe(myPubkey: string): OnchainOrder[] {
  return Object.values(store.get())
    .filter(o => o.state === 'listed' && o.designatedSponsor === myPubkey && o.customerPubkey !== myPubkey)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 내가 낀 거래 — 역할은 pubkey 비교로 유도한다(칼럼을 따로 두지 않는다) */
export function myOnchainOrders(myPubkey: string): OnchainOrder[] {
  return Object.values(store.get())
    .filter(o => o.customerPubkey === myPubkey || o.sponsorPubkey === myPubkey)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 내가 판 적이 있나 — 팔기 탭 설명 상자를 접어 둘지 정할 때만 본다(구독 없이 지금 값) */
export function hasOnchainSale(myPubkey: string): boolean {
  return Object.values(store.get()).some(o => o.customerPubkey === myPubkey);
}

export function roleIn(order: OnchainOrder, myPubkey: string): 'customer' | 'sponsor' | null {
  if (order.customerPubkey === myPubkey) return 'customer';
  if (order.sponsorPubkey === myPubkey) return 'sponsor';
  return null;
}

/** @testing-only */
export const _resetForTesting = store.reset;
