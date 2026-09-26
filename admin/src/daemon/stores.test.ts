/**
 * 캐시 청소 — 데몬 epoch 전의 오더(옛 프론트 어드민 시절)와 릴레이 보존이 끝난 것은 보이지 않는다
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminState, Order } from '@sajwo-tracker/shared';
import type { OnchainOrder } from '@sajwo-tracker/shared/onchain';
import {
  chats, clearStores, daemonEpoch, daemonState, lnDetails, lnOrderAlive, lnOrders, ocDetails, onchainOrders,
  pruneStores, upsertOrder,
} from './stores';

const EPOCH = 1_800_000_000;
const NOW = EPOCH + 86_400;

function withEpoch(epoch: number | undefined): void {
  const state = { v: 1, mode: 'prod', startedAt: EPOCH, heartbeatAt: NOW, ...(epoch !== undefined ? { epoch } : {}) };
  daemonState.set({ state: state as AdminState, eventAt: NOW });
}

function ln(orderId: string, createdAt: number, retainUntil = NOW + 3600): Order {
  return {
    orderId, state: 'requested', customerPubkey: 'c', price: 1000,
    createdAt, updatedAt: createdAt, expiration: createdAt + 600, retainUntil, raw: {},
  };
}

function oc(orderId: string, createdAt: number, expiration = NOW + 3600): OnchainOrder {
  return {
    orderId, state: 'listed', customerPubkey: 'c', amountSat: 100_000,
    createdAt, updatedAt: createdAt, expiration, network: 'signet',
  } as OnchainOrder;
}

beforeEach(() => clearStores());

describe('epoch', () => {
  it('상태에 epoch가 없으면(옛 데몬) 모른다 — 오더를 하나도 보지 않는다', () => {
    withEpoch(undefined);
    expect(daemonEpoch()).toBeNull();
    expect(lnOrderAlive(ln('a', NOW), null, NOW)).toBe(false);
  });

  it('epoch 전에 발행된 오더는 지운다 — 옛 프론트 어드민 시절 것', () => {
    withEpoch(EPOCH);
    lnOrders.set({ old: ln('old', EPOCH - 1), fresh: ln('fresh', EPOCH) });
    onchainOrders.set({ old: oc('old', EPOCH - 100), fresh: oc('fresh', EPOCH + 5) });
    pruneStores(NOW);
    expect(Object.keys(lnOrders.get())).toEqual(['fresh']);
    expect(Object.keys(onchainOrders.get())).toEqual(['fresh']);
  });

  it('epoch를 모르면 캐시에 남은 오더도 지운다', () => {
    withEpoch(undefined);
    lnOrders.set({ a: ln('a', NOW) });
    pruneStores(NOW);
    expect(lnOrders.get()).toEqual({});
  });
});

describe('보존', () => {
  it('릴레이 보존이 끝난 오더는 캐시에서도 지운다 — 라이트닝은 retainUntil, 온체인은 expiration', () => {
    withEpoch(EPOCH);
    lnOrders.set({ gone: ln('gone', EPOCH + 1, NOW), kept: ln('kept', EPOCH + 1, NOW + 1) });
    onchainOrders.set({ gone: oc('gone', EPOCH + 1, NOW - 1), kept: oc('kept', EPOCH + 1) });
    pruneStores(NOW);
    expect(Object.keys(lnOrders.get())).toEqual(['kept']);
    expect(Object.keys(onchainOrders.get())).toEqual(['kept']);
  });

  it('오더가 가면 그 상세와 채팅도 같이 간다', () => {
    withEpoch(EPOCH);
    lnOrders.set({ old: ln('old', EPOCH - 1), live: ln('live', EPOCH + 1) });
    lnDetails.set({
      old: { detail: { orderId: 'old' } as never, eventAt: EPOCH - 1 },
      live: { detail: { orderId: 'live' } as never, eventAt: EPOCH + 1 },
    });
    chats.set({ 'ln:old': [], 'ln:live': [], 'onchain:old': [] });
    pruneStores(NOW);
    expect(Object.keys(lnDetails.get())).toEqual(['live']);
    // 같은 id라도 트랙이 다르면 남긴다
    expect(Object.keys(chats.get()).sort()).toEqual(['ln:live', 'onchain:old']);
  });

  it('상세는 자기 보존이 끝나도 간다', () => {
    withEpoch(EPOCH);
    ocDetails.set({ x: { detail: { orderId: 'x' } as never, eventAt: EPOCH + 1, retainUntil: NOW } });
    onchainOrders.set({ x: oc('x', EPOCH + 1) });
    pruneStores(NOW);
    expect(ocDetails.get()).toEqual({});
    expect(Object.keys(onchainOrders.get())).toEqual(['x']);
  });

  it('지울 게 없으면 저장소를 건드리지 않는다 (구독자를 깨우지 않는다)', () => {
    withEpoch(EPOCH);
    const before = { a: ln('a', EPOCH + 1) };
    lnOrders.set(before);
    pruneStores(NOW);
    expect(lnOrders.get()).toBe(before);
  });
});

describe('upsertOrder', () => {
  it('더 새 버전만 반영한다', () => {
    upsertOrder(lnOrders, ln('a', EPOCH + 10), true);
    upsertOrder(lnOrders, ln('a', EPOCH + 5), true);
    expect(lnOrders.get().a!.updatedAt).toBe(EPOCH + 10);
  });

  it('더 새 버전이 이미 보존이 끝났으면 캐시의 옛 버전도 지운다', () => {
    upsertOrder(lnOrders, ln('a', EPOCH + 10), true);
    upsertOrder(lnOrders, ln('a', EPOCH + 20), false);
    expect(lnOrders.get()).toEqual({});
  });

  it('더 옛 버전이 죽었다고 해서 새 버전을 지우지 않는다', () => {
    upsertOrder(lnOrders, ln('a', EPOCH + 20), true);
    upsertOrder(lnOrders, ln('a', EPOCH + 10), false);
    expect(Object.keys(lnOrders.get())).toEqual(['a']);
  });
});
