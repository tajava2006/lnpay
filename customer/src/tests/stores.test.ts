/**
 * 유저 앱 저장소 — 공용 헬퍼로 옮긴 뒤에도 같은 키·같은 형식, 옛 모양만 걸러진다
 *
 * 저장소는 모듈이 불러와질 때 localStorage를 읽는다. 그래서 불러오기를 보려면 먼저 심어 두고 모듈을 새로 부른다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('불러오기 — 옛 모양만 버린다', () => {
  it('서명 요청: 모르는 목적은 버리고 나머지는 그대로', async () => {
    const good = { orderId: 'o1', purpose: 'refund', psbt: 'cHNidA==', receivedAt: 10 };
    localStorage.setItem('onchain:sign-requests-v2', JSON.stringify({
      'o1|refund': good,
      'o1|payout': { ...good, purpose: 'payout' },
    }));
    const { getSignRequestsSnapshot } = await import('../onchain/sign-request-store');
    expect(getSignRequestsSnapshot()).toEqual({ 'o1|refund': good });
  });

  it('내 의뢰: 이 기기에만 있는 칸(메모·고정 계좌)은 그대로 살고, 모르는 상태의 옛 주문만 빠진다', async () => {
    const mine = {
      orderId: 'o1', price: 32_900, memo: '키보드', createdAt: 1, expiration: 2, adminState: 'invoiced',
      coupangOrderId: '123', fixedAccountInfo: { bankName: '국민', accountNumber: '1-2', holderName: '갑' },
    };
    localStorage.setItem('customer:orders', JSON.stringify({
      o1: mine,
      old: { ...mine, orderId: 'old', adminState: 'sold' },
      half: { ...mine, orderId: 'half', fixedAccountInfo: { bankName: '국민' } },
    }));
    const { getSnapshot } = await import('../buyer/order-store');
    expect(getSnapshot()).toEqual({ o1: mine });
  });
});

describe('형식 — 키와 값이 헬퍼 전과 같다', () => {
  it('쓴 값이 같은 키에 맵 JSON 그대로 남는다', async () => {
    const { putNotice } = await import('../onchain/notice-store');
    putNotice({ orderId: 'o1', reason: '늦은 사전서명', receivedAt: 5 });
    expect(JSON.parse(localStorage.getItem('onchain:notices')!)).toEqual({
      o1: { orderId: 'o1', reason: '늦은 사전서명', receivedAt: 5 },
    });
  });
});

describe('동기화 표시', () => {
  it('오더북 구독은 첫 동기화 완료도 알린다 — "동기화 중" 배지가 내려가야 한다', async () => {
    const store = await import('../sponsor/order-store');
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getSyncedSnapshot()).toBe(false);
    store.markSynced();
    expect(store.getSyncedSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
