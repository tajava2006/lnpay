/**
 * 원화 송금 주장 (후원자 → 어드민)
 *
 * 라이트닝의 `remit-request`를 **그대로 쓴다.** 뜻과 모양이 같아 새 액션을
 * 만들 이유가 없고, 트랙은 `t` 태그로 갈린다(PLAN §5.2에 빠져 있던 자리).
 *
 * ⚠️ 이건 **주장일 뿐**이다. 이걸로 비트코인이 움직이지 않는다 — 고객이 은행을
 * 확인하고 서명해야 한다(O-007).
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, REQUEST_ACTIONS, SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND, getReadRelays, getSecretKey, storage,
} from '@sajwo-tracker/shared';
import { onchainMessageExpiration } from '@sajwo-tracker/shared/onchain';

export async function publishRemitRequestOnchain(orderId: string): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const signed = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.REMIT_REQUEST],
      ['t', CLIENT_TAG_ONCHAIN],
      ['p', APP_PUBKEY],
      ['expiration', String(onchainMessageExpiration(Math.floor(Date.now() / 1000)))],
    ],
    content: '',
  }, sk);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    return results.some(r => r.status === 'fulfilled');
  } finally {
    pool.destroy();
  }
}
