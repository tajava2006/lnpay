/**
 * 리모컨 저장소 — 데몬 피드가 채우고 화면이 구독한다 (헌법: 릴레이 → 서비스 → 저장소 → UI)
 *
 * **캐시일 뿐이다.** 장부는 데몬 DB에 있다. 데몬 상태와 오더를 localStorage에 남기는 건 새로고침 직후에도
 * 마지막으로 본 것을 띄우려는 것뿐 — 날아가도 릴레이에서 다시 채워진다. 명령 결과는 그 세션의 것이라
 * 메모리에만 둔다.
 *
 * 캐시는 릴레이보다 오래 살지 않는다(`pruneStores`) — 데몬 epoch 전의 오더와 보존이 끝난 것은 지운다.
 */
import type {
  AdminChatCopy, AdminCommandResult, AdminLnOrderDetail, AdminOcOrderDetail, AdminState, Order, TrackName,
} from '@sajwo-tracker/shared';
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

/**
 * 데몬이 받기 시작한 시각. 모르면 null — 상태를 아직 못 받았거나, `epoch`를 싣기 전의 데몬이다.
 * 모를 때는 오더를 **하나도** 보여주지 않는다(옛 프론트 어드민 시절 오더를 가릴 방법이 없다).
 */
export function daemonEpoch(): number | null {
  const epoch: unknown = daemonState.get().state?.epoch;
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : null;
}

export interface CommandView {
  id: string;
  cmd: string;
  sentAt: number;
  status: 'sending' | 'pending' | 'done' | 'failed-to-send' | 'timeout';
  result?: AdminCommandResult;
  error?: string;
}

export const commands = createStore<Record<string, CommandView>>({});

/** 오더별 채팅 사본 — 키는 `${track}:${orderId}` (P4 분쟁 화면이 쓴다) */
export const chats = createStore<Record<string, AdminChatCopy[]>>({}, 'admin2:chats');

export const lnOrders = createStore<Record<string, Order>>({}, 'admin2:ln-orders');

export interface LnDetailView {
  detail: AdminLnOrderDetail;
  eventAt: number;
  /** 릴레이 보존 (NIP-40 `expiration`) — 지나면 캐시에서도 지운다 */
  retainUntil?: number;
}

/** 라이트닝 오더별 비공개 상세 (데몬 → 이 운영자). 판정 명령은 여기 버전을 싣는다 */
export const lnDetails = createStore<Record<string, LnDetailView>>({}, 'admin2:ln-details');
export const onchainOrders = createStore<Record<string, OnchainOrder>>({}, 'admin2:onchain-orders');

export interface OcDetailView {
  detail: AdminOcOrderDetail;
  eventAt: number;
  /** 릴레이 보존 (NIP-40 `expiration`) — 지나면 캐시에서도 지운다 */
  retainUntil?: number;
}

/** 온체인 오더별 비공개 상세 (받을 주소·보증금·구조 대상 등) — 명령은 여기 버전을 싣는다 */
export const ocDetails = createStore<Record<string, OcDetailView>>({}, 'admin2:oc-details');

/** 라이트닝 오더를 볼 이유가 있는가 — 데몬이 만든 것(epoch 뒤)이고 릴레이 보존이 남았다 */
export function lnOrderAlive(order: Order, epoch: number | null, nowSec: number): boolean {
  return epoch !== null && order.createdAt >= epoch && (order.retainUntil ?? order.expiration) > nowSec;
}

/** 온체인 오더도 같다. 온체인 이벤트의 `expiration` 태그는 데몬이 보존 시각으로 바꿔 낸다 */
export function ocOrderAlive(order: OnchainOrder, epoch: number | null, nowSec: number): boolean {
  return epoch !== null && order.createdAt >= epoch && order.expiration > nowSec;
}

/**
 * 오더 이벤트 반영 — 더 새 버전만. 새 버전이 이미 보존이 끝났으면(NIP-40을 안 지키는 릴레이가 준 것) 캐시에
 * 남은 옛 버전도 지운다 — 안 그러면 끝난 오더가 옛 "진행 중" 모습으로 남는다.
 */
export function upsertOrder<T extends { orderId: string; updatedAt: number }>(
  store: Store<Record<string, T>>, order: T, alive: boolean,
): void {
  store.update(prev => {
    const existing = prev[order.orderId];
    if (existing && existing.updatedAt >= order.updatedAt) return prev;
    if (alive) return { ...prev, [order.orderId]: order };
    if (!existing) return prev;
    const { [order.orderId]: _gone, ...rest } = prev;
    return rest;
  });
}

/**
 * 볼 이유가 없는 것을 캐시에서 지운다. 오더를 지우면 그 상세·채팅도 같이 간다.
 * (`createdAt`은 오더 이벤트의 created_at이다 — 데몬은 epoch 뒤에만 발행한다)
 */
export function pruneStores(nowSec: number): void {
  const epoch = daemonEpoch();
  const gone = new Set<string>(); // `${track}:${orderId}`
  const keep = <T>(store: Store<Record<string, T>>, track: TrackName, alive: (v: T) => boolean) => {
    const prev = store.get();
    const next: Record<string, T> = {};
    let dropped = false;
    for (const [orderId, v] of Object.entries(prev)) {
      if (alive(v)) next[orderId] = v;
      else { gone.add(`${track}:${orderId}`); dropped = true; }
    }
    if (dropped) store.set(next);
  };
  keep(lnOrders, 'ln', o => lnOrderAlive(o, epoch, nowSec));
  keep(onchainOrders, 'onchain', o => ocOrderAlive(o, epoch, nowSec));
  keep(lnDetails, 'ln', v => !gone.has(`ln:${v.detail.orderId}`) && (v.retainUntil ?? Infinity) > nowSec);
  keep(ocDetails, 'onchain', v => !gone.has(`onchain:${v.detail.orderId}`) && (v.retainUntil ?? Infinity) > nowSec);
  const prevChats = chats.get();
  if (Object.keys(prevChats).some(k => gone.has(k))) {
    chats.set(Object.fromEntries(Object.entries(prevChats).filter(([k]) => !gone.has(k))));
  }
}

export function clearStores(): void {
  daemonState.set({ state: null, eventAt: null });
  commands.set({});
  chats.set({});
  lnOrders.set({});
  lnDetails.set({});
  onchainOrders.set({});
  ocDetails.set({});
}
