/**
 * 반응형 주문 스토어
 *
 * Customer가 수동 생성한 주문을 관리하고,
 * Admin kind 30402 이벤트로 수신한 상태를 오버레이한다.
 *
 * 구조:
 *   OrderForm → addOrder → localStorage + listeners
 *   Nostr 구독 → applyAdminUpdate → localStorage + listeners
 *   Dashboard → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 */
import type { AdminOrderUpdate, CustomerOrder } from './types';
import type { AccountInfo } from '@sajwo-tracker/shared';

type OrderMap = Record<string, CustomerOrder>;
type Listener = () => void;

const ORDERS_KEY = 'customer:orders';

// ── 내부 상태 ──────────────────────────────────────

let orders: OrderMap = loadFromStorage();
let synced = false;
const listeners = new Set<Listener>();

// ── localStorage 입출력 ────────────────────────────

function loadFromStorage(): OrderMap {
  const stored = localStorage.getItem(ORDERS_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as OrderMap;
  } catch {
    return {};
  }
}

function saveToStorage(): void {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

// ── 리스너 통지 ────────────────────────────────────

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): OrderMap {
  return orders;
}

export function getSyncedSnapshot(): boolean {
  return synced;
}

// ── 뮤테이션 API ───────────────────────────────────

/** 새 주문을 추가한다 (수동 입력 폼에서 호출). */
export function addOrder(order: CustomerOrder): void {
  if (orders[order.orderId]) return;
  orders = { ...orders, [order.orderId]: order };
  saveToStorage();
  notify();
}

/** 의뢰 발행 성공 시 raw 필드를 저장한다. */
export function markPublished(orderId: string, raw: string): void {
  const existing = orders[orderId];
  if (!existing) return;
  orders = { ...orders, [orderId]: { ...existing, raw } };
  saveToStorage();
  notify();
}

/**
 * Admin 오더 상태를 오버레이한다. 바뀐 게 있을 때만 갱신한다.
 */
export function applyAdminUpdate(update: AdminOrderUpdate): void {
  const { orderId, adminState, bolt11, sponsorPubkey, retainUntil, closeReason } = update;
  const existing = orders[orderId];
  if (!existing) return;

  const changed = existing.adminState !== adminState
    || (bolt11 != null && existing.bolt11 !== bolt11)
    || (sponsorPubkey != null && existing.sponsorPubkey !== sponsorPubkey)
    || (retainUntil != null && existing.retainUntil !== retainUntil)
    || (closeReason != null && existing.closeReason !== closeReason);
  if (!changed) return;

  orders = {
    ...orders,
    [orderId]: {
      ...existing,
      adminState,
      ...(bolt11 != null ? { bolt11 } : {}),
      ...(sponsorPubkey != null ? { sponsorPubkey } : {}),
      ...(retainUntil != null ? { retainUntil } : {}),
      ...(closeReason != null ? { closeReason } : {}),
    },
  };
  saveToStorage();
  notify();
}

/** 보증금 인보이스를 주문에 저장한다 (deposit-required 알림 수신 시). */
export function applyDepositRequired(orderId: string, depositBolt11: string): void {
  const existing = orders[orderId];
  if (!existing) return;
  if (existing.depositBolt11 === depositBolt11) return;
  orders = { ...orders, [orderId]: { ...existing, depositBolt11 } };
  saveToStorage();
  notify();
}

/** 보증금 인보이스 상태를 갱신한다 (deposit-accepted/cancelled/settled 알림 수신 시). */
export function applyDepositStatus(orderId: string, depositStatus: 'accepted' | 'cancelled' | 'settled'): void {
  const existing = orders[orderId];
  if (!existing) return;
  if (existing.depositStatus === depositStatus) return;
  orders = { ...orders, [orderId]: { ...existing, depositStatus } };
  saveToStorage();
  notify();
}

/** 계좌정보 전달 완료 시 로컬 저장 */
export function setAccountInfo(orderId: string, accountInfo: AccountInfo): void {
  const existing = orders[orderId];
  if (!existing) return;
  orders = { ...orders, [orderId]: { ...existing, accountInfo } };
  saveToStorage();
  notify();
}

