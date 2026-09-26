/**
 * Sponsor → Admin 요청 이벤트 발행
 *
 * - claim: `MESSAGE_KIND`로 클레임 요청을 발행한다.
 * - remit-request: 원화 송금 완료 통보를 발행한다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import {
  MESSAGE_KIND, ORDER_KIND, CLIENT_TAG, APP_PUBKEY, REQUEST_ACTIONS, getSecretKey, getReadRelays,
  type Order, type DisputeMessagePayload, storage, idbMigrateOrderWithRequests, idbGetRequestsByOrderId,
  type ClaimRequest, type AccountInfoRequest, nowSec,
} from '@sajwo-tracker/shared';
import { lnRequestExpiration } from '@sajwo-tracker/shared/ln';
import type { EventTemplate } from 'nostr-tools/core';
import { prepareDisputeMessage } from '../../nostr/dispute-message';

/**
 * 특정 오더에 대해 클레임 이벤트를 발행한다.
 * 성공 시 오더와 클레임 request를 IDB에 원자적으로 이관한다.
 *
 * **인보이스를 싣지 않는다.** 클레임은 "내가 맡겠다"일 뿐이고, 지급받을
 * 인보이스는 에스크로가 잡힌 뒤 `publishSponsorInvoice`로 따로 낸다.
 * 그래야 후원자 노드 사정이 고객의 결제를 막지 않고, 인보이스가 묵어
 * 만료되는 구간도 줄어든다. 규칙은 docs/LN-TRACK.md(I-009·I-010)
 *
 * Tags:
 *   ['a', '<ORDER_KIND>:<APP_PUBKEY>:<orderId>']  - Admin 오더 참조
 *   ['action', 'claim']                    - 요청 종류
 *   ['p', APP_PUBKEY]                      - Admin 디스커버리용
 *   ['t', CLIENT_TAG]                      - 클라이언트 식별
 *   ['expiration', ...]                    - 요청 보존 (lnRequestExpiration)
 */
export async function publishClaim(order: Order): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const relays = await getReadRelays(storage);

  const aCoord = `${ORDER_KIND}:${APP_PUBKEY}:${order.orderId}`;
  const now = nowSec();

  const tags: string[][] = [
    ['a', aCoord],
    ['action', 'claim'],
    ['p', APP_PUBKEY],
    ['t', CLIENT_TAG],
  ];

  // 요청의 보존 — 쿠팡 기한이 아니다(기한 직후의 송금 완료가 릴레이에서 거절되면 안 된다)
  tags.push(['expiration', String(lnRequestExpiration(now))]);

  const template = {
    kind: MESSAGE_KIND,
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
 *   ['a', '<ORDER_KIND>:<APP_PUBKEY>:<orderId>']  - Admin 오더 참조
 *   ['action', 'remit-request']            - 요청 종류
 *   ['p', APP_PUBKEY]                      - Admin 디스커버리용
 *   ['t', CLIENT_TAG]                      - 클라이언트 식별
 *   ['expiration', ...]                    - 요청 보존 (lnRequestExpiration)
 */
export async function publishRemitRequest(order: Order): Promise<boolean> {
  const sk = await getSecretKey(storage);
  const relays = await getReadRelays(storage);

  const aCoord = `${ORDER_KIND}:${APP_PUBKEY}:${order.orderId}`;
  const now = nowSec();

  const tags: string[][] = [
    ['a', aCoord],
    ['action', 'remit-request'],
    ['p', APP_PUBKEY],
    ['t', CLIENT_TAG],
  ];

  // 요청의 보존 — 쿠팡 기한이 아니다(기한 직후의 송금 완료가 릴레이에서 거절되면 안 된다)
  tags.push(['expiration', String(lnRequestExpiration(now))]);

  const template = {
    kind: MESSAGE_KIND,
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

/** 계좌 공개 등 발행 결과만 필요한 곳을 위한 래퍼. */
export async function publishDisputeMessage(
  order: Order,
  payload: DisputeMessagePayload,
): Promise<boolean> {
  const prepared = await prepareDisputeMessage(order.orderId, payload, CLIENT_TAG);
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
  // 솔트 도입 이전 기록은 undefined — Admin이 레거시 무솔트로 검증한다.
  const payload: DisputeMessagePayload = {
    type: 'account-reveal',
    accountInfo: accountInfoReq.accountInfo,
    commitmentSalt: accountInfoReq.commitmentSalt,
  };

  return publishDisputeMessage(order, payload);
}


/**
 * 지급받을 인보이스를 어드민에 제출한다 (`escrowed` 이후).
 *
 * 클레임 때가 아니라 여기서 내는 이유: 후원자 노드 사정이 고객의 에스크로를
 * 막지 않게 하고, 인보이스가 묵어 만료되는 구간을 줄이기 위해서다.
 * 그리고 **이걸 내야 고객이 계좌 정보를 보낸다** — 받을 준비가 안 된 채로
 * 원화를 보내는 사고를 막는 장치다. 규칙은 docs/LN-TRACK.md(I-009·I-010)
 *
 * 금액은 오더의 `payout` 태그와 **정확히** 일치해야 어드민이 받아준다.
 */
export async function publishSponsorInvoice(
  order: { orderId: string },
  bolt11: string,
): Promise<boolean> {
  const [sk, relays] = await Promise.all([
    getSecretKey(storage),
    getReadRelays(storage),
  ]);

  const now = nowSec();
  const template: EventTemplate = {
    kind: MESSAGE_KIND,
    created_at: now,
    tags: [
      ['a', `${ORDER_KIND}:${APP_PUBKEY}:${order.orderId}`],
      ['action', REQUEST_ACTIONS.SPONSOR_INVOICE],
      ['t', CLIENT_TAG],
      ['p', APP_PUBKEY],
      ['bolt11', bolt11],
      ['expiration', String(lnRequestExpiration(now))],
    ],
    content: '',
  };

  const signed = finalizeEvent(template, sk);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const ok = results.some(r => r.status === 'fulfilled');
    console.log(ok ? '[Sponsor] 인보이스 제출' : '[Sponsor] 인보이스 제출 실패', order.orderId);
    return ok;
  } finally {
    pool.destroy();
  }
}
