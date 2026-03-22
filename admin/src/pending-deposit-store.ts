/**
 * 보증금 대기 저장소
 *
 * 오더 발행 전 보증금 hold invoice 결제를 추적한다.
 * 보증금 결제 완료 시 오더를 발행하고 엔트리를 삭제한다.
 * 만료 시에도 엔트리를 삭제하고 hold invoice를 cancel한다.
 */

const STORAGE_KEY = 'admin:pending-deposits';

export interface PendingDeposit {
  orderId: string;
  customerPubkey: string;
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
