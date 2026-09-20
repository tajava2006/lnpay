/**
 * 온체인 오더 발행 (PLAN-ONCHAIN-TRACK §5.1)
 *
 * 라이트닝 발행(`../nostr/publish.ts`)과 **같은 배관**을 쓴다 — NIP-46 서명,
 * 읽기 릴레이, kind 30402. 다른 건 태그 표와 `CLIENT_TAG_ONCHAIN`뿐이다.
 *
 * ⚠️ kind 30402는 addressable이라 **새 발행이 이전 이벤트를 덮어쓴다.** 한 번
 * 빠진 태그는 영영 복구되지 않는다 — 라이트닝에서 `payoutSat` 없이 발행해
 * 주문 두 건을 그렇게 잃었다(2026-09-19). 그래서 발행 직전에 `onchainOrderIssues()`로
 * 훑고 **크게 남긴다.** 막지는 않는다 — 발행을 멈추면 거래가 더 크게 망가진다.
 */
import { SimplePool } from 'nostr-tools/pool';
import type { EventTemplate } from 'nostr-tools/core';
import {
  APP_PUBKEY, CLIENT_TAG_ONCHAIN, REQUEST_ACTIONS, SAJWO_REQUEST_EVENT_KIND,
  SAJWO_REQUEST_KIND, getReadRelays, storage,
} from '@sajwo-tracker/shared';
import {
  isOnchainTerminal, onchainOrderIssues, onchainOrderTags, type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';
import { getSigner } from '../nostr/nip46';

/**
 * 종결 이벤트가 만료된 오더 위에 실릴 때 줄 유예.
 *
 * 릴레이는 NIP-40에 따라 **이미 지난 `expiration`을 가진 이벤트를 거절한다.**
 * 종결 이벤트는 "왜 끝났는지"를 알리려고 내는 것이라 도달해야 의미가 있다.
 * (라이트닝 `publishExpiration`과 같은 규칙 — 거기서 실측으로 얻은 것이다.)
 */
const TERMINAL_GRACE_SEC = 7 * 24 * 60 * 60;

export function onchainPublishExpiration(order: OnchainOrder, now: number): number {
  if (!isOnchainTerminal(order.state)) return order.expiration;
  return order.expiration > now ? order.expiration : now + TERMINAL_GRACE_SEC;
}

export async function publishOnchainOrder(order: OnchainOrder): Promise<object> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const issues = onchainOrderIssues(order);
  if (issues.length > 0) {
    console.error(
      '[Onchain] 불변조건 위반: %s 상태인데 %s 가(이) 비었다 — addressable이라 덮어쓴다:',
      order.state, issues.join(', '), order.orderId,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const tags = onchainOrderTags(order, CLIENT_TAG_ONCHAIN)
    // 만료는 종결 유예를 반영해 다시 쓴다
    .map(t => (t[0] === 'expiration' ? ['expiration', String(onchainPublishExpiration(order, now))] : t));

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_KIND,
    created_at: now,
    tags,
    content: '',
  };

  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    if (!results.some(r => r.status === 'fulfilled')) {
      throw new Error('모든 릴레이에 발행 실패');
    }
    console.log('[Onchain] 발행', order.orderId, order.state, '→', relays.length, '릴레이');
  } finally {
    pool.destroy();
  }

  return signed;
}

/** 오더에 묶인 kind 1111을 상대에게 보낼 때 쓰는 `a` 태그 */
export function onchainOrderRef(orderId: string): string {
  return `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${orderId}`;
}

async function publishRequest(
  orderId: string,
  recipientPubkey: string,
  action: string,
  extraTags: string[][],
  content: string,
): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');

  const template: EventTemplate = {
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', onchainOrderRef(orderId)],
      ['action', action],
      ['t', CLIENT_TAG_ONCHAIN],
      ['p', recipientPubkey],
      ['p', APP_PUBKEY],
      ...extraTags,
    ],
    content,
  };
  const signed = await signer.signEvent(template);

  const relays = await getReadRelays(storage);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, signed));
    if (!results.some(r => r.status === 'fulfilled')) {
      throw new Error('모든 릴레이에 발행 실패');
    }
  } finally {
    pool.destroy();
  }
}

/** 보증금 인보이스를 상대에게 보낸다 (평문 — bolt11은 받는 사람만 결제할 수 있다) */
export async function publishOnchainDepositRequired(
  orderId: string,
  recipientPubkey: string,
  bolt11: string,
  expiration: number,
): Promise<void> {
  await publishRequest(
    orderId, recipientPubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED,
    [['bolt11', bolt11], ['expiration', String(expiration)]], '',
  );
}

/** 보증금 처리 결과 (accepted/cancelled/settled) */
export async function publishOnchainDepositStatus(
  orderId: string,
  recipientPubkey: string,
  status: 'accepted' | 'cancelled' | 'settled',
  expiration: number,
): Promise<void> {
  const action = status === 'accepted' ? REQUEST_ACTIONS.DEPOSIT_ACCEPTED
    : status === 'cancelled' ? REQUEST_ACTIONS.DEPOSIT_CANCELLED
    : REQUEST_ACTIONS.DEPOSIT_SETTLED;
  await publishRequest(orderId, recipientPubkey, action, [['expiration', String(expiration)]], '');
}

/**
 * 서명 요청 — **암호문으로 보낸다.**
 *
 * PSBT 안에 받는 주소가 들어 있다. 평문으로 뿌리면 후원자의 실제 지갑 주소가
 * 공개된다(§5.2 표).
 */
export async function publishOnchainSignRequest(
  orderId: string,
  recipientPubkey: string,
  purpose: 'release' | 'refund' | 'dispute-customer' | 'dispute-sponsor',
  psbt: string,
  expiration: number,
): Promise<void> {
  const signer = getSigner();
  if (!signer) throw new Error('로그인되지 않음: signer 없음');
  const content = await signer.nip44Encrypt(recipientPubkey, JSON.stringify({ psbt }));
  await publishRequest(
    orderId, recipientPubkey, REQUEST_ACTIONS.ONCHAIN_COSIGN,
    [['purpose', purpose], ['expiration', String(expiration)]], content,
  );
}
