/**
 * 어드민이 "이건 처리 못 한다"고 알려온 것 (주문별 마지막 한 건)
 *
 * 의뢰 등록 거절은 `pending-request-store`가 받는다. 여기는 **오더가 생긴 뒤**의
 * 거절이다 — 클레임(주소·수수료율 불량), 늦은 사전서명, 늦은 계좌, 늦은 송금 주장.
 * 전에는 이 경로들이 콘솔에만 남아서 유저는 "보냈는데 아무 일도 없다"만 봤다.
 */
import { createStore, isNum, isStr, recordOf, shape } from '@sajwo-tracker/shared';

export interface OrderNotice {
  orderId: string;
  reason: string;
  receivedAt: number;
}

type NoticeMap = Record<string, OrderNotice>;

const store = createStore<NoticeMap>({}, {
  key: 'onchain:notices',
  parse: recordOf(shape<OrderNotice>({ orderId: isStr, reason: isStr, receivedAt: isNum })),
});

export const subscribeNotices = store.subscribe;
export const getNoticesSnapshot = store.get;

export function putNotice(notice: OrderNotice): void {
  const existing = store.get()[notice.orderId];
  if (existing && existing.receivedAt > notice.receivedAt) return;
  store.update(prev => ({ ...prev, [notice.orderId]: notice }));
}

export function clearNotice(orderId: string): void {
  if (!store.get()[orderId]) return;
  store.update(({ [orderId]: _gone, ...rest }) => rest);
}

/** @testing-only */
export const _resetForTesting = store.reset;
