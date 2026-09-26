/**
 * 후원자 보증금 상태 저장소
 *
 * Admin으로부터 수신한 deposit-required/accepted/cancelled/settled 알림을 추적한다.
 * UI 전용 — order-store와 별도로 관리.
 */
import { createStore, isNum, isStr, oneOf, optional, recordOf, shape } from '@sajwo-tracker/shared';

export interface SponsorDeposit {
  bolt11: string;
  status?: 'accepted' | 'cancelled' | 'settled';
  /** 인보이스 알림의 created_at — 이보다 옛 알림은 **이전 클레임의 인보이스** 것이다 */
  at?: number;
  /** 상태 알림의 created_at */
  statusAt?: number;
}

type DepositMap = Record<string, SponsorDeposit>;

const store = createStore<DepositMap>({}, {
  key: 'sponsor:deposits',
  parse: recordOf(shape<SponsorDeposit>({
    bolt11: isStr, status: optional(oneOf(['accepted', 'cancelled', 'settled'])), at: optional(isNum),
    statusAt: optional(isNum),
  })),
});

export const subscribe = store.subscribe;
export const getSnapshot = store.get;

/**
 * 보증금 인보이스가 왔다.
 *
 * 클레임이 풀렸다가 다시 잡히면 같은 오더에 인보이스가 또 온다. 예전엔 옛 인보이스의 상태("환불됨")가
 * 그대로 남아 **새 인보이스의 결제 칸이 안 떴다**. 알림은 순서 없이 다시 올 수 있어서(새로고침 때 재구독)
 * 이벤트 시각으로 가른다 — 인보이스보다 옛 상태는 옛 인보이스 것이다.
 */
export function setDepositBolt11(orderId: string, bolt11: string, at: number): void {
  const existing = store.get()[orderId];
  if (existing?.bolt11 === bolt11) return;
  if (existing?.at !== undefined && at < existing.at) return; // 옛 인보이스가 늦게 도착
  const keepStatus = existing?.status && existing.statusAt !== undefined && existing.statusAt >= at;
  store.update(prev => ({
    ...prev,
    [orderId]: { bolt11, at, ...(keepStatus ? { status: existing.status, statusAt: existing.statusAt } : {}) },
  }));
}

export function setDepositStatus(orderId: string, status: 'accepted' | 'cancelled' | 'settled', at: number): void {
  const existing = store.get()[orderId];
  if (existing?.at !== undefined && at < existing.at) return; // 지금 인보이스보다 옛 알림
  if (existing?.statusAt !== undefined && at < existing.statusAt) return;
  if (existing?.status === status) return;
  store.update(prev => ({ ...prev, [orderId]: { ...existing, bolt11: existing?.bolt11 ?? '', status, statusAt: at } }));
}
