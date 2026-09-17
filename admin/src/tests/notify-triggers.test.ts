/**
 * 알림 발송 표 검증
 *
 * 여기서 지키려는 건 두 가지다.
 *
 * **누가 받는가.** 수신자를 잘못 고르면 거래 내용이 남에게 간다. 특히 고객/후원자를
 * 뒤바꾸는 실수는 타입으로 안 잡힌다 — 둘 다 string이라서.
 *
 * **언제 보내는가.** "당신 차례입니다"가 아닌 순간에 보내면 알림이 소음이 되고,
 * 소음이 되면 정작 움직여야 할 때 놓친다. requested/claimed에서 조용해야 하는
 * 이유가 그것이다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Order } from '@sajwo-tracker/shared';

vi.mock('../nostr/notify', () => ({ notify: vi.fn().mockResolvedValue(true) }));
vi.mock('../web-push/send', () => ({ sendPush: vi.fn().mockResolvedValue(1) }));

import { notify } from '../nostr/notify';
import { sendPush } from '../web-push/send';
import { notifyTransition, notifyAccountInfoArrived } from '../nostr/notify-triggers';

const notifySpy = notify as ReturnType<typeof vi.fn>;
const pushSpy = sendPush as ReturnType<typeof vi.fn>;

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
  return pushSpy.mock.calls.map(c => c[0] as string);
}

/** 그 사람에게 간 푸시 본문 */
function bodyFor(pubkey: string): string | undefined {
  const call = pushSpy.mock.calls.find(c => c[0] === pubkey);
  return call ? (call[1] as { body: string }).body : undefined;
}

describe('알림 발송 표', () => {
  beforeEach(() => {
    notifySpy.mockClear();
    pushSpy.mockClear();
  });

  describe('통로', () => {
    /**
     * NIP-17은 2026-09-17에 껐다(NOSTR_DM_NOTIFICATIONS). 안내를 화면에서 감춘
     * 뒤로는 아무도 안 여는 gift wrap이 릴레이에 쌓이기만 한다. 코드는 남아 있어
     * 스위치만 켜면 살아나는데, **꺼둔 동안 새는 일이 없어야** 한다.
     */
    it('Web Push로만 나간다 — NIP-17은 꺼져 있다', () => {
      notifyTransition(order('remitted'));

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('푸시 tag가 orderId라 같은 주문 알림이 쌓이지 않는다', () => {
      notifyTransition(order('remitted'));

      expect((pushSpy.mock.calls[0]?.[1] as { tag?: string }).tag).toBe('order-1');
    });

    it('푸시 url은 앱 내부 경로다 — 절대 URL이 아니다', () => {
      notifyTransition(order('verified'));

      const url = (pushSpy.mock.calls[0]?.[1] as { url: string }).url;
      expect(url.startsWith('/')).toBe(true);
    });
  });

  describe('고객 차례 — 고객에게만 간다', () => {
    it.each(['verified', 'escrowed', 'remitted'] as const)('%s', state => {
      notifyTransition(order(state));
      expect(recipients()).toEqual([CUSTOMER]);
    });

    it('remitted는 후원자가 이미 송금을 마친 상태라 반드시 알린다', () => {
      notifyTransition(order('remitted'));

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(bodyFor(CUSTOMER)).toContain('컨펌');
    });
  });

  describe('종료 — 양쪽에 결과를 알린다', () => {
    it.each(['paid', 'cancelled', 'sponsor_wins', 'customer_wins'] as const)('%s', state => {
      notifyTransition(order(state));
      expect(recipients().sort()).toEqual([CUSTOMER, SPONSOR].sort());
    });

    it('분쟁 승자와 패자에게 다른 문구가 간다', () => {
      notifyTransition(order('customer_wins'));

      expect(bodyFor(CUSTOMER)).toContain('유리하게');
      expect(bodyFor(SPONSOR)).not.toContain('유리하게');
    });
  });

  describe('조용해야 하는 구간', () => {
    it.each(['requested', 'claimed'] as const)('%s에서는 아무것도 안 나간다', state => {
      notifyTransition(order(state));

      expect(pushSpy).not.toHaveBeenCalled();
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
      expect(bodyFor(SPONSOR)).toContain('송금');
    });

    it('후원자가 없으면 아무것도 안 한다', () => {
      notifyAccountInfoArrived(order('escrowed', false));

      expect(pushSpy).not.toHaveBeenCalled();
      expect(notifySpy).not.toHaveBeenCalled();
    });
  });
});
