/**
 * 리모컨 저장소 — 데몬 피드가 채우고 화면이 구독한다 (헌법: 릴레이 → 서비스 → 저장소 → UI)
 *
 * 데몬 상태와 오더는 localStorage에 남긴다 — 새로고침 직후에도 마지막으로 본 것을 띄우고, 피드가
 * 따라오면 갱신한다. 명령 결과는 그 세션의 것이라 메모리에만 둔다.
 */
import type { AdminChatCopy, AdminCommandResult, AdminLnOrderDetail, AdminState, Order } from '@sajwo-tracker/shared';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
}

function createStore<T>(initial: T, persistKey?: string): Store<T> {
  let value = initial;
  if (persistKey) {
    try {
      const raw = localStorage.getItem(persistKey);
      if (raw) value = JSON.parse(raw) as T;
    } catch { /* 망가진 캐시는 버린다 */ }
  }
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (next === value) return;
    value = next;
    if (persistKey) {
      try { localStorage.setItem(persistKey, JSON.stringify(value)); } catch { /* 저장 실패는 화면에 영향 없음 */ }
    }
    listeners.forEach(l => l());
  };
  return {
    get: () => value,
    set,
    update: fn => set(fn(value)),
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export interface DaemonStateView {
  state: AdminState | null;
  /** 상태 이벤트의 created_at (초) — 화면은 이게 오래되면 "응답 없음" */
  eventAt: number | null;
}

export const daemonState = createStore<DaemonStateView>({ state: null, eventAt: null }, 'admin2:daemon-state');

export interface CommandView {
  id: string;
  cmd: string;
  sentAt: number;
  status: 'sending' | 'pending' | 'done' | 'failed-to-send' | 'timeout';
  result?: AdminCommandResult;
  error?: string;
}

export const commands = createStore<Record<string, CommandView>>({});

/** 오더별 채팅 사본 — 키는 `${track}:${orderId}` (P3·P4 분쟁 화면이 쓴다) */
export const chats = createStore<Record<string, AdminChatCopy[]>>({}, 'admin2:chats');

export const lnOrders = createStore<Record<string, Order>>({}, 'admin2:ln-orders');

export interface LnDetailView {
  detail: AdminLnOrderDetail;
  eventAt: number;
}

/** 라이트닝 오더별 비공개 상세 (데몬 → 이 운영자). 판정 명령은 여기 버전을 싣는다 */
export const lnDetails = createStore<Record<string, LnDetailView>>({}, 'admin2:ln-details');
export const onchainOrders = createStore<Record<string, OnchainOrder>>({}, 'admin2:onchain-orders');

export function clearStores(): void {
  daemonState.set({ state: null, eventAt: null });
  commands.set({});
  chats.set({});
  lnOrders.set({});
  lnDetails.set({});
  onchainOrders.set({});
}
