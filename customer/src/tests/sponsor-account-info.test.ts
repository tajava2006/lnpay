/**
 * 라이트닝 후원자 — 계좌는 **오더의 고객이 보낸 것만** 받는다
 *
 * 온체인 리뷰 #8에서 같은 모양으로 발견했다. 후원자 pubkey는 오더 태그에 공개돼 있어
 * 누구든 가짜 계좌를 NIP-44로 보낼 수 있었고, 보낸 사람 키로 복호화만 되면 받았다.
 * 스토어는 뒤에 온 것으로 덮으니, 공격자는 고객 계좌가 뜬 **뒤에** 쏴서 바꿔치기할
 * 수도 있었다 — 후원자가 공격자 계좌로 원화를 보내는 경로다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Event } from 'nostr-tools/core';
import type { Order } from '@sajwo-tracker/shared';

vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  getSecretKey: async () => new Uint8Array(32).fill(1),
  nip44Decrypt: (content: string) => {
    if (!content.startsWith('enc:')) throw new Error('복호화 실패');
    return content.slice(4);
  },
  idbHasOrder: async () => false,
  idbUpsertOrder: async () => {},
  idbUpsertRequest: async () => {},
  storage: {},
}));

const { APP_PUBKEY, SAJWO_REQUEST_KIND } = await import('@sajwo-tracker/shared');
const { handleInboxEvent } = await import('../sponsor/nostr/service');
const orders = await import('../sponsor/order-store');
const accounts = await import('../sponsor/account-store');

const ORDER_ID = 'ln-1';

function accountEvent(from: string, accountNumber: string): Event {
  return {
    id: `ev-${accountNumber}`, pubkey: from, kind: 1111, created_at: 1_700_000_000,
    tags: [['a', `${SAJWO_REQUEST_KIND}:${APP_PUBKEY}:${ORDER_ID}`], ['action', 'account-info']],
    content: `enc:${JSON.stringify({ accountInfo: { bankName: '국민', accountNumber, holderName: '갑' }, salt: 's' })}`,
    sig: 'sig',
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
  const order: Order = {
    orderId: ORDER_ID, status: 'active', state: 'claimed', customerPubkey: 'cust', sponsorPubkey: 'spon',
    price: 10_000, createdAt: 1, updatedAt: 1, expiration: 2_000_000_000, raw: {},
  };
  orders.upsertOrder(order);
});

describe('라이트닝 후원자 계좌 수신 (리뷰 #8)', () => {
  it('고객이 아닌 쪽이 보낸 계좌는 버린다', async () => {
    handleInboxEvent(accountEvent('stranger', '999-999'));
    await flush();
    expect(accounts.getAccountInfo(ORDER_ID)).toBeUndefined();
  });

  it('고객 계좌를 받은 뒤 제3자가 쏴도 바뀌지 않는다', async () => {
    handleInboxEvent(accountEvent('cust', '123-456'));
    await flush();
    handleInboxEvent(accountEvent('stranger', '999-999'));
    await flush();
    expect(accounts.getAccountInfo(ORDER_ID)?.accountNumber).toBe('123-456');
  });
});