/** 주문을 삭제한다. */
export function deleteOrder(orderId: string): void {
  if (!orders[orderId]) return;
  const { [orderId]: _, ...rest } = orders;
  orders = rest;
  saveToStorage();
  notify();
}

/** 지워도 되는 주문만 지운다 — 진행 중인 건 남긴다. 지운 개수를 돌려준다 */
export function clearDeletableOrders(canDelete: (o: CustomerOrder) => boolean): number {
  const kept = Object.fromEntries(Object.entries(orders).filter(([, o]) => !canDelete(o)));
  const removed = Object.keys(orders).length - Object.keys(kept).length;
  if (removed === 0) return 0;
  orders = kept;
  saveToStorage();
  notify();
  return removed;
}

export function markSynced(): void {
  synced = true;
  notify();
}

// ── 만료 삭제 ─────────────────────────────────────

const CLEANUP_INTERVAL = 60_000; // 60초

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 보존이 끝난 주문을 localStorage에서 삭제한다.
 *
 * 이 정리는 IDB 아카이브가 생긴 뒤에야 안전해졌다. 그전에는 지우면 기록이
 * 아무 데도 안 남았다 — 릴레이도 만료된 오더를 지우기 때문이다. 지금은
 * 고객 역할 오더도 IDB에 보존되므로(buyer/nostr/service.ts) 여기서는
 * 표시용 사본만 정리하면 된다.
 *
 * 기준은 데몬이 준 **보존 기한**(`retainUntil`)이다 — 쿠팡 기한(`expiration`)으로 지우면 진행 중
 * 거래가 기한에 화면에서 사라진다(PLAN-DAEMON §7 L-1). 데몬 오더를 아직 못 받은 주문만 기한으로 지운다.
 * 미발행 주문(expiration === 0)은 아직 만료 개념이 없으므로 남긴다.
 */
function purgeExpired(): void {
  const now = Math.floor(Date.now() / 1000);
  const before = Object.keys(orders).length;

  orders = Object.fromEntries(
    Object.entries(orders).filter(([, o]) => {
      const until = o.retainUntil ?? o.expiration;
      return until === 0 || until > now;
    }),
  );

  if (Object.keys(orders).length === before) return;

  saveToStorage();
  notify();
}

export function startCleanup(): void {
  if (cleanupTimer) return;
  purgeExpired(); // 즉시 1회 실행
  cleanupTimer = setInterval(purgeExpired, CLEANUP_INTERVAL);
}

export function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * 파싱된 쿠팡 주문을 **기존 의뢰에 붙인다.**
 *
 * ── 왜 있는가
 *
 * 급하지 않은 구매는 "가격만 맞춰 의뢰를 오래 걸어두고 후원자를 기다리는" 쓰임이
 * 자연스럽다. 그런데 쿠팡 무통장 가상계좌는 하루면 죽으므로, 주문은 **후원자가
 * 붙은 뒤에** 넣어야 한다. 그러면 그 시점의 파싱 결과를 새 의뢰로 올릴 게 아니라
 * 이미 후원자가 붙어 있는 기존 의뢰에 연결해야 한다.
 *
 * ── 왜 이것만으로 되는가
 *
 * 수동 의뢰와 파싱 의뢰의 **유일한 차이가 `fixedAccountInfo`**다. 그걸 써넣으면
 * 그 뒤 계좌 전달은 기존 경로가 알아서 한다 — 새 이벤트도 상태도 필요 없고,
 * 어드민·후원자는 이런 일이 있었는지조차 모른다.
 */
export function attachParsedToOrder(
  orderId: string,
  parsed: {
    coupangOrderId: string;
    productName: string;
    bankName: string;
    accountNumber: string;
    holderName: string;
  },
): boolean {
  const order = orders[orderId];
  if (!order) return false;

  orders = {
    ...orders,
    [orderId]: {
      ...order,
      coupangOrderId: parsed.coupangOrderId,
      memo: parsed.productName,
      // source는 'parsed'로 바꾸지 않는다. 이 의뢰는 사람이 손으로 만든 것이고,
      // 자동 전송이 보는 건 source가 아니라 fixedAccountInfo의 유무다.
      fixedAccountInfo: {
        bankName: parsed.bankName,
        accountNumber: parsed.accountNumber,
        holderName: parsed.holderName,
      },
    },
  };
  saveToStorage();
  notify();
  return true;
}
