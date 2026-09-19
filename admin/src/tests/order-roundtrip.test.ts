/**
 * 오더 태그 왕복 (발행 ↔ 파싱)
 *
 * ── 왜 생겼나
 *
 * `payout`/`sponsor-invoice` 태그를 발행에만 추가하고 **파서에 안 넣었다.**
 * 타입은 멀쩡했다 — 둘 다 optional 필드라 없어도 컴파일된다.
 *
 * 증상이 고약했다. 어드민은 전이 때 값을 담아 발행하지만, 릴레이 에코가 돌아오면
 * `upsertOrder`가 파싱본으로 오더를 **통째로 갈아끼운다.** 그 순간 값이 증발했다.
 * 후원자 화면엔 "정확히 이 금액으로 **0 sats**"가 떴고, 인보이스를 내도
 * `payoutSat`이 undefined라 전부 AMOUNT_MISMATCH로 거절됐을 것이다.
 * 2026-09-19 prd에서 관측.
 *
 * 그래서 "발행한 건 반드시 읽힌다"를 여기서 고정한다. 태그를 추가할 때
 * 파서를 빠뜨리면 이 테스트가 깨진다.
 */
import { describe, it, expect } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, type Order } from '@sajwo-tracker/shared';
import { parseOrderEvent } from '../types';

/** publishOrder가 만드는 태그 구성을 그대로 재현한다. */
function tagsFor(order: Order): string[][] {
  const tags: string[][] = [
    ['d', order.orderId],
    ['t', 'sajwo-tracker'],
    ['status', order.status],
    ['state', order.state],
    ['price', String(order.price), 'KRW'],
    ['customer', order.customerPubkey],
    ['expiration', String(order.expiration)],
  ];
  if (order.sponsorPubkey) tags.push(['sponsor', order.sponsorPubkey]);
  if (order.bolt11) tags.push(['bolt11', order.bolt11]);
  if (order.payoutSat) tags.push(['payout', String(order.payoutSat)]);
  if (order.sponsorInvoice) tags.push(['sponsor-invoice', order.sponsorInvoice]);
  if (order.disbursed) tags.push(['disbursed', 'true']);
  if (order.depositPaymentHash) tags.push(['customer-deposit-payment-hash', order.depositPaymentHash]);
  if (order.sponsorDepositPaymentHash) tags.push(['sponsor-deposit-payment-hash', order.sponsorDepositPaymentHash]);
  return tags;
}

function asEvent(order: Order): Event {
  return {
    id: 'evt', pubkey: APP_PUBKEY, kind: 30402, sig: 'sig',
    created_at: order.updatedAt, content: '', tags: tagsFor(order),
  } as Event;
}

const FULL: Order = {
  orderId: 'order-1',
  status: 'active',
  state: 'invoiced',
  customerPubkey: 'c'.repeat(64),
  sponsorPubkey: 's'.repeat(64),
  price: 27_310,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_500,
  expiration: 1_700_090_000,
  bolt11: 'lnbc-escrow',
  payoutSat: 24_648,
  sponsorInvoice: 'lnbc-sponsor-payout',
  depositPaymentHash: 'dep-c',
  sponsorDepositPaymentHash: 'dep-s',
  raw: {},
};

describe('오더 태그 왕복', () => {
  it('발행에 실린 필드는 파싱에서 전부 살아 돌아온다', () => {
    const parsed = parseOrderEvent(asEvent(FULL));

    expect(parsed).not.toBeNull();
    // raw/createdAt/updatedAt은 이벤트에서 유도되므로 비교 대상이 아니다.
    const { raw: _r, createdAt: _c, updatedAt: _u, ...expected } = FULL;
    const { raw: _r2, createdAt: _c2, updatedAt: _u2, ...actual } = parsed!;
    expect(actual).toEqual(expected);
  });

  describe('돈이 걸린 두 필드', () => {
    it('payoutSat이 살아남는다 — 증발하면 후원자 화면이 0 sats가 된다', () => {
      expect(parseOrderEvent(asEvent(FULL))!.payoutSat).toBe(24_648);
    });

    it('sponsorInvoice가 살아남는다 — 증발하면 지급할 대상이 사라진다', () => {
      expect(parseOrderEvent(asEvent(FULL))!.sponsorInvoice).toBe('lnbc-sponsor-payout');
    });
  });

  describe('아직 정해지지 않은 값', () => {
    it('payout 태그가 없으면 undefined — 0으로 만들지 않는다', () => {
      const early: Order = { ...FULL, state: 'claimed', payoutSat: undefined, sponsorInvoice: undefined };
      const parsed = parseOrderEvent(asEvent(early))!;

      // 0이면 isPayoutAmountExact가 "정해졌는데 0"으로 오해할 여지가 생긴다.
      expect(parsed.payoutSat).toBeUndefined();
      expect(parsed.sponsorInvoice).toBeUndefined();
    });
  });

  it('APP_PUBKEY가 아닌 발행자는 거부한다', () => {
    const forged = { ...asEvent(FULL), pubkey: 'f'.repeat(64) } as Event;
    expect(parseOrderEvent(forged)).toBeNull();
  });
});
