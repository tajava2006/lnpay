/**
 * 내 주문별 온체인 키
 *
 * 어드민과 달리 **저장하지 않는다.** nostr 키에서 결정론적으로 파생되므로
 * 언제든 다시 만들 수 있고, 저장하면 잃을 거리만 늘어난다.
 *
 * ⚠️ 그래서 브라우저 데이터가 날아가도 **nostr 키만 있으면 에스크로를 다시 열 수 있다.** 거꾸로 nostr 키를
 * 잃으면 진행 중 거래의 환불·타임락 회수 서명이 불가능하다(RISKS R-1).
 *
 * 인메모리 캐시만 둔다. 파생은 HMAC 한 번이라 싸지만, 한 화면에서 여러 번
 * 부르는 자리가 있어 왕복을 줄인다.
 */
import { getSecretKey, storage } from '@sajwo-tracker/shared';
import { deriveOrderKey, type OrderKey } from '@sajwo-tracker/shared/onchain';

const cache = new Map<string, OrderKey>();

export async function myOrderKey(orderId: string): Promise<OrderKey> {
  const cached = cache.get(orderId);
  if (cached) return cached;

  const sk = await getSecretKey(storage);
  const key = await deriveOrderKey(sk, orderId);
  cache.set(orderId, key);
  return key;
}

export async function myOrderXonly(orderId: string): Promise<string> {
  return (await myOrderKey(orderId)).xonly;
}

/** @testing-only */
export function _clearKeyCache(): void {
  cache.clear();
}
