/**
 * Sponsor IndexedDB 저장소 (히스토리 장기 보존)
 *
 * 클레임 시점부터 오더와 관련 request를 영구 보존한다.
 * 구독 시 IDB에 이미 있는 오더만 업데이트, 없으면 무시.
 *
 * 오브젝트 스토어:
 * - orders: PK orderId, 인덱스 createdAt, [state, createdAt]
 * - requests: PK eventId, 인덱스 orderId
 */
import type { Order } from '@sajwo-tracker/shared';
import type { SponsorRequest } from './types';

const DB_NAME = 'sponsor-history';
const DB_VERSION = 1;

// ── DB 싱글턴 ────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('orders')) {
        const orderStore = db.createObjectStore('orders', { keyPath: 'orderId' });
        orderStore.createIndex('createdAt', 'createdAt');
        orderStore.createIndex('state_createdAt', ['state', 'createdAt']);
      }

      if (!db.objectStoreNames.contains('requests')) {
        const requestStore = db.createObjectStore('requests', { keyPath: 'eventId' });
        requestStore.createIndex('orderId', 'orderId');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

// ── 오더 API ─────────────────────────────────────────

/** orderId가 IDB에 존재하는지 확인한다. */
export async function idbHasOrder(orderId: string): Promise<boolean> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const req = tx.objectStore('orders').get(orderId);
    req.onsuccess = () => resolve(req.result != null);
    req.onerror = () => reject(req.error);
  });
}

/** 오더를 upsert한다. 기존 레코드의 updatedAt보다 새 값이 클 때만 갱신. */
export async function idbUpsertOrder(order: Order): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readwrite');
    const store = tx.objectStore('orders');
    const getReq = store.get(order.orderId);

    getReq.onsuccess = () => {
      const existing = getReq.result as Order | undefined;
      if (existing && existing.updatedAt >= order.updatedAt) {
        resolve();
        return;
      }
      const putReq = store.put(order);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ── 리퀘스트 API ─────────────────────────────────────

/** request를 upsert한다 (eventId PK 기준, 릴레이 중복 수신 대비). */
export async function idbUpsertRequest(request: SponsorRequest): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('requests', 'readwrite');
    const req = tx.objectStore('requests').put(request);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** orderId로 연관 request를 모두 조회한다 (orderId 인덱스 활용). */
export async function idbGetRequestsByOrderId(orderId: string): Promise<SponsorRequest[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('requests', 'readonly');
    const index = tx.objectStore('requests').index('orderId');
    const req = index.getAll(orderId);
    req.onsuccess = () => resolve(req.result as SponsorRequest[]);
    req.onerror = () => reject(req.error);
  });
}

// ── 일괄 이관 ────────────────────────────────────────

/**
 * 클레임 시점: 오더 + claim request를 단일 트랜잭션으로 원자적 저장한다.
 */
export async function idbMigrateClaim(
  order: Order,
  claimRequest: SponsorRequest,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['orders', 'requests'], 'readwrite');

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    tx.objectStore('orders').put(order);
    tx.objectStore('requests').put(claimRequest);
  });
}
