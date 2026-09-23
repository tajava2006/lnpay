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

const OPERATOR_KEY = 'admin:onchain-operator-pubkey';
const DISPUTE_SOON_KEY = 'admin:onchain-dispute-soon-sent';

/**
 * 운영자에게 알림을 보낼 nostr pubkey (hex). 비어 있으면 안 보낸다.
 *
 * ── 왜 필요한가 (리뷰 #8)
 *
 * §7.3 ③은 "침묵 공격은 어드민이 와야만 깨진다 — `disputed` 진입 즉시 어드민에게
 * 알린다"를 방어의 일부로 적었다. 그런데 어드민은 브라우저 탭이고 **어드민에게 가는
 * 알림이 하나도 없었다.** 경보는 탭을 열어야 보였다. 유저 알림과 같은 NIP-17 경로로
 * 운영자의 평소 nostr 클라이언트(예: Amethyst)에 보낸다.
 */
export function getOnchainOperatorPubkey(): string | undefined {
  const raw = localStorage.getItem(OPERATOR_KEY);
  return raw && /^[0-9a-f]{64}$/.test(raw) ? raw : undefined;
}

export function setOnchainOperatorPubkey(pubkey: string): void {
  const trimmed = pubkey.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(trimmed)) localStorage.setItem(OPERATOR_KEY, trimmed);
  else localStorage.removeItem(OPERATOR_KEY);
}

/**
 * 분쟁 임박 알림을 **이미 보냈는가** — 주문당 한 번만 보낸다.
 *
 * 전에는 마감 2시간 전부터 워처가 매 틱(30초) 경고를 내고 그때마다 푸시가 나가서
 * 고객에게 **240번** 울렸다(리뷰 #8). 그러면 유저는 알림을 끄고, 정작 중요한 알림도
 * 못 받는다.
 */
export function claimDisputeSoonNotice(orderId: string): boolean {
  let sent: string[] = [];
  try {
    sent = JSON.parse(localStorage.getItem(DISPUTE_SOON_KEY) ?? '[]') as string[];
  } catch {
    sent = [];
  }
  if (sent.includes(orderId)) return false;
  // 오래된 것은 버린다 — 주문 id는 다시 안 쓰이므로 최근 것만 있으면 된다.
  localStorage.setItem(DISPUTE_SOON_KEY, JSON.stringify([...sent.slice(-499), orderId]));
  return true;
}
