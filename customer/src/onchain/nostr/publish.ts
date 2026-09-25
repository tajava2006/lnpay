/**
 * 온체인 요청 발행
 *
 * 라이트닝과 **같은 kind·같은 배관**을 쓰고 `t` 태그와 action만 다르다.
 *
 * ⚠️ **PSBT와 받을 주소는 암호문으로 나간다.** kind 1111은 공개 이벤트이고,
 * PSBT 안에는 후원자의 실제 지갑 주소가 들어 있다.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, REQUEST_ACTIONS, SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND, computeAccountCommitment, generateCommitmentSalt, getReadRelays,
  getSecretKey, nip44Encrypt, storage,
  type AccountInfo, type DisputeMessagePayload, type PreparedChatMessage, nowSec,
} from '@sajwo-tracker/shared';
import { onchainMessageExpiration, type SignPurpose } from '@sajwo-tracker/shared/onchain';

export interface PublishResult {
  success: boolean;
  errors: string[];
}

async function publish(template: EventTemplate): Promise<PublishResult> {
  const sk = await getSecretKey(storage);
  const signed = finalizeEvent(template, sk);
  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => String(r.reason));
    return { success: results.some(r => r.status === 'fulfilled'), errors };
  } finally {
    pool.destroy();
  }
}

/**
 * 요청 공통 태그. **`expiration`을 단다** — 이벤트에는 반드시 만료가 있어야 한다
 * (CLAUDE.md). 거래가 끝날 때까지는 살아 있어야 어드민이 소유권을 옮긴 뒤 다시
 * 받아볼 수 있으므로 거래 상한(타임락)보다 길게 잡는다.
 */
function baseTags(orderId: string, action: string, extra: string[][] = []): string[][] {
  return [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
    ['action', action],
    ['t', CLIENT_TAG_ONCHAIN],
    ['p', APP_PUBKEY],
    ['expiration', String(onchainMessageExpiration(nowSec()))],
    ...extra,
  ];
}

async function encryptToAdmin(payload: object): Promise<string> {
  const sk = await getSecretKey(storage);
  return nip44Encrypt(JSON.stringify(payload), sk, APP_PUBKEY);
}

/**
 * 고객: 의뢰 등록.
 *
 * **환불 받을 주소는 암호문이다** — 공개하면 제3자가 내 지갑을 따라간다.
 * 환불·고객승·구조 tx가 이 주소로 온다.
 *
 * `expiration` 태그는 **의뢰 만료**다(어드민이 의뢰 수명으로 읽는다). 이 이벤트 자체도
 * 그때 사라지면 된다 — 오더가 생기면 이 요청은 더 쓸모가 없다.
 */
export async function publishOnchainOrderRequest(params: {
  orderId: string;
  amountSat: number;
  reserveKrw?: number;
  customerXonly: string;
  expiration: number;
  refundAddress: string;
}): Promise<PublishResult> {
  const extra: string[][] = [
    ['amount-sat', String(params.amountSat)],
    ['customer-xonly', params.customerXonly],
  ];
  if (params.reserveKrw !== undefined) extra.push(['reserve-krw', String(params.reserveKrw)]);

  const tags = baseTags(params.orderId, REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST, extra)
    .map(t => (t[0] === 'expiration' ? ['expiration', String(params.expiration)] : t));

  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec(),
    tags,
    content: await encryptToAdmin({ refundAddress: params.refundAddress.trim() }),
  });
}

/**
 * 후원자: 클레임.
 *
 * 받을 주소와 feerate는 **암호문**이다 — 공개하면 제3자가 내 지갑을 따라간다.
 * 이걸 보내는 것만으로는 **아무도 예약되지 않는다**. 어드민이 보증금
 * 인보이스를 내주고, **먼저 결제한 쪽**이 가져간다.
 */
export async function publishOnchainClaim(params: {
  orderId: string;
  sponsorXonly: string;
  payoutAddress: string;
  feerateSatPerVb: number;
}): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec(),
    tags: baseTags(params.orderId, REQUEST_ACTIONS.ONCHAIN_CLAIM, [
      ['sponsor-xonly', params.sponsorXonly],
    ]),
    content: await encryptToAdmin({
      payoutAddress: params.payoutAddress,
      feerateSatPerVb: params.feerateSatPerVb,
    }),
  });
}

