/**
 * Sponsor → Admin 요청 이벤트 발행
 *
 * - claim: kind 1111로 클레임 요청을 발행한다.
 * - remit-request: 원화 송금 완료 통보를 발행한다.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import {
  SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND,
  CLIENT_TAG,
  APP_PUBKEY,
  REQUEST_ACTIONS,
  getSecretKey,
  getReadRelays,
  nip44Encrypt,
  type Order,
  type DisputeMessagePayload,
  storage,
  idbMigrateOrderWithRequests,
  idbGetRequestsByOrderId,
  type ClaimRequest,
  type AccountInfoRequest,
  type PreparedChatMessage,
} from '@sajwo-tracker/shared';

/**
 * 특정 오더에 대해 클레임 이벤트를 발행한다.
 * 성공 시 오더와 클레임 request를 IDB에 원자적으로 이관한다.
 *
 * Tags:
 *   ['a', '30402:<APP_PUBKEY>:<orderId>']  - Admin 오더 참조
 *   ['action', 'claim']                    - 요청 종류
 *   ['p', APP_PUBKEY]                      - Admin 디스커버리용
 *   ['t', CLIENT_TAG]                      - 클라이언트 식별
 *   ['bolt11', invoice]                    - 유동성 검증용 인보이스
 *   ['expiration', ...]                    - 오더 만료 시각
 */
export async function publishClaim(order: Order, bolt11: string): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const relays = await getReadRelays(storage);

  const aCoord = `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`;
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ['a', aCoord],
    ['action', 'claim'],
    ['p', APP_PUBKEY],
    ['t', CLIENT_TAG],
    ['bolt11', bolt11],
  ];

  if (order.expiration > 0) {
    tags.push(['expiration', String(order.expiration)]);
  }

  const template = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: now,
    tags,
    content: '',
  };

  const signed = finalizeEvent(template, sk);

  console.log('[Nostr] Publishing claim for order', order.orderId, 'event:', signed.id);

  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    for (const r of results) {
      if (r.status === 'fulfilled') {
        console.log('[Nostr] Claim published to:', r.value);
      } else {
        console.warn('[Nostr] Claim publish failed:', String(r.reason));
      }
    }

    // 클레임 성공 시 IDB에 오더 + 클레임 request 원자적 이관
    if (ok) {
      const claimRequest: ClaimRequest = {
        eventId: signed.id,
        orderId: order.orderId,
        action: 'claim',
        pubkey: signed.pubkey,
        createdAt: signed.created_at,
        expiration: order.expiration,
        invoice: null,
        raw: signed,
      };
      void idbMigrateOrderWithRequests(order, [claimRequest]).catch(err => {
        console.warn('[Nostr] IDB claim migration failed for', order.orderId, err);
      });
    }

    return ok;
  } finally {
    pool.destroy();
  }
}

/**
 * 원화 송금 완료 통보를 발행한다 (escrowed → remitted 전이 요청).
 *
 * Tags:
 *   ['a', '30402:<APP_PUBKEY>:<orderId>']  - Admin 오더 참조
 *   ['action', 'remit-request']            - 요청 종류
 *   ['p', APP_PUBKEY]                      - Admin 디스커버리용
 *   ['t', CLIENT_TAG]                      - 클라이언트 식별
 *   ['expiration', ...]                    - 오더 만료 시각
 */
export async function publishRemitRequest(order: Order): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const relays = await getReadRelays(storage);

  const aCoord = `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`;
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ['a', aCoord],
    ['action', 'remit-request'],
    ['p', APP_PUBKEY],
    ['t', CLIENT_TAG],
  ];

  if (order.expiration > 0) {
    tags.push(['expiration', String(order.expiration)]);
  }

  const template = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: now,
    tags,
    content: '',
  };

  const signed = finalizeEvent(template, sk);

  console.log('[Nostr] Publishing remit-request for order', order.orderId, 'event:', signed.id);

  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    for (const r of results) {
      if (r.status === 'fulfilled') {
        console.log('[Nostr] Remit-request published to:', r.value);
      } else {
        console.warn('[Nostr] Remit-request publish failed:', String(r.reason));
      }
    }
    return ok;
  } finally {
    pool.destroy();
  }
}

/**
 * 분쟁 채팅 메시지를 서명까지만 끝낸다. 발행은 호출부가 돌린다.
 * 서명을 먼저 해야 발행 전에 eventId가 확정되어 낙관적 렌더링이 중복을 안 만든다
 * (shared/chat-send 참조).
 */
export async function prepareDisputeMessage(
  order: Order,
  payload: DisputeMessagePayload,
): Promise<PreparedChatMessage> {
  const sk = await getSecretKey(storage);
  const myPubkey = getPublicKey(sk);
  const encrypted = nip44Encrypt(JSON.stringify(payload), sk, APP_PUBKEY);
  const createdAt = Math.floor(Date.now() / 1000);

  const signed = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${order.orderId}`],
      ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE],
      ['p', APP_PUBKEY],
      ['p', myPubkey],
      ['t', CLIENT_TAG],
    ],
    content: encrypted,
  }, sk);

  return {
    message: {
      eventId: signed.id,
      orderId: order.orderId,
      senderPubkey: myPubkey,
      recipientPubkey: APP_PUBKEY,
      payload,
      createdAt,
    },
    publish: async () => {
      const relays = await getReadRelays(storage);
      const pool = new SimplePool();
      try {
        const results = await Promise.allSettled(pool.publish(relays, signed));
        return results.some(r => r.status === 'fulfilled');
      } finally {
        pool.destroy();
      }
    },
  };
}

/** 계좌 공개 등 발행 결과만 필요한 곳을 위한 래퍼. */
export async function publishDisputeMessage(
  order: Order,
  payload: DisputeMessagePayload,
): Promise<boolean> {
  const prepared = await prepareDisputeMessage(order, payload);
  return prepared.publish();
}

/**
 * 분쟁 상황에서 계좌정보를 Admin에게 공개한다.
 * IDB에 저장된 account-info의 계좌정보를 account-reveal 타입 메시지로 발행.
 * Admin은 이를 수신하여 원본 commitment와 해시 대조 검증한다.
 */
export async function publishAccountReveal(order: Order): Promise<boolean> {
  const requests = await idbGetRequestsByOrderId(order.orderId);
  const accountInfoReq = requests.find((r): r is AccountInfoRequest => r.action === 'account-info');
  if (!accountInfoReq?.accountInfo) {
    console.warn('[Nostr] No account info found for order', order.orderId);
    return false;
  }

  // 솔트도 같이 공개해야 Admin이 커밋먼트를 대조할 수 있다.
  // 솔트 도입(감사 A-1) 이전 기록은 undefined — Admin이 레거시 무솔트로 검증한다.
  const payload: DisputeMessagePayload = {
    type: 'account-reveal',
    accountInfo: accountInfoReq.accountInfo,
    commitmentSalt: accountInfoReq.commitmentSalt,
  };

  return publishDisputeMessage(order, payload);
}
