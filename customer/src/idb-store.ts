/**
 * Customer IndexedDB 저장소 (분쟁 채팅 증거 보존)
 *
 * Customer의 오더/리퀘스트는 기존 localStorage 유지.
 * IDB는 분쟁 채팅 메시지만 영구 보존한다.
 *
 * 오브젝트 스토어:
 * - messages: PK eventId, 인덱스 orderId, createdAt, [orderId, createdAt]
 */
import type { ChatMessage } from '@sajwo-tracker/shared';

const DB_NAME = 'customer-history';
const DB_VERSION = 1;

// ── DB 싱글턴 ────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const msgStore = db.createObjectStore('messages', { keyPath: 'eventId' });
      msgStore.createIndex('orderId', 'orderId');
      msgStore.createIndex('createdAt', 'createdAt');
      msgStore.createIndex('orderId_createdAt', ['orderId', 'createdAt']);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
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
