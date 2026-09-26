/**
 * APP → 유저 요청·통지 이벤트 (라이트닝) — 보증금 요구·상태, 인보이스 거절, 계좌 공개 요청
 *
 * - **서명은 쌓을 때 한 번** — 재시도가 같은 이벤트를 다시 낸다(발행 효과 참고).
 * - 만료는 쿠팡 기한이 아니라 **메시지가 쓸모 있는 동안**이다(DM-009). 기한을 붙이면 기한 직후에 내는
 *   보증금 환불 통지가 릴레이에서 거절된다.
 */
import { finalizeEvent } from 'nostr-tools/pure';
import { REQUEST_ACTIONS, MESSAGE_KIND, orderRef } from '@sajwo-tracker/shared/core';
import { nowSec } from '../admin/context';
import { PUBLISH_EFFECT, type PublishPayload } from '../nostr/publisher';
import type { LnContext } from './context';

const DAY = 24 * 60 * 60;

/** 보증금 상태 통지의 보존 — 유저가 며칠 뒤 열어도 "왜 돈이 돌아왔는지"를 보게 */
const STATUS_RETENTION_SEC = 7 * DAY;

/** 인보이스 거절 — 후원자가 다시 만들 때까지만 의미가 있다 */
const REJECT_RETENTION_SEC = 1 * DAY;

export type InvoiceRejectReason =
  | 'DECODE_FAILED'
  | 'AMOUNT_MISMATCH'
  | 'EXPIRES_TOO_SOON'
  | 'EXPIRED_BEFORE_PAYOUT'
  | 'LIQUIDITY_WARNING'
  | 'ESCROW_ENDING_SOON';

function send(
  ctx: LnContext,
  orderId: string,
  recipient: string,
  action: string,
  extraTags: string[][],
  expiration: number,
  dedup: string,
): void {
  const createdAt = nowSec(ctx);
  const event = finalizeEvent({
    kind: MESSAGE_KIND,
    created_at: createdAt,
    tags: [
      ['a', orderRef(ctx.appKey.pubkey, orderId)],
      ['action', action],
      ['t', ctx.tags.ln],
      ['p', recipient],
      ['p', ctx.appKey.pubkey],
      ...extraTags,
      ['expiration', String(Math.max(expiration, createdAt + 60))],
    ],
    content: '',
  }, ctx.appKey.secretKey);
  ctx.effects.enqueue<PublishPayload>(PUBLISH_EFFECT, { event }, { dedup });
}

/** 보증금 인보이스를 전한다 — 결제 기한까지만 쓸모 있다 */
export function sendDepositRequired(
  ctx: LnContext, orderId: string, recipient: string, bolt11: string, payBy: number, paymentHash: string,
): void {
  send(ctx, orderId, recipient, REQUEST_ACTIONS.DEPOSIT_REQUIRED, [['bolt11', bolt11]], payBy,
    `ln.msg:deposit-required:${paymentHash}`);
}

/** accepted = 결제 확인 · cancelled = 환불(또는 무효) · settled = 몰수 */
export function sendDepositStatus(
  ctx: LnContext, orderId: string, recipient: string, status: 'accepted' | 'cancelled' | 'settled', paymentHash: string,
): void {
  const action = status === 'accepted' ? REQUEST_ACTIONS.DEPOSIT_ACCEPTED
    : status === 'cancelled' ? REQUEST_ACTIONS.DEPOSIT_CANCELLED
    : REQUEST_ACTIONS.DEPOSIT_SETTLED;
  send(ctx, orderId, recipient, action, [], nowSec(ctx) + STATUS_RETENTION_SEC, `ln.msg:deposit-${status}:${paymentHash}`);
}

/**
 * 후원자 인보이스를 받지 않았다(또는 경고). 조용히 버리면 후원자는 등록됐다고 믿고 오지 않을 계좌를
 * 기다린다. `expected-sats`로 바로 다시 만들 수 있게.
 */
export function sendInvoiceRejected(
  ctx: LnContext, orderId: string, sponsor: string, reason: InvoiceRejectReason, expectedSats: number, key: string,
): void {
  send(ctx, orderId, sponsor, REQUEST_ACTIONS.CLAIM_PRICE_ERROR,
    [['reason', reason], ['expected-sats', String(expectedSats)]],
    nowSec(ctx) + REJECT_RETENTION_SEC, `ln.msg:reject:${orderId}:${reason}:${key}`);
}

/** 분쟁 중재용 계좌 공개 요청 — 이게 와야 후원자 화면의 공개 버튼이 열린다 */
export function sendRevealRequest(ctx: LnContext, orderId: string, sponsor: string): void {
  send(ctx, orderId, sponsor, REQUEST_ACTIONS.REVEAL_REQUEST, [], nowSec(ctx) + STATUS_RETENTION_SEC,
    `ln.msg:reveal:${orderId}:${nowSec(ctx)}`);
}
