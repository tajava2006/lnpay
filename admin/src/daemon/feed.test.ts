/**
 * 지정 거래 스냅샷 — 벙커(원격 서명기)에 묻는 횟수
 *
 * 복호화는 NIP-46 왕복이라 N번이면 승인 창이 N개 뜰 수 있다. 구독을 다시 열 때마다 보존 중인 스냅샷이 전부 다시 오므로
 * **열 필요가 없으면 묻지 않아야** 한다(2026-10-18 리뷰).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { APP_PUBKEY, CLIENT_TAG, DESIGNATED_ORDER_KIND, type AdminState } from '@sajwo-tracker/shared';
import { lnOrderTags } from '@sajwo-tracker/shared/ln';

const decrypts: string[] = [];
let plaintext = '';
vi.mock('../nostr/nip46', () => ({
  getSigner: () => ({
    nip44Decrypt: async (_pubkey: string, content: string) => {
      decrypts.push(content);
      return plaintext;
    },
  }),
}));

const { onDesignatedEvent } = await import('./feed');
const { clearStores, daemonState, lnOrders } = await import('./stores');

const NOW = Math.floor(Date.now() / 1000);
const OPERATOR = 'ab'.repeat(32);

function snapshot(orderId: string, createdAt: number, retainUntil = NOW + 86_400): Event {
  plaintext = JSON.stringify(lnOrderTags({
    orderId, state: 'requested', customerPubkey: 'c'.repeat(64), price: 32_900, deadline: NOW + 86_400,
    designatedSponsor: 'd'.repeat(64),
  }, CLIENT_TAG, retainUntil));
  return {
    kind: DESIGNATED_ORDER_KIND, pubkey: APP_PUBKEY, created_at: createdAt, id: `${orderId}-${createdAt}`, sig: '',
    tags: [['d', `${orderId}:${OPERATOR}`], ['p', OPERATOR], ['t', CLIENT_TAG], ['expiration', String(retainUntil)]],
    content: `cipher-${createdAt}`,
  };
}

beforeEach(() => {
  clearStores();
  decrypts.length = 0;
  daemonState.set({ state: { v: 1, epoch: NOW - 3600 } as AdminState, eventAt: NOW });
});

describe('지정 스냅샷 — 벙커에 묻는 횟수', () => {
  it('처음 것은 열어 목록에 넣고, 같은 것이 다시 오면(재구독·다른 릴레이) 묻지 않는다', async () => {
    await onDesignatedEvent(snapshot('o1', NOW - 60));
    expect(lnOrders.get().o1?.designatedSponsor).toBe('d'.repeat(64));
    await onDesignatedEvent(snapshot('o1', NOW - 60));
    expect(decrypts).toHaveLength(1);
  });

  it('여러 릴레이가 동시에 줘도 한 번', async () => {
    await Promise.all([onDesignatedEvent(snapshot('o2', NOW - 30)), onDesignatedEvent(snapshot('o2', NOW - 30))]);
    expect(decrypts).toHaveLength(1);
  });

  it('이미 가진 것보다 옛것 · 보존이 끝난 것은 묻지 않고, 새것은 연다', async () => {
    await onDesignatedEvent(snapshot('o3', NOW - 10));
    await onDesignatedEvent(snapshot('o3', NOW - 100)); // 옛 상태
    await onDesignatedEvent(snapshot('o4', NOW - 10, NOW - 1)); // 보존 끝
    expect(decrypts).toHaveLength(1);
    await onDesignatedEvent(snapshot('o3', NOW - 5)); // 새 상태
    expect(decrypts).toHaveLength(2);
  });
});
