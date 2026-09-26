/**
 * 반응형 주문 스토어 (읽기 전용)
 *
 * 데몬이 발행한 오더를 저장한다.
 * Sponsor는 상태를 직접 변경하지 않으며, 릴레이에서 수신한 이벤트로만 갱신된다.
 *
 * 구조:
 *   Nostr 구독 서비스 → order-store (upsert) → localStorage + listeners
 *   OrderBook → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 */
import { createStore, nowSec, recordOf, type Order } from '@sajwo-tracker/shared';
import { isStoredLnOrder } from '@sajwo-tracker/shared/ln';

type OrderMap = Record<string, Order>;

const orders = createStore<OrderMap>({}, { key: 'sponsor:orders', parse: recordOf(isStoredLnOrder) });
/** 이번 세션의 첫 동기화가 끝났나 — 저장하지 않는다 */
const synced = createStore(false);

// ── useSyncExternalStore 호환 API — 오더와 동기화 표시를 한 구독으로 ──

export function subscribe(listener: () => void): () => void {
  const offOrders = orders.subscribe(listener);
  const offSynced = synced.subscribe(listener);
  return () => { offOrders(); offSynced(); };
}

export const getSnapshot = orders.get;
export const getSyncedSnapshot = synced.get;

// ── 뮤테이션 API (Nostr 서비스에서 호출) ───────────

/**
 * 오더를 추가/갱신한다. 최신 이벤트만 유지 (updatedAt 비교).
 */
export function upsertOrder(order: Order): void {
  const existing = orders.get()[order.orderId];
  if (existing && existing.updatedAt >= order.updatedAt) return;
  orders.update(prev => ({ ...prev, [order.orderId]: order }));
}

/**
 * 오더를 삭제한다 (sold 이벤트 수신 시).
 */
export function deleteOrder(orderId: string): void {
  if (!orders.get()[orderId]) return;
  orders.update(({ [orderId]: _gone, ...rest }) => rest);
}

export function markSynced(): void {
  synced.set(true);
}

// ── 만료 삭제 ─────────────────────────────────────

const CLEANUP_INTERVAL = 60_000; // 60초
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 릴레이 보존이 끝난 오더를 지운다 (`retainUntil`).
 *
 * 예전엔 `expiration`(= 쿠팡 기한)으로 지워서 **진행 중 거래가 기한에 화면에서 사라졌다** — 기한 직후의
 * 송금 완료·입금 확인·분쟁이 제일 중요한 순간인데. 데몬은 진행 중이면 보존을 넉넉히 늘린다.
 * `retainUntil`이 없는 옛 이벤트만 기한으로 지운다.
 */
function purgeExpired(): void {
  const now = nowSec();
  const current = orders.get();
  const kept = Object.fromEntries(
    Object.entries(current).filter(([, o]) => {
      const until = o.retainUntil ?? o.expiration;
      return until === 0 || until > now;
    }),
  );
  if (Object.keys(kept).length === Object.keys(current).length) return;
  orders.set(kept);
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
