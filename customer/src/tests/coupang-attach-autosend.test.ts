/**
 * 쿠팡 가상계좌 자동 전송 — 먼저 올린 판매에 나중에 붙여도 나가야 한다 (2026-10-24)
 *
 * 쿠팡 무통장입금은 입금 기한이 하루라, 판매를 오래 걸어 두려면 "금액만 맞춰 먼저 올리고 사는 사람이 붙으면 쿠팡 주문을
 * 넣어 붙인다"가 안내된 길이다. 붙이는 때는 대개 사는 사람이 인보이스를 등록하기(invoiced) **전**이다.
 *
 * 그런데 invoiced에 들어올 때의 자동 전송이 `source === 'parsed'`만 봐서, 붙인 판매(`source` 그대로)는 건너뛰었다 —
 * 카드는 "자동으로 보내는 중…"에 멈추고 수동 버튼도 없어 기한이 지나면 파는 사람 보증금이 몰수됐다.
 * 프로덕션이 실제로 부르는 `handleAdminOrder`(오더 이벤트 수신)를 탄다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Event } from 'nostr-tools/core';

const publishAccountInfo = vi.fn(async () => ({ success: true }));

vi.mock('../buyer/nostr/publish', () => ({
  publishAccountInfo,
  publishNotification: vi.fn(async () => ({ success: true })),
}));
vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  idbUpsertOrder: async () => {},
}));

const { APP_PUBKEY, CLIENT_TAG, ORDER_KIND } = await import('@sajwo-tracker/shared');
const { lnOrderTags } = await import('@sajwo-tracker/shared/ln');
type LnState = 'claimed' | 'verified' | 'escrowed' | 'invoiced';
const { handleAdminOrder } = await import('../buyer/nostr/service');
const orders = await import('../buyer/order-store');

const ME = 'a'.repeat(64);
const SPONSOR = 'b'.repeat(64);
const PRICE = 32_900;
const COUPANG = { bankName: '국민은행', accountNumber: '123-456-789', holderName: '쿠팡(주)' };

function orderEvent(orderId: string, state: LnState): Event {
  return {
    id: `ev-${orderId}-${state}`, pubkey: APP_PUBKEY, kind: ORDER_KIND, created_at: 1_700_000_000, sig: 'sig', content: '',
    tags: lnOrderTags({
      orderId, state, price: PRICE, customerPubkey: ME, sponsorPubkey: SPONSOR, deadline: 2_000_000_000,
    }, CLIENT_TAG, 2_000_000_000),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
  localStorage.clear();
  publishAccountInfo.mockClear();
});

describe('쿠팡 가상계좌 자동 전송', () => {
  it('금액만 맞춰 올린 판매에 사는 사람이 붙은 뒤 붙이면, invoiced에 들어올 때 계좌가 나간다', async () => {
    const id = 'attach-early';
    orders.addOrder({ orderId: id, price: PRICE, memo: '직접 입력', createdAt: 1, expiration: 2_000_000_000 });
    handleAdminOrder(orderEvent(id, 'claimed'), ME);

    expect(orders.attachParsedToOrder(id, { coupangOrderId: 'c-1', productName: '상품', ...COUPANG })).toBe(true);
    expect(orders.getSnapshot()[id]!.source).toBeUndefined(); // 붙여도 source는 그대로 — 자동 전송은 이걸 보면 안 된다

    handleAdminOrder(orderEvent(id, 'escrowed'), ME);
    await flush();
    expect(publishAccountInfo).not.toHaveBeenCalled(); // I-009: 인보이스 등록 전엔 안 나간다

    handleAdminOrder(orderEvent(id, 'invoiced'), ME);
    await flush();
    expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    expect(orders.getSnapshot()[id]!.accountInfo).toEqual(COUPANG);
  });

  it('파싱 주문으로 바로 올린 판매도 그대로 나간다', async () => {
    const id = 'parsed';
    orders.addOrder({
      orderId: id, price: PRICE, memo: '상품', createdAt: 1, expiration: 2_000_000_000, source: 'parsed',
      coupangOrderId: 'c-2', fixedAccountInfo: COUPANG,
    });
    handleAdminOrder(orderEvent(id, 'invoiced'), ME);
    await flush();
    expect(publishAccountInfo).toHaveBeenCalledTimes(1);
  });

  it('갱신이 겹쳐도 한 번만, 이미 보냈으면 다시 안 보낸다', async () => {
    const id = 'twice';
    orders.addOrder({ orderId: id, price: PRICE, memo: '직접 입력', createdAt: 1, expiration: 2_000_000_000 });
    orders.attachParsedToOrder(id, { coupangOrderId: 'c-3', productName: '상품', ...COUPANG });

    const ev = orderEvent(id, 'invoiced');
    handleAdminOrder(ev, ME);
    handleAdminOrder({ ...ev, id: `${ev.id}-again` }, ME);
    await flush();
    expect(publishAccountInfo).toHaveBeenCalledTimes(1);

    // 앱을 다시 열면 첫 동기화가 같은 오더를 다시 흘려 준다 — 보낸 기록이 있으면 그냥 지나간다
    handleAdminOrder({ ...ev, id: `${ev.id}-reopen` }, ME);
    await flush();
    expect(publishAccountInfo).toHaveBeenCalledTimes(1);
  });

  it('지난번 전송이 실패했으면 다음 동기화에서 다시 보낸다', async () => {
    const id = 'retry';
    orders.addOrder({ orderId: id, price: PRICE, memo: '직접 입력', createdAt: 1, expiration: 2_000_000_000 });
    orders.attachParsedToOrder(id, { coupangOrderId: 'c-4', productName: '상품', ...COUPANG });

    publishAccountInfo.mockResolvedValueOnce({ success: false });
    handleAdminOrder(orderEvent(id, 'invoiced'), ME);
    await flush();
    expect(orders.getSnapshot()[id]!.accountInfo).toBeUndefined();

    handleAdminOrder({ ...orderEvent(id, 'invoiced'), id: 'ev-retry-reopen' }, ME);
    await flush();
    expect(publishAccountInfo).toHaveBeenCalledTimes(2);
    expect(orders.getSnapshot()[id]!.accountInfo).toEqual(COUPANG);
  });
});
