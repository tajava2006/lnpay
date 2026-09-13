/**
 * 공통 IndexedDB 저장소
 *
 * 3개 앱(customer, sponsor, admin)이 동일한 스키마를 사용한다.
 * DB 이름만 앱별로 다르며, initIdb()로 초기화한다.
 *
 * 오브젝트 스토어:
 * - orders: PK orderId, 인덱스 createdAt, [state, createdAt]
 * - requests: PK eventId, 인덱스 orderId
 * - messages: PK eventId, 인덱스 orderId, createdAt, [orderId, createdAt]
 */
import type { Order, Request, ChatMessage } from './types';

/**
 * DB 버전 2: 기존 앱별 DB를 통합 스키마로 마이그레이션한다.
 * - customer v1 (messages만) → orders, requests 스토어 추가
 * - sponsor/admin v2 (전체 스토어) → 변경 없음 (이미 동일 스키마)
 * - 신규 설치 → 전체 스토어 생성
 */
const DB_VERSION = 2;

// ── DB 싱글턴 ────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * 앱 진입점(main.tsx)에서 최초 1회 호출한다.
 * 기존 앱별 DB 이름을 그대로 사용하여 데이터를 보존한다.
 */
export function initIdb(dbName: string): void {
  if (dbPromise) return;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);

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

      if (!db.objectStoreNames.contains('messages')) {
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
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) throw new Error('initIdb()를 먼저 호출해야 합니다.');
  return dbPromise;
}

// ── 오더 API ─────────────────────────────────────────

/** orderId로 오더를 단건 조회한다. */
export async function idbGetOrder(orderId: string): Promise<Order | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const req = tx.objectStore('orders').get(orderId);
    req.onsuccess = () => resolve((req.result as Order) ?? null);
    req.onerror = () => reject(req.error);
  });
}

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
export async function idbUpsertRequest(request: Request): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('requests', 'readwrite');
    const req = tx.objectStore('requests').put(request);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** orderId로 연관 request를 모두 조회한다 (orderId 인덱스 활용). */
export async function idbGetRequestsByOrderId(orderId: string): Promise<Request[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('requests', 'readonly');
    const index = tx.objectStore('requests').index('orderId');
    const req = index.getAll(orderId);
    req.onsuccess = () => resolve(req.result as Request[]);
    req.onerror = () => reject(req.error);
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
/** 메시지 1건을 지운다. 실패한 전송을 재시도할 때 옛 항목 제거용. */
export async function idbDeleteMessage(eventId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore('messages').delete(eventId);
  });
}

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

// ── 일괄 이관 ────────────────────────────────────────

/**
 * 오더 1건 + 연관 request N건을 단일 트랜잭션으로 원자적 저장한다.
 * Sponsor: 클레임 시점(1건), Admin: 오더 생성/escrowed 시점(N건).
 */
export async function idbMigrateOrderWithRequests(
  order: Order,
  requests: Request[],
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['orders', 'requests'], 'readwrite');

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    tx.objectStore('orders').put(order);
    const reqStore = tx.objectStore('requests');
    for (const req of requests) {
      reqStore.put(req);
    }
  });
}

// ── GC ───────────────────────────────────────────────

/**
 * "방치된 채 만료된 오더"인가 — GC 대상 판정.
 *
 * 정의: 만료됐고, 상태가 `requested`에 머물러 있고, 그 오더에 달린 요청이
 * 최초 등록(order-request / parsed-order)뿐인 것. 즉 오더북에 올라왔다가
 * **아무도 손대지 않고** 기한이 지난 건이다.
 *
 * `state === 'requested'`만으로 판단하지 않는 이유: FSM에 `claimed → requested`
 * 역전이가 있다(유동성 검증 실패 시 revertClaim). 그렇게 되돌아온 오더는
 * 상태는 requested지만 후원자가 붙었다 거절된 기록이고 보증금이 걸렸을 수도
 * 있어 쓰레기가 아니다. 부가 요청 유무로 그 둘을 가른다.
 *
 * IDB 없이 검증할 수 있도록 순수 함수로 둔다.
 */
export function isAbandonedOrder(
  order: Order,
  requests: Request[],
  nowSeconds: number,
): boolean {
  if (order.state !== 'requested') return false;
  if (order.expiration <= 0 || order.expiration > nowSeconds) return false;

  // 최초 등록 외의 요청이 하나라도 있으면 누군가 손댄 것이다.
  return !requests.some(r => r.action !== 'order-request' && r.action !== 'parsed-order');
}

/** 방치된 채 만료된 오더를 IDB에서 찾는다. 판정은 isAbandonedOrder가 한다. */
export async function idbFindAbandonedOrders(nowSeconds: number): Promise<Order[]> {
  const db = await openDb();

  // 만료 + requested만 1차로 거른 뒤(값싼 조건) 요청을 조회한다.
  const candidates = await new Promise<Order[]>((resolve, reject) => {
    const tx = db.transaction('orders', 'readonly');
    const req = tx.objectStore('orders').getAll();
    req.onsuccess = () => {
      const all = req.result as Order[];
      resolve(all.filter(o =>
        o.state === 'requested' && o.expiration > 0 && o.expiration <= nowSeconds,
      ));
    };
    req.onerror = () => reject(req.error);
  });

  const abandoned: Order[] = [];
  for (const order of candidates) {
    const requests = await idbGetRequestsByOrderId(order.orderId);
    if (isAbandonedOrder(order, requests, nowSeconds)) abandoned.push(order);
  }
  return abandoned;
}

/** 오더와 그에 달린 요청·메시지를 단일 트랜잭션으로 지운다. */
export async function idbDeleteOrders(orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const db = await openDb();
  const targets = new Set(orderIds);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['orders', 'requests', 'messages'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    const orders = tx.objectStore('orders');
    for (const id of orderIds) orders.delete(id);

    // requests/messages는 orderId 인덱스로 커서를 돌며 지운다
    for (const storeName of ['requests', 'messages'] as const) {
      const idx = tx.objectStore(storeName).index('orderId');
      const cursorReq = idx.openCursor();
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return;
        if (targets.has((c.value as { orderId: string }).orderId)) c.delete();
        c.continue();
      };
    }
  });
}
