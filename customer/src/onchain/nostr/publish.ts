/**
 * 온체인 요청 발행 (PLAN-ONCHAIN-TRACK §5.2)
 *
 * 라이트닝과 **같은 kind·같은 배관**을 쓰고 `t` 태그와 action만 다르다.
 *
 * ⚠️ **PSBT와 받을 주소는 암호문으로 나간다.** kind 1111은 공개 이벤트이고,
 * PSBT 안에는 후원자의 실제 지갑 주소가 들어 있다(§5.2 표).
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, REQUEST_ACTIONS, SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND, getReadRelays, getSecretKey, nip44Encrypt, storage,
} from '@sajwo-tracker/shared';

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

function baseTags(orderId: string, action: string, extra: string[][] = []): string[][] {
  return [
    ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
    ['action', action],
    ['t', CLIENT_TAG_ONCHAIN],
    ['p', APP_PUBKEY],
    ...extra,
  ];
}

async function encryptToAdmin(payload: object): Promise<string> {
  const sk = await getSecretKey(storage);
  return nip44Encrypt(JSON.stringify(payload), sk, APP_PUBKEY);
}

/** 고객: 의뢰 등록 */
export async function publishOnchainOrderRequest(params: {
  orderId: string;
  amountSat: number;
  reserveKrw?: number;
  customerXonly: string;
  expiration: number;
}): Promise<PublishResult> {
  const extra: string[][] = [
    ['amount-sat', String(params.amountSat)],
    ['customer-xonly', params.customerXonly],
    ['expiration', String(params.expiration)],
  ];
  if (params.reserveKrw !== undefined) extra.push(['reserve-krw', String(params.reserveKrw)]);

  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(params.orderId, REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST, extra),
    content: '',
  });
}

/**
 * 후원자: 클레임.
 *
 * 받을 주소와 feerate는 **암호문**이다 — 공개하면 제3자가 내 지갑을 따라간다.
 * 이걸 보내는 것만으로는 **아무도 예약되지 않는다**(§4.1b). 어드민이 보증금
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
    created_at: Math.floor(Date.now() / 1000),
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
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(orderId, REQUEST_ACTIONS.ONCHAIN_PRESIG),
    content: await encryptToAdmin({ psbt }),
  });
}

/** 양쪽: 최종 서명 */
export async function publishOnchainCosign(
  orderId: string,
  purpose: 'release' | 'refund' | 'dispute-customer' | 'dispute-sponsor',
  psbt: string,
): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(orderId, REQUEST_ACTIONS.ONCHAIN_COSIGN, [['purpose', purpose]]),
    content: await encryptToAdmin({ psbt }),
  });
}

/**
 * 양쪽: 분쟁 제기 / 계좌 이의.
 *
 * ⚠️ `stage: 'account-unusable'`은 **시계를 멈추지 않는다**(§5.2b). 증거로만
 * 붙고, 보증금을 몰수할지 환불할지만 가른다. 화면도 그렇게 말해야 한다.
 */
export async function publishOnchainDispute(
  orderId: string,
  stage?: 'account-unusable' | 'remitted',
): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(orderId, REQUEST_ACTIONS.ONCHAIN_DISPUTE, stage ? [['stage', stage]] : []),
    content: '',
  });
}

/**
 * 고객: 의뢰를 접는다.
 *
 * **후원자가 붙기 전에만** 받아들여진다(§4.2). 붙은 뒤에는 상대가 이미 돈을
 * 걸었으므로 일방 취소가 없고, 마감과 체인이 판정한다.
 *
 * 액션은 라이트닝의 `cancel-request`를 그대로 쓴다 — 뜻이 같고 트랙은 `t` 태그로 갈린다.
 */
export async function publishOnchainCancelRequest(orderId: string): Promise<PublishResult> {
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: baseTags(orderId, REQUEST_ACTIONS.CANCEL_REQUEST),
    content: '',
  });
}

/** 고객: 계좌 정보 (NIP-44로 **후원자에게** — 어드민도 못 본다) */
export async function publishOnchainAccountInfo(
  orderId: string,
  sponsorPubkey: string,
  account: object,
): Promise<PublishResult> {
  const sk = await getSecretKey(storage);
  return publish({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`],
      ['action', REQUEST_ACTIONS.ACCOUNT_INFO],
      ['t', CLIENT_TAG_ONCHAIN],
      ['p', sponsorPubkey],
      ['p', APP_PUBKEY],
    ],
    content: nip44Encrypt(JSON.stringify(account), sk, sponsorPubkey),
  });
}
