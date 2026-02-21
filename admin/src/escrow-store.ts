/**
 * Hold invoice 프리이미지 저장소.
 *
 * 프리이미지는 hold invoice의 settle 권한이다.
 * Admin localStorage에만 저장하며, 릴레이에는 절대 노출하지 않는다.
 */

const STORAGE_KEY = 'admin:escrow';

interface EscrowEntry {
  /** 프리이미지 (hex) — SettleInvoice에 제출하여 BTC 수령 */
  preimage: string;
  /** payment hash (hex) — 인보이스 식별자 */
  paymentHash: string;
  /** 생성 시각 (unix seconds) */
  createdAt: number;
}

let escrows: Record<string, EscrowEntry> = loadFromStorage();

function loadFromStorage(): Record<string, EscrowEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveToStorage(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(escrows));
}

/**
 * 프리이미지를 orderId 키로 저장한다.
 * hold invoice 생성 시 LND 어댑터에서 호출된다.
 */
export function savePreimage(orderId: string, preimage: string, paymentHash: string): void {
  escrows = {
    ...escrows,
    [orderId]: {
      preimage,
      paymentHash,
      createdAt: Math.floor(Date.now() / 1000),
    },
  };
  saveToStorage();
}

/** orderId로 프리이미지를 조회한다. 없으면 null. */
export function getPreimage(orderId: string): string | null {
  return escrows[orderId]?.preimage ?? null;
}

/** orderId로 전체 에스크로 엔트리를 조회한다. */
export function getEscrowEntry(orderId: string): EscrowEntry | null {
  return escrows[orderId] ?? null;
}