/** 후원자: 사전서명 */
export async function publishOnchainPresig(orderId: string, psbt: string): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec(),
    tags: baseTags(orderId, REQUEST_ACTIONS.ONCHAIN_PRESIG),
    content: await encryptToAdmin({ psbt }),
  });
}

/** 양쪽: 최종 서명 */
export async function publishOnchainCosign(
  orderId: string,
  purpose: SignPurpose,
  psbt: string,
): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec(),
    tags: baseTags(orderId, REQUEST_ACTIONS.ONCHAIN_COSIGN, [['purpose', purpose]]),
    content: await encryptToAdmin({ psbt }),
  });
}

/**
 * 양쪽: 분쟁 제기 / 계좌 이의.
 *
 * ⚠️ `stage: 'account-unusable'`은 **시계를 멈추지 않는다**. 증거로만
 * 붙고, 보증금을 몰수할지 환불할지만 가른다. 화면도 그렇게 말해야 한다.
 */
export async function publishOnchainDispute(
  orderId: string,
  stage?: 'account-unusable' | 'remitted',
): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec(),
    tags: baseTags(orderId, REQUEST_ACTIONS.ONCHAIN_DISPUTE, stage ? [['stage', stage]] : []),
    content: '',
  });
}

/**
 * 고객: 의뢰를 접는다.
 *
 * **후원자가 붙기 전에만** 받아들여진다. 붙은 뒤에는 상대가 이미 돈을
 * 걸었으므로 일방 취소가 없고, 마감과 체인이 판정한다.
 *
 * 액션은 라이트닝의 `cancel-request`를 그대로 쓴다 — 뜻이 같고 트랙은 `t` 태그로 갈린다.
 */
export async function publishOnchainCancelRequest(orderId: string): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec(),
    tags: baseTags(orderId, REQUEST_ACTIONS.CANCEL_REQUEST),
    content: '',
  });
}

/**
 * 고객: 계좌 정보 (NIP-44로 **후원자에게** — 어드민도 못 본다).
 *
 * 라이트닝과 같은 **솔티드 커밋먼트**를 공개 태그에 단다. 전에는 없어서,
 * 분쟁 때 "고객이 준 계좌가 뭐였나"를 어드민이 확인할 길이 없었다 — 계좌 이의
 * 판정이 원리적으로 불가능했다. 후원자가 계좌와 솔트를 채팅에 공개하면
 * 어드민이 이 태그와 대조한다.
 */
export async function publishOnchainAccountInfo(
  orderId: string,
  sponsorPubkey: string,
  account: AccountInfo,
): Promise<PublishResult> {
  const sk = await getSecretKey(storage);
  const salt = generateCommitmentSalt();
  const commitment = await computeAccountCommitment(account, salt);
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: nowSec(),
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.ACCOUNT_INFO],
      ['t', CLIENT_TAG_ONCHAIN],
      ['p', sponsorPubkey],
      ['p', APP_PUBKEY],
      ['commitment', commitment],
      ['expiration', String(onchainMessageExpiration(nowSec()))],
    ],
    content: nip44Encrypt(JSON.stringify({ accountInfo: account, salt }), sk, sponsorPubkey),
  });
}

/**
 * 온체인 분쟁 채팅 메시지 (고객·후원자 → 어드민). 서명까지만, 발행은 shared/chat-send가.
 *
 * 전에는 온체인 주문에 채팅이 아예 없었다 — 알림은 "증거를 채팅에 올려주세요"라고
 * 보냈는데. 분쟁 증거는 보존해야 하므로 `expiration`을 달지 않는다.
 */
export async function prepareOnchainDisputeMessage(
  orderId: string,
  payload: DisputeMessagePayload,
): Promise<PreparedChatMessage> {
  const sk = await getSecretKey(storage);
  const myPubkey = getPublicKey(sk);
  const createdAt = nowSec();
  const signed = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE],
      ['t', CLIENT_TAG_ONCHAIN],
      ['p', APP_PUBKEY],
      ['p', myPubkey],
    ],
    content: nip44Encrypt(JSON.stringify(payload), sk, APP_PUBKEY),
  }, sk);

  return {
    message: {
      eventId: signed.id,
      orderId,
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
