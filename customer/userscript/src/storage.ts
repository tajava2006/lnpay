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
 * 쓸 nsec을 고른다 — **붙여넣은 코드에 든 키가 저장된 키를 이긴다.**
 *
 * 예전엔 저장된 키가 먼저였다. 저장값은 스크립트를 덮어 붙여넣어도 남아서, 앱에서 키를 바꾸고 안내대로 코드를 다시
 * 붙여넣어도 스크립트는 옛 키로 계속 보냈다. 앱은 지금 키 앞으로 온 것만 받으니 감지된 주문이 **조용히** 사라졌다
 * (2026-10-31 실측 — 9월에 바뀐 옛 키로 한 달 넘게 발행). 자동 업데이트로 받은 코드는 키 자리가 플레이스홀더라
 * 그때만 저장값을 쓴다.
 */
export function pickNsec(
  stored: string | null,
  preloaded: string,
): { nsec: string | null; replaced: boolean } {
  if (preloaded.startsWith('nsec1')) {
    return { nsec: preloaded, replaced: stored !== null && stored !== preloaded };
  }
  return { nsec: stored, replaced: false };
}

/** 쓸 nsec을 정해 저장해 두고 돌려준다. 키가 바뀌었으면 옛 키로 처리한 주문 이력을 비운다. */
export function ensureNsec(): string | null {
  const stored = getStoredNsec();
  const { nsec, replaced } = pickNsec(stored, PRELOADED_NSEC);
  if (nsec && nsec !== stored) setStoredNsec(nsec);
  if (replaced) {
    // 옛 키로 보낸 주문은 지금 앱에 도착한 적이 없다. 이력이 남아 있으면 같은 주문 페이지를 다시 열어도
    // "이미 처리함"으로 끝나므로 비워서 새 키로 다시 보내게 한다.
    GM_setValue(KEY_PROCESSED, {});
    console.log('[사줘] 붙여넣은 코드의 키로 바꿨다 — 옛 키로 처리한 주문 이력을 비웠다');
  }
  return nsec;
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
