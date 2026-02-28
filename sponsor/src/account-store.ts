/**
 * 반응형 계좌정보 스토어
 *
 * Sponsor가 수신한 복호화된 계좌정보를 메모리에 보관하고,
 * useSyncExternalStore로 UI에 자동 전파한다.
 *
 * 영구 저장은 IDB에 위임 (idb-store.ts의 request로 저장).
 * 이 스토어는 앱 세션 동안 UI 연동용으로만 사용한다.
 */
import type { AccountInfo } from '@sajwo-tracker/shared';

type AccountInfoMap = Record<string, AccountInfo>;
type Listener = () => void;

let accountInfos: AccountInfoMap = {};
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// ── useSyncExternalStore 호환 API ──────────────────

export function subscribeAccountInfo(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAccountInfoSnapshot(): AccountInfoMap {
  return accountInfos;
}

// ── 뮤테이션 API ───────────────────────────────────

/** orderId에 대한 계좌정보를 설정한다. */
export function setAccountInfo(orderId: string, info: AccountInfo): void {
  if (accountInfos[orderId]) return; // 이미 설정됨 (중복 수신 방지)
  accountInfos = { ...accountInfos, [orderId]: info };
  notify();
}

/** orderId에 대한 계좌정보를 조회한다. */
export function getAccountInfo(orderId: string): AccountInfo | undefined {
  return accountInfos[orderId];
}
