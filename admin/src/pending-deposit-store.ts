/**
 * 보증금 대기 저장소
 *
 * 오더 발행 전 보증금 hold invoice 결제를 추적한다.
 * 보증금 결제 완료 시 오더를 발행하고 엔트리를 삭제한다.
 * 만료 시에도 엔트리를 삭제하고 hold invoice를 cancel한다.
 *
 * type: 'customer' — 주문 생성 전 고객 보증금 (pre-order gate)
 * type: 'sponsor' — 클레임 후 후원자 보증금 (pre-verification gate)
 *
 * 이 상태는 릴레이 이벤트로 재구성할 수 없다 — 오더가 아직 발행되기 전이라
 * 30402가 없고, 보증금 인보이스는 어드민이 로컬에서 만든 것이다. 그래서
 * 다기기 운영을 위해 NIP-78로 백업한다(app-state-backup). 백업 실패는
 * 로컬 동작을 막지 않는다(fire-and-forget).
 */

import { publishAppState, fetchAppState, BACKUP_TAGS } from './nostr/app-state-backup';

const STORAGE_KEY = 'admin:pending-deposits';

export interface PendingDeposit {
  orderId: string;
  customerPubkey: string;
  /** 보증금 납부 대상: customer(주문 전), sponsor(검증 전) */
  type: 'customer' | 'sponsor';
  /** sponsor deposit인 경우 후원자 pubkey */
  sponsorPubkey?: string;
  price: number;
  expiration: number;
  depositPaymentHash: string;
  depositBolt11: string;
  createdAt: number;
}

type DepositMap = Record<string, PendingDeposit>;

function loadMap(): DepositMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveMap(map: DepositMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  void publishAppState(BACKUP_TAGS.pendingDeposits, map).catch(err =>
    console.warn('[PendingDeposit] 릴레이 백업 실패:', err),
  );
}

/**
 * 릴레이 백업에서 로컬에 없는 엔트리를 채운다. 부팅 시 1회 호출.
 * 로컬 우선 — 이 기기에서 방금 만든 것을 오래된 백업이 덮지 않게 한다.
 */
export async function restorePendingDeposits(): Promise<number> {
  const remote = await fetchAppState<DepositMap>(BACKUP_TAGS.pendingDeposits);
  if (!remote) return 0;

  const local = loadMap();
  let added = 0;
  for (const [orderId, deposit] of Object.entries(remote)) {
    if (orderId in local) continue;
    local[orderId] = deposit;
    added++;
  }
  if (added > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    console.log('[PendingDeposit] 릴레이에서', added, '건 복원');
  }
  return added;
}

export function savePendingDeposit(deposit: PendingDeposit): void {
  const map = loadMap();
  map[deposit.orderId] = deposit;
  saveMap(map);
}

export function getPendingDeposit(orderId: string): PendingDeposit | null {
  return loadMap()[orderId] ?? null;
}

export function deletePendingDeposit(orderId: string): void {
  const map = loadMap();
  if (orderId in map) {
    delete map[orderId];
    saveMap(map);
  }
}

export function getAllPendingDeposits(): PendingDeposit[] {
  return Object.values(loadMap());
}

/**
 * 만료된 pending deposit을 삭제하고 orderId 목록을 반환한다.
 * cleanup에서 호출하여 만료 보증금 hold invoice cancel에 사용.
 */
export function purgeExpiredDeposits(): PendingDeposit[] {
  const map = loadMap();
  const now = Math.floor(Date.now() / 1000);
  const expired: PendingDeposit[] = [];

  for (const [orderId, deposit] of Object.entries(map)) {
    if (deposit.expiration <= now) {
      expired.push(deposit);
      delete map[orderId];
    }
  }

  if (expired.length > 0) {
    saveMap(map);
  }

  return expired;
}
