/**
 * 알림 발송 표 검증
 *
 * 여기서 지키려는 건 두 가지다.
 *
 * **누가 받는가.** 알림은 NIP-17로 봉해지지만 수신자를 잘못 고르면 봉투가
 * 무슨 소용이든 내용이 남에게 간다. 특히 고객/후원자를 뒤바꾸는 실수는
 * 타입으로 잡히지 않는다 — 둘 다 string이라서.
 *
 * **언제 보내는가.** "당신 차례입니다"가 아닌 순간에 보내면 알림이 소음이
 * 되고, 소음이 되면 정작 움직여야 할 때 놓친다. requested/claimed에서
 * 조용해야 하는 이유가 그것이다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Order } from '@sajwo-tracker/shared';

vi.mock('../nostr/notify', () => ({ notify: vi.fn().mockResolvedValue(true) }));

import { notify } from '../nostr/notify';
import { notifyTransition, notifyAccountInfoArrived } from '../nostr/notify-triggers';

const notifySpy = notify as ReturnType<typeof vi.fn>;

const CUSTOMER = 'customer-pubkey-aaaa';
const SPONSOR = 'sponsor-pubkey-bbbb';

function order(state: Order['state'], withSponsor = true): Order {
  return {
    orderId: 'order-1',
    status: 'active',
    state,
    customerPubkey: CUSTOMER,
    ...(withSponsor ? { sponsorPubkey: SPONSOR } : {}),
    price: 1_000_000,
    createdAt: 0,
    updatedAt: 0,
    expiration: 0,
    raw: {},
  };
}

/** 이 전이에서 알림을 받은 사람들 */
function recipients(): string[] {
  return notifySpy.mock.calls.map(c => c[0] as string);
}

describe('알림 발송 표', () => {
  beforeEach(() => {
    notifySpy.mockClear();
  });

  describe('고객 차례 — 고객에게만 간다', () => {
    it.each(['verified', 'escrowed', 'remitted'] as const)('%s', state => {
      notifyTransition(order(state));
      expect(recipients()).toEqual([CUSTOMER]);
    });

    it('remitted는 후원자가 이미 송금을 마친 상태라 반드시 알린다', () => {
      notifyTransition(order('remitted'));
      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(notifySpy.mock.calls[0]?.[1]).toContain('컨펌');
    });
  });

  describe('종료 — 양쪽에 결과를 알린다', () => {
    it.each(['paid', 'cancelled', 'sponsor_wins', 'customer_wins'] as const)('%s', state => {
      notifyTransition(order(state));
      expect(recipients().sort()).toEqual([CUSTOMER, SPONSOR].sort());
    });

    it('분쟁 승자와 패자에게 다른 문구가 간다', () => {
      notifyTransition(order('customer_wins'));
      const byPubkey = new Map(notifySpy.mock.calls.map(c => [c[0] as string, c[1] as string]));
      expect(byPubkey.get(CUSTOMER)).toContain('유리하게');
      expect(byPubkey.get(SPONSOR)).not.toContain('유리하게');
    });
  });

  describe('조용해야 하는 구간', () => {
    it.each(['requested', 'claimed'] as const)('%s에서는 아무에게도 안 보낸다', state => {
      notifyTransition(order(state));
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });

  describe('후원자가 없는 오더', () => {
    it('취소돼도 고객에게만 간다 (undefined로 발송 시도 없음)', () => {
      notifyTransition(order('cancelled', false));
      expect(recipients()).toEqual([CUSTOMER]);
    });
  });

  describe('계좌 도착 — 후원자 차례', () => {
    it('후원자에게만 간다', () => {
      notifyAccountInfoArrived(order('escrowed'));
      expect(recipients()).toEqual([SPONSOR]);
      expect(notifySpy.mock.calls[0]?.[1]).toContain('송금');
    });

    it('후원자가 없으면 아무것도 안 한다', () => {
      notifyAccountInfoArrived(order('escrowed', false));
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });
});
