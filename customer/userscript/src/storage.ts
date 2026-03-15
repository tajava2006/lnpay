/**
 * GM_storage 래퍼
 *
 * Tampermonkey의 GM_getValue/GM_setValue를 타입 안전하게 사용한다.
 * 처리된 주문, Nostr 키, 릴레이 캐시를 관리한다.
 */

declare function GM_getValue<T>(key: string, defaultValue: T): T;
declare function GM_setValue(key: string, value: unknown): void;

// ── 키 관리 ─────────────────────────────────────────

/**
 * 빌드 시점에는 빈 문자열. 고객앱이 fetch 후 실제 nsec로 치환하여 표시한다.
 * 플레이스홀더 문자열은 치환 대상 마커로만 사용된다.
 */
const PRELOADED_NSEC = '%%NSEC_PLACEHOLDER%%';

const KEY_NSEC = 'sajwo:nsec';

export function getStoredNsec(): string | null {
  return GM_getValue<string | null>(KEY_NSEC, null);
}

export function setStoredNsec(nsec: string): void {
  GM_setValue(KEY_NSEC, nsec);
}

/**
 * 저장된 nsec 또는 고객앱이 주입한 nsec를 반환한다.
 * (과거에는 prompt()로 수동 입력을 받았으나, 고객앱이 코드 복사 시점에 자동 치환하므로 제거함)
 */
export function ensureNsec(): string | null {
  const stored = getStoredNsec();
  if (stored) return stored;

  if (PRELOADED_NSEC.startsWith('nsec1')) {
    setStoredNsec(PRELOADED_NSEC);
    return PRELOADED_NSEC;
  }

  return null;
}

// ── 처리된 주문 관리 ────────────────────────────────

type OrderStatus = 'parsed' | 'paid' | 'cancelled';

interface ProcessedEntry {
  status: OrderStatus;
  /** 오더 만료 시각 (Unix seconds). 후속 이벤트(payment-confirm 등)에 expiration 태그로 사용. */
  expiration: number;
}

type ProcessedOrders = Record<string, ProcessedEntry>;

const KEY_PROCESSED = 'sajwo:processed-orders';

export function getProcessedOrders(): ProcessedOrders {
  const raw = GM_getValue<Record<string, unknown>>(KEY_PROCESSED, {});
  const result: ProcessedOrders = {};
  for (const [id, val] of Object.entries(raw)) {
    if (typeof val === 'string') {
      // 하위 호환: 이전 형식(상태 문자열만 저장)
      result[id] = { status: val as OrderStatus, expiration: 0 };
    } else {
      result[id] = val as ProcessedEntry;
    }
  }
  return result;
}

export function markProcessed(orderId: string, status: OrderStatus, expiration: number): void {
  const orders = getProcessedOrders();
  orders[orderId] = { status, expiration };
  GM_setValue(KEY_PROCESSED, orders);
}

// ── 릴레이 캐시 ─────────────────────────────────────

interface CachedRelays {
  relays: string[];
  fetchedAt: number;
}

const KEY_RELAYS = 'sajwo:relays';
const RELAY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

export function getCachedRelays(): string[] | null {
  const cached = GM_getValue<CachedRelays | null>(KEY_RELAYS, null);
  if (!cached) return null;

  if (Date.now() - cached.fetchedAt > RELAY_CACHE_TTL) return null;

  return cached.relays;
}

export function setCachedRelays(relays: string[]): void {
  GM_setValue(KEY_RELAYS, { relays, fetchedAt: Date.now() });
}
