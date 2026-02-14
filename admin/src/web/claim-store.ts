/**
 * 반응형 클레임 스토어
 *
 * Nostr 서비스 → claim-store → localStorage + listeners
 * ClaimInbox → useSyncExternalStore(subscribe, getSnapshot) → 자동 리렌더
 */
import type { ClaimEvent, AdminClaimStatus } from './types';

type ClaimMap = Record<string, ClaimEvent>;
type Listener = () => void;

const CLAIMS_KEY = 'admin:claims';

// ── 내부 상태 ──────────────────────────────────────

let claims: ClaimMap = loadFromStorage();
let synced = false;
const listeners = new Set<Listener>();

// ── localStorage 입출력 ────────────────────────────

function loadFromStorage(): ClaimMap {
  const stored = localStorage.getItem(CLAIMS_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as ClaimMap;
  } catch {
    return {};
  }
}

function saveToStorage(): void {
  localStorage.setItem(CLAIMS_KEY, JSON.stringify(claims));
}

// ── 리스너 통지 ────────────────────────────────────

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): ClaimMap {
  return claims;
}

export function getSyncedSnapshot(): boolean {
  return synced;
}

// ── 뮤테이션 API ───────────────────────────────────

/**
 * 클레임을 추가한다. 같은 ID의 클레임이 이미 있으면 무시.
 */
export function upsertClaim(claim: ClaimEvent): boolean {
  const existing = claims[claim.id];
  if (existing) return false; // 이미 존재하면 덮어쓰지 않음 (상태 보존)

  claims = { ...claims, [claim.id]: claim };
  saveToStorage();
  notify();
  return true;
}

/**
 * 클레임 상태를 변경한다 (승인/거절).
 */
export function updateClaimStatus(claimId: string, status: AdminClaimStatus): boolean {
  const claim = claims[claimId];
  if (!claim) return false;

  claims = { ...claims, [claimId]: { ...claim, status } };
  saveToStorage();
  notify();
  return true;
}

export function markSynced(): void {
  synced = true;
  notify();
}
