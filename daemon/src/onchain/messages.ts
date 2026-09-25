/**
 * APP → 유저 kind 1111 (온체인) — 보증금 요구·상태, 거절, 서명 요청
 *
 * 모양은 프론트 어드민 시절 그대로다(유저 앱이 이미 읽는다). 라이트닝과 같은 배관이고 `t`만 온체인 것이다.
 * 서명은 **쌓을 때 한 번** 한다 — 재시도가 같은 이벤트를 다시 낸다.
 *
 * 만료는 `onchainMessageExpiration`(지금 + 70일) — 거래가 끝날 때까지 산다. 의뢰 만료를 쓰면 막바지에
 * 클레임된 주문의 통지가 릴레이에서 거절된다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { REQUEST_ACTIONS, SAJWO_REQUEST_EVENT_KIND, nip44Encrypt, orderRef } from '@sajwo-tracker/shared/core';
import { onchainMessageExpiration, type SignPurpose } from '@sajwo-tracker/shared/onchain';
import { nowSec } from '../admin/context';
import { PUBLISH_EFFECT, type PublishPayload } from '../nostr/publisher';
import type { OcContext } from './context';

function send(
  ctx: OcContext,
  p: { orderId: string; recipient: string; action: string; tags?: string[][]; content?: string; expiration?: number; dedup: string },
): void {
  const createdAt = nowSec(ctx);
  const event = finalizeEvent({
    kind: SAJWO_REQUEST_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ['a', orderRef(ctx.appKey.pubkey, p.orderId)],
      ['action', p.action],
      ['t', ctx.tags.onchain],
      ['p', p.recipient],
      ['p', ctx.appKey.pubkey],
      ...(p.tags ?? []),
      ['expiration', String(Math.max(p.expiration ?? onchainMessageExpiration(createdAt), createdAt + 60))],
    ],
    content: p.content ?? '',
  }, ctx.appKey.secretKey);
  ctx.effects.enqueue<PublishPayload>(PUBLISH_EFFECT, { event }, { dedup: p.dedup });
}

/** 보증금 인보이스 (평문 — bolt11은 받는 사람만 결제할 수 있다). 인보이스가 끝날 때까지만 쓸모 있다 */
export function sendOcDepositRequired(
  ctx: OcContext, orderId: string, recipient: string, bolt11: string, payBy: number, paymentHash: string,
): void {
  send(ctx, {
    orderId, recipient, action: REQUEST_ACTIONS.DEPOSIT_REQUIRED, tags: [['bolt11', bolt11]], expiration: payBy,
    dedup: `oc.msg:deposit-required:${paymentHash}`,
  });
}

/** accepted = 결제 확인 · cancelled = 환불(또는 무효) · settled = 몰수 */
export function sendOcDepositStatus(
  ctx: OcContext, orderId: string, recipient: string, status: 'accepted' | 'cancelled' | 'settled', paymentHash: string,
): void {
  const action = status === 'accepted' ? REQUEST_ACTIONS.DEPOSIT_ACCEPTED
    : status === 'cancelled' ? REQUEST_ACTIONS.DEPOSIT_CANCELLED
    : REQUEST_ACTIONS.DEPOSIT_SETTLED;
  send(ctx, { orderId, recipient, action, dedup: `oc.msg:deposit-${status}:${paymentHash}` });
}

/**
 * 요청을 처리할 수 없다. **유저에게 도달해야 한다** — 콘솔에만 남기면 "보냈는데 아무 일도 안 일어난다"가
 * 된다(2026-09-21, 의뢰가 그렇게 사라졌다). `key`는 거절을 부른 요청 id — 같은 요청에 두 번 보내지 않게.
 */
export function sendOcRejected(ctx: OcContext, orderId: string, recipient: string, reason: string, key: string): void {
  send(ctx, {
    orderId, recipient, action: REQUEST_ACTIONS.ONCHAIN_REJECTED, tags: [['reason', reason]],
    dedup: `oc.msg:rejected:${key}`,
  });
}

/**
 * 서명 요청 — **암호문**이다. PSBT 안에 받는 주소가 들어 있다(공개하면 후원자 지갑이 드러난다).
 * 다시 보내기도 새 이벤트다(유저가 기기를 바꿨거나 첫 전달이 안 닿았을 때).
 */
export function sendOcSignRequest(ctx: OcContext, orderId: string, recipient: string, purpose: SignPurpose, psbt: string): void {
  send(ctx, {
    orderId, recipient, action: REQUEST_ACTIONS.ONCHAIN_COSIGN, tags: [['purpose', purpose]],
    content: nip44Encrypt(JSON.stringify({ psbt }), ctx.appKey.secretKey, recipient),
    dedup: `oc.msg:sign:${orderId}:${purpose}:${nowSec(ctx)}`,
  });
}
