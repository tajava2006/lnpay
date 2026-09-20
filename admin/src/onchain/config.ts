/**
 * 온체인 트랙 설정 (PLAN-ONCHAIN-TRACK §1.2)
 *
 * **기본값은 꺼짐이다.** 라이트닝 트랙은 지금 실제 돈이 돌고 있고, 온체인은
 * 독립적으로 붙였다 뗐다 할 수 있어야 한다. 켜는 것은 명시적 행동이어야 한다.
 *
 * 네트워크를 갈아끼울 수 있어야 **signet 드릴**을 돌린다(§11 P6). 엔드포인트도
 * 마찬가지다 — 공개 mempool.space가 우리 IP를 차단한 적이 있다(2026-09-04).
 */
import type { ChainNetwork } from '@sajwo-tracker/shared/onchain';

const ENABLED_KEY = 'admin:onchain-enabled';
const NETWORK_KEY = 'admin:onchain-network';
const BASE_URL_KEY = 'admin:onchain-base-url';

export function isOnchainEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) === 'true';
}

export function setOnchainEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, String(enabled));
}

export function getOnchainNetwork(): ChainNetwork {
  const raw = localStorage.getItem(NETWORK_KEY);
  return raw === 'mainnet' || raw === 'signet' || raw === 'testnet' ? raw : 'signet';
}

/**
 * ⚠️ 네트워크를 바꾸면 **이미 발행된 주소가 다른 체인의 것이 된다.**
 * 진행 중인 주문이 있는 채로 바꾸면 안 된다 — 호출부가 막는다.
 */
export function setOnchainNetwork(network: ChainNetwork): void {
  localStorage.setItem(NETWORK_KEY, network);
}

export function getOnchainBaseUrl(): string | undefined {
  return localStorage.getItem(BASE_URL_KEY) || undefined;
}

export function setOnchainBaseUrl(url: string): void {
  if (url) localStorage.setItem(BASE_URL_KEY, url);
  else localStorage.removeItem(BASE_URL_KEY);
}
