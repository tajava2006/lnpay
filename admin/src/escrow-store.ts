/**
 * Hold invoice 프리이미지 저장소.
 *
 * 프리이미지는 hold invoice의 settle 권한이다.
 * NIP-44로 암호화하여 localStorage에 저장하며, 릴레이에는 별도 백업한다.
 *
 * 저장 흐름:
 *   1. NIP-46 signer로 NIP-44 암호화
 *   2. localStorage에 암호문 저장 (캐시)
 *   3. NIP-78 릴레이 백업 (escrow-backup.ts)
 *
 * 조회 흐름:
 *   1. localStorage에서 암호문 로드
 *   2. NIP-46 signer로 NIP-44 복호화
 *   3. 로컬에 없으면 릴레이에서 복원 (escrow-backup.ts)
 */

import { APP_PUBKEY } from '@sajwo-tracker/shared';
import { getSigner } from './nostr/nip46';

const STORAGE_KEY = 'admin:escrow';

export interface EscrowEntry {
  /** 프리이미지 (hex) — SettleInvoice에 제출하여 BTC 수령 */
  preimage: string;
  /** payment hash (hex) — 인보이스 식별자 */
  paymentHash: string;
  /** 생성 시각 (unix seconds) */
  createdAt: number;
}

type StoredEscrowMap = Record<string, string>;

// ── 인메모리 캐시 (복호화된 상태) ──────────────────────────

let decryptedCache: Record<string, EscrowEntry> = {};
let cacheInitialized = false;

// ── 암호화/복호화 헬퍼 ──────────────────────────────────────

async function encryptEntry(entry: EscrowEntry): Promise<string> {
  const signer = getSigner();
  if (!signer) throw new Error('escrow-store: signer 없음');
  return signer.nip44Encrypt(APP_PUBKEY, JSON.stringify(entry));
}

async function decryptEntry(ciphertext: string): Promise<EscrowEntry | null> {
  const signer = getSigner();
  if (!signer) return null;
  try {
    const plaintext = await signer.nip44Decrypt(APP_PUBKEY, ciphertext);
    return JSON.parse(plaintext) as EscrowEntry;
  } catch {
    return null;
  }
}

// ── localStorage I/O ────────────────────────────────────────

function loadRawMap(): StoredEscrowMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRawMap(map: StoredEscrowMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

// ── 캐시 초기화 (signer 준비 후 1회) ───────────────────────

/**
 * localStorage의 암호문을 모두 복호화하여 인메모리 캐시에 로드한다.
 * signer가 준비된 후 호출해야 한다.
 */
export async function initEscrowCache(): Promise<void> {
  if (cacheInitialized) return;

  const rawMap = loadRawMap();
  const result: Record<string, EscrowEntry> = {};

  for (const [orderId, ciphertext] of Object.entries(rawMap)) {
    const entry = await decryptEntry(ciphertext);
    if (entry) {
      result[orderId] = entry;
    }
  }

  decryptedCache = result;
  cacheInitialized = true;
  console.log('[Escrow] Cache initialized:', Object.keys(result).length, 'entries');
}

// ── Public API ──────────────────────────────────────────────

/**
 * 프리이미지를 NIP-44 암호화하여 저장한다.
 * hold invoice 생성 시 LN 어댑터에서 호출된다.
 *
 * @returns 저장된 EscrowEntry (릴레이 백업에 활용)
 */
export async function savePreimage(
  orderId: string,
  preimage: string,
  paymentHash: string,
): Promise<EscrowEntry> {
  const entry: EscrowEntry = {
    preimage,
    paymentHash,
    createdAt: Math.floor(Date.now() / 1000),
  };

  // 1. NIP-44 암호화 → localStorage
  const ciphertext = await encryptEntry(entry);
  const rawMap = loadRawMap();
  rawMap[orderId] = ciphertext;
  saveRawMap(rawMap);

  // 2. 인메모리 캐시 갱신
  decryptedCache[orderId] = entry;

  return entry;
}

/** orderId로 프리이미지를 조회한다. 캐시에 없으면 null. */
export function getPreimage(orderId: string): string | null {
  return decryptedCache[orderId]?.preimage ?? null;
}

/** orderId로 전체 에스크로 엔트리를 조회한다. */
export function getEscrowEntry(orderId: string): EscrowEntry | null {
  return decryptedCache[orderId] ?? null;
}

/** 전체 에스크로 맵의 스냅샷을 반환한다 (릴레이 백업용). */
export function getAllEntries(): Record<string, EscrowEntry> {
  return { ...decryptedCache };
}

/** 지정된 orderId 목록의 에스크로 엔트리를 삭제한다. */
export function purgeByOrderIds(orderIds: string[]): void {
  let changed = false;

  // 인메모리 캐시에서 삭제
  for (const id of orderIds) {
    if (id in decryptedCache) {
      delete decryptedCache[id];
      changed = true;
    }
  }

  // localStorage에서 삭제
  if (changed) {
    const rawMap = loadRawMap();
    for (const id of orderIds) {
      delete rawMap[id];
    }
    saveRawMap(rawMap);
  }
}

/**
 * 릴레이에서 복원된 엔트리를 로컬 캐시 + localStorage에 병합한다.
 * escrow-backup.ts에서 릴레이 복원 후 호출.
 */
export async function mergeRestoredEntries(
  entries: Record<string, EscrowEntry>,
): Promise<void> {
  const rawMap = loadRawMap();
  let changed = false;

  for (const [orderId, entry] of Object.entries(entries)) {
    if (orderId in decryptedCache) continue; // 이미 있으면 스킵

    try {
      rawMap[orderId] = await encryptEntry(entry);
      decryptedCache[orderId] = entry;
      changed = true;
    } catch (e) {
      console.warn('[Escrow] Failed to encrypt restored entry for', orderId, e);
    }
  }

  if (changed) {
    saveRawMap(rawMap);
    console.log('[Escrow] Merged restored entries from relay');
  }
}
