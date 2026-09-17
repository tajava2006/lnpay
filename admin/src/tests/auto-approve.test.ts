/**
 * 클레임 자동 승인 판정
 *
 * 자동화의 조건이 곧 "어드민이 눈으로 확인하던 것"이다. 여기가 느슨해지면
 * 아무도 모르는 사이에 승인이 남발되고, 그 결과는 홀드 인보이스 발행과
 * 가격 확정 — 되돌리려면 클레임 철회를 타야 한다.
 */
import { describe, it, expect } from 'vitest';
import type { Order } from '@sajwo-tracker/shared';
import { shouldAutoApprove } from '../auto-approve';

const NOW = 1_700_000_000;

function order(over: Partial<Order> = {}): Order {
  return {
    orderId: 'order-1',
    status: 'active',
    state: 'claimed',
    customerPubkey: 'customer',
    sponsorPubkey: 'sponsor',
    price: 1_000_000,
    createdAt: NOW - 3600,
    updatedAt: NOW - 3600,
    expiration: NOW + 3600,
    raw: {},
    ...over,
  };
}

const NO_DEPOSIT = { sponsorDepositRequired: false, now: NOW };
const DEPOSIT_ON = { sponsorDepositRequired: true, now: NOW };

describe('shouldAutoApprove', () => {
  it('보증금 미사용 + 정상 claimed면 승인한다', () => {
    expect(shouldAutoApprove(order(), NO_DEPOSIT)).toBe(true);
  });

  describe('claimed가 아니면 건드리지 않는다', () => {
    it.each([
      'requested', 'verified', 'escrowed', 'invoiced',
      'remitted', 'paid', 'cancelled', 'sponsor_wins', 'customer_wins',
    ] as const)('%s', state => {
      expect(shouldAutoApprove(order({ state }), NO_DEPOSIT)).toBe(false);
    });
  });

  /**
   * 보증금은 스팸 방어다. 자동화가 건너뛸 수 있는 종류가 아니다 —
   * 건너뛰면 보증금 설정을 켜둔 의미가 통째로 사라진다.
   */
  describe('후원자 보증금', () => {
    it('요구 설정인데 미납이면 보류', () => {
      expect(shouldAutoApprove(order(), DEPOSIT_ON)).toBe(false);
    });

    it('납부됐으면 승인', () => {
      expect(shouldAutoApprove(order({ sponsorDepositPaymentHash: 'hash' }), DEPOSIT_ON)).toBe(true);
    });

    it('요구하지 않는 설정이면 미납이어도 승인', () => {
      expect(shouldAutoApprove(order(), NO_DEPOSIT)).toBe(true);
    });
  });

  describe('만료', () => {
    // 만료된 오더를 승인하면 홀드 인보이스 만료가 음수라 approveOrder가 어차피
    // 실패한다. 매 15초마다 헛 시도를 반복하지 않도록 여기서 거른다.
    it('이미 만료됐으면 보류', () => {
      expect(shouldAutoApprove(order({ expiration: NOW - 1 }), NO_DEPOSIT)).toBe(false);
    });

    it('정확히 지금 만료여도 보류', () => {
      expect(shouldAutoApprove(order({ expiration: NOW }), NO_DEPOSIT)).toBe(false);
    });
  });

  it('sponsorPubkey 없는 claimed는 비정상이므로 보류', () => {
    expect(shouldAutoApprove(order({ sponsorPubkey: undefined }), NO_DEPOSIT)).toBe(false);
  });
});
