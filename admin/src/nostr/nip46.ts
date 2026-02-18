/**
 * NIP-46 원격 서명 세션 관리
 *
 * Client-initiated 플로우:
 *   클라이언트가 nostrconnect:// URI를 생성 → QR 코드로 표시
 *   → 벙커가 스캔하여 연결 수립 → 신원 검증(get_public_key + sign challenge)
 *   → 세션 정보를 localStorage에 저장
 *
 * 재방문 플로우:
 *   localStorage에서 세션 로드 → fromBunker()로 통신 채널 복원 (connect RPC 불필요)
 *   → verifyIdentity()로 챌린지 재검증 (벙커 생존 + 신원 확인)
 *   → 실패 시 세션 삭제 → 로그인 화면
 *
 * 보안:
 *   일반 NIP-46과 달리 특정 pubkey(APP_PUBKEY)만 허용해야 하므로,
 *   get_public_key 결과만으로는 불충분하다 (벙커 통신키로만 서명됨).
 *   sign_event 챌린지로 실제 신원키의 proof-of-possession을 수행한다.
 */
import { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';
import type { BunkerPointer } from 'nostr-tools/nip46';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/core';
import { APP_PUBKEY } from '@sajwo-tracker/shared';

const SESSION_KEY = 'admin:nip46';

export interface Nip46Session {
  clientSecretKeyHex: string;   // 클라이언트 통신용 비밀키
  bunkerPubkey: string;         // 벙커의 통신용 pubkey
  relays: string[];             // 통신에 사용된 릴레이
}

// ─── 모듈 레벨 signer 인스턴스 ──────────────────────────────

let currentSigner: BunkerSigner | null = null;

// ─── Hex 유틸리티 ───────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ─── 세션 CRUD ──────────────────────────────────────────────

export function hasSession(): boolean {
  return localStorage.getItem(SESSION_KEY) !== null;
}

export function loadSession(): Nip46Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Nip46Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Nip46Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  if (currentSigner) {
    try { currentSigner.close(); } catch { /* 이미 닫힌 경우 무시 */ }
    currentSigner = null;
  }
}

// ─── Signer 접근 (향후 이벤트 서명/암호화에 사용) ────────────

export function getSigner(): BunkerSigner | null {
  return currentSigner;
}

// ─── 로그인 플로우 ──────────────────────────────────────────

/**
 * nostrconnect:// URI와 클라이언트 키를 생성한다.
 * LoginScreen에서 QR 코드로 표시할 URI를 만든다.
 */
export function createLoginContext(relays: string[]): {
  uri: string;
  clientSecretKey: Uint8Array;
} {
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const secret = crypto.randomUUID();

  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret,
    perms: ['sign_event', 'get_public_key', 'nip44_encrypt', 'nip44_decrypt'],
    name: '사줘 트래커 어드민',
  });

  return { uri, clientSecretKey };
}

/**
 * 벙커의 연결 응답을 대기한다.
 * BunkerSigner.fromURI()는 벙커가 QR 코드를 스캔할 때까지 블록된다.
 */
export async function waitForConnection(
  clientSecretKey: Uint8Array,
  uri: string,
  signal: AbortSignal,
): Promise<BunkerSigner> {
  return BunkerSigner.fromURI(clientSecretKey, uri, {}, signal);
}

// ─── 신원 검증 ──────────────────────────────────────────────

/**
 * 벙커가 APP_PUBKEY의 실제 소유자인지 검증한다.
 *
 * 1. get_public_key — 벙커가 주장하는 신원 확인 (빠른 실패용)
 * 2. sign_event 챌린지 — 반환된 서명의 pubkey가 APP_PUBKEY인지 검증
 *    (nostr-tools가 서명 유효성은 이미 검증하므로 pubkey 일치만 추가 확인)
 */
export async function verifyIdentity(signer: BunkerSigner): Promise<void> {
  // Step 1: get_public_key — 빠른 실패
  const claimedPubkey = await signer.getPublicKey();
  if (claimedPubkey !== APP_PUBKEY) {
    throw new Error(
      `신원 불일치: 벙커가 반환한 pubkey(${claimedPubkey.slice(0, 12)}...)가 ` +
      `APP_PUBKEY(${APP_PUBKEY.slice(0, 12)}...)와 다릅니다.`,
    );
  }

  // Step 2: sign_event 챌린지 — proof of possession
  const challenge: EventTemplate = {
    kind: 22242,
    content: crypto.randomUUID(),
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
  };

  const signed = await signer.signEvent(challenge);
  // nostr-tools의 signEvent()가 verifyEvent()를 내부적으로 호출하므로
  // 서명 유효성은 이미 보장됨. pubkey 일치만 추가 확인.
  if (signed.pubkey !== APP_PUBKEY) {
    throw new Error(
      `신원 검증 실패: 서명된 이벤트의 pubkey(${signed.pubkey.slice(0, 12)}...)가 ` +
      `APP_PUBKEY(${APP_PUBKEY.slice(0, 12)}...)와 다릅니다.`,
    );
  }
}

// ─── 세션 복원 ──────────────────────────────────────────────

/**
 * 저장된 세션으로 BunkerSigner를 복원한다.
 * connect() RPC 없이 통신 채널만 설정한다 (이미 인가된 클라이언트 키).
 * 이후 verifyIdentity()를 호출하여 벙커 생존 + 신원을 재검증해야 한다.
 */
export function restoreSigner(session: Nip46Session): BunkerSigner {
  const clientSecretKey = hexToBytes(session.clientSecretKeyHex);
  const bp: BunkerPointer = {
    pubkey: session.bunkerPubkey,
    relays: session.relays,
    secret: null,
  };

  const signer = BunkerSigner.fromBunker(clientSecretKey, bp);
  currentSigner = signer;
  return signer;
}

// ─── 전체 로그인 완료 처리 ──────────────────────────────────

/**
 * 로그인 성공 후 세션 저장 + signer 등록을 한 번에 처리한다.
 */
export function finalizeLogin(signer: BunkerSigner, clientSecretKey: Uint8Array): void {
  currentSigner = signer;
  saveSession({
    clientSecretKeyHex: bytesToHex(clientSecretKey),
    bunkerPubkey: signer.bp.pubkey,
    relays: signer.bp.relays,
  });
}
