/**
 * 구독 정보를 어드민에게 등록한다.
 *
 * 서버가 없으니 기존 요청 이벤트 통로를 그대로 쓴다. 내용은 NIP-44로 어드민에게만
 * 열리게 암호화한다 — 엔드포인트와 인증 시크릿이 공개되면 아무나 이 유저에게
 * 푸시를 쏠 수 있다(VAPID는 발신자를 제한할 뿐, 엔드포인트 자체는 비밀이어야 한다).
 *
 * **주문에 묶지 않는다.** 구독은 계정 단위이고 주문보다 오래 산다. 그래서
 * a-tag를 달지 않고 expiration도 두지 않는다 — 주문 만료와 함께 사라지면
 * 다음 거래 때 알림이 조용히 끊긴다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import type { EventTemplate } from 'nostr-tools/core';
import {
  APP_PUBKEY,
  CLIENT_TAG,
  MESSAGE_KIND,
  REQUEST_ACTIONS,
  getReadRelays,
  getSecretKey,
  storage, nowSec,
} from '@sajwo-tracker/shared';
import type { PushSubscriptionPayload } from './subscribe';

/** 어드민에 등록한다. 한 릴레이라도 받으면 성공. */
export async function publishPushSubscription(
  sub: PushSubscriptionPayload,
): Promise<boolean> {
  const [sk, relays] = await Promise.all([
    getSecretKey(storage),
    getReadRelays(storage),
  ]);

  const ciphertext = nip44Encrypt(
    JSON.stringify(sub),
    getConversationKey(sk, APP_PUBKEY),
  );

  const template: EventTemplate = {
    kind: MESSAGE_KIND,
    created_at: nowSec(),
    tags: [
      ['action', REQUEST_ACTIONS.PUSH_SUBSCRIPTION],
      ['t', CLIENT_TAG],
      ['p', APP_PUBKEY],
    ],
    content: ciphertext,
  };

  const signed = finalizeEvent(template, sk);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    console.log(ok ? '[Push] 구독 등록 발행' : '[Push] 구독 등록 실패');
    return ok;
  } finally {
    pool.destroy();
  }
}
