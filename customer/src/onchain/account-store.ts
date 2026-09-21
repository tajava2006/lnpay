/**
 * 후원자가 받은 계좌 정보 (온체인 트랙)
 *
 * 계좌는 **고객이 후원자에게 직접** NIP-44로 보낸다 — 어드민도 못 본다(§5.3).
 * 그래서 이 스토어는 후원자 쪽에만 찬다.
 *
 * ⚠️ 이게 없으면 후원자는 **어디로 원화를 보낼지 모른 채** 마감 시계만 흐른다.
 * 실제로 그랬다(2026-09-21) — 수신 핸들러가 `account-info`를 안 다뤄서
 * 이벤트가 조용히 버려졌다.
 */
import type { AccountInfo } from '@sajwo-tracker/shared';

const STORAGE_KEY = 'onchain:account-info';

type AccountMap = Record<string, AccountInfo>;
type Listener = () => void;

function load(): AccountMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AccountMap) : {};
  } catch {
    return {};
  }
}

let accounts: AccountMap = load();
const listeners = new Set<Listener>();

export function subscribeOnchainAccounts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOnchainAccountsSnapshot(): Readonly<AccountMap> {
  return accounts;
}

export function getOnchainAccount(orderId: string): AccountInfo | undefined {
  return accounts[orderId];
}

/**
 * 먼저 온 것을 유지한다 — 계좌가 나간 뒤 바뀌면 **후원자가 이미 본 계좌와
 * 달라져** 원화가 엉뚱한 곳으로 가거나 입금이 확인되지 않는다.
 */
export function putOnchainAccount(orderId: string, info: AccountInfo): void {
  if (accounts[orderId]) return;
  accounts = { ...accounts, [orderId]: info };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  for (const l of listeners) l();
}

/** @testing-only */
export function _resetForTesting(): void {
  accounts = {};
  localStorage.removeItem(STORAGE_KEY);
}
