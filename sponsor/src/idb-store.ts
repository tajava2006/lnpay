/**
 * Sponsor IndexedDB 저장소 (히스토리 장기 보존)
 *
 * 클레임 시점부터 오더와 관련 request를 영구 보존한다.
 * 구독 시 IDB에 이미 있는 오더만 업데이트, 없으면 무시.
 *
 * 오브젝트 스토어:
 * - orders: PK orderId, 인덱스 createdAt, [state, createdAt]
 * - requests: PK eventId, 인덱스 orderId
 * - messages: PK eventId, 인덱스 orderId, createdAt, [orderId, createdAt] (v2)
 */
import type { Order, ChatMessage } from '@sajwo-tracker/shared';
import type { SponsorRequest } from './types';

const DB_NAME = 'sponsor-history';
const DB_VERSION = 2;

// ── DB 싱글턴 ────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

      if (oldVersion < 1) {
        const orderStore = db.createObjectStore('orders', { keyPath: 'orderId' });
        orderStore.createIndex('createdAt', 'createdAt');
        orderStore.createIndex('state_createdAt', ['state', 'createdAt']);

        const requestStore = db.createObjectStore('requests', { keyPath: 'eventId' });
        requestStore.createIndex('orderId', 'orderId');
      }

      if (oldVersion < 2) {
        const msgStore = db.createObjectStore('messages', { keyPath: 'eventId' });
        msgStore.createIndex('orderId', 'orderId');
        msgStore.createIndex('createdAt', 'createdAt');
        msgStore.createIndex('orderId_createdAt', ['orderId', 'createdAt']);
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

// ── 메시지 API (분쟁 채팅) ────────────────────────────

/** 채팅 메시지를 upsert한다 (eventId PK 기준, 중복 수신 대비). */
export async function idbUpsertMessage(msg: ChatMessage): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const req = tx.objectStore('messages').put(msg);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** orderId로 연관 채팅 메시지를 모두 조회한다 (createdAt 오름차순). */
export async function idbGetMessagesByOrderId(orderId: string): Promise<ChatMessage[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const index = tx.objectStore('messages').index('orderId_createdAt');
    const range = IDBKeyRange.bound([orderId], [orderId, Number.MAX_SAFE_INTEGER]);
    const req = index.getAll(range);
    req.onsuccess = () => resolve(req.result as ChatMessage[]);
    req.onerror = () => reject(req.error);
  });
}

// ── 히스토리 페이지네이션 ─────────────────────────────

/** IDB 오더를 createdAt 내림차순으로 페이지네이션 조회한다. */
export async function idbGetOrdersPage(
  cursor?: number,
  limit: number = 20,
): Promise<Order[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const index = tx.objectStore('orders').index('createdAt');
    const range = cursor != null
      ? IDBKeyRange.upperBound(cursor, true)
      : undefined;
    const results: Order[] = [];

    const req = index.openCursor(range, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c || results.length >= limit) {
        resolve(results);
        return;
      }
      results.push(c.value as Order);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
