/**
 * 워처 소유권 (PLAN-ONCHAIN-TRACK §9.1)
 *
 * 여기서 지키는 건 하나다: **두 기기가 동시에 집행하지 않는다.** 온체인에서
 * 그게 깨지면 한 주문에 에스크로 주소가 둘 생기고, 고객이 먼저 본 쪽에 돈을
 * 넣으면 살아남은 주문에 적히지 않은 주소로 자금이 들어간다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let stored: unknown = null;
let readable = true;
const publishes: unknown[] = [];

vi.mock('../nostr/app-state-backup', () => ({
  publishAppState: vi.fn(async (_tag: string, data: unknown) => {
    if (!readable) throw new Error('모든 릴레이에 발행 실패');
    publishes.push(data);
    stored = data;
  }),
  fetchAppState: vi.fn(async () => (readable ? stored : null)),
  fetchAppStateResult: vi.fn(async () => (
    readable ? { known: true, value: stored } : { known: false, value: null }
  )),
}));

const lease = await import('../onchain/lease');
const { HANDOVER_DELAY_SEC, OWNER_STALE_SEC, leaseVerdict } = lease;

const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  stored = null;
  readable = true;
  publishes.length = 0;
  lease._resetForTesting();
});

// ── 판정표 (순수 함수) ───────────────────────────────────────

describe('leaseVerdict', () => {
  const mine = { deviceId: 'me', label: 'Mac · Chrome', claimedAt: 1_000 };

  it('내 것이고 인수 지연이 지났으면 집행한다', () => {
    const v = leaseVerdict({
      lease: mine, myDeviceId: 'me',
      now: 1_000 + HANDOVER_DELAY_SEC, lastReadAt: 1_000 + HANDOVER_DELAY_SEC,
    });
    expect(v).toEqual({ holder: 'mine', acting: true, why: null });
  });

  it('가져온 직후에는 기다린다 — 옛 주인이 알아챌 시간이다', () => {
    const v = leaseVerdict({
      lease: mine, myDeviceId: 'me',
      now: 1_000 + HANDOVER_DELAY_SEC - 1, lastReadAt: 1_000,
    });
    expect(v.acting).toBe(false);
    expect(v.why).toBe('handover-wait');
  });

  it('남의 것이면 집행하지 않는다', () => {
    const v = leaseVerdict({
      lease: { ...mine, deviceId: 'phone' }, myDeviceId: 'me',
      now: 9_000, lastReadAt: 9_000,
    });
    expect(v).toEqual({ holder: 'other', acting: false, why: 'other-device' });
  });

  it('아무도 안 잡았으면 스스로 시작하지 않는다', () => {
    const v = leaseVerdict({ lease: null, myDeviceId: 'me', now: 9_000, lastReadAt: 9_000 });
    expect(v).toEqual({ holder: 'none', acting: false, why: 'no-lease' });
  });

  it('한 번도 못 읽었으면 멈춘다 — 모름은 소유가 아니다', () => {
    const v = leaseVerdict({ lease: mine, myDeviceId: 'me', now: 9_000, lastReadAt: null });
    expect(v.acting).toBe(false);
    expect(v.why).toBe('stale');
  });

  it('내 것이어도 확인이 오래 끊기면 멈춘다 — 분단의 양쪽이 다 도는 걸 막는다', () => {
    const readAt = 9_000;
    const justOk = leaseVerdict({
      lease: mine, myDeviceId: 'me', now: readAt + OWNER_STALE_SEC, lastReadAt: readAt,
    });
    expect(justOk.acting).toBe(true);

    const stale = leaseVerdict({
      lease: mine, myDeviceId: 'me', now: readAt + OWNER_STALE_SEC + 1, lastReadAt: readAt,
    });
    expect(stale.acting).toBe(false);
    expect(stale.why).toBe('stale');
  });
});

// ── 릴레이와 붙은 부분 ───────────────────────────────────────

describe('소유권 조회·주장', () => {
  it('잡으면 발행하고, 인수 지연이 지나야 집행한다', async () => {
    const snapshot = await lease.claimWatcherLease();
    expect(publishes).toHaveLength(1);
    expect(snapshot.holder).toBe('mine');
    expect(snapshot.acting).toBe(false);
    expect(lease.canActOnchainNow(now() + HANDOVER_DELAY_SEC)).toBe(true);
  });

  it('발행이 실패하면 소유권도 없다 — 릴레이가 죽었을 때 빼앗기를 막는다', async () => {
    stored = { deviceId: 'phone', label: 'iOS · Safari', claimedAt: now() - 10_000 };
    readable = false;

    await expect(lease.claimWatcherLease()).rejects.toThrow();
    expect(lease.canActOnchainNow(now() + HANDOVER_DELAY_SEC)).toBe(false);
  });

  it('남이 잡고 있으면 조회만으로 집행권이 생기지 않는다', async () => {
    stored = { deviceId: 'phone', label: 'iOS · Safari', claimedAt: now() - 10_000 };
    const snapshot = await lease.refreshWatcherLease();
    expect(snapshot.holder).toBe('other');
    expect(snapshot.acting).toBe(false);
  });

  it('내가 잡은 뒤 남이 가져가면 다음 조회에서 멈춘다', async () => {
    await lease.claimWatcherLease();
    expect(lease.canActOnchainNow(now() + HANDOVER_DELAY_SEC)).toBe(true);

    stored = { deviceId: 'phone', label: 'iOS · Safari', claimedAt: now() + 1 };
    await lease.refreshWatcherLease();
    expect(lease.canActOnchainNow(now() + HANDOVER_DELAY_SEC)).toBe(false);
  });

  it('전파가 덜 된 릴레이의 **옛** 주장은 무시한다', async () => {
    await lease.claimWatcherLease();
    const mineAt = lease.getLeaseSnapshot().lease?.claimedAt ?? 0;

    // 같은 d-tag의 옛 본을 들고 있는 릴레이가 먼저 답한 상황
    stored = { deviceId: 'phone', label: 'iOS · Safari', claimedAt: mineAt - 60 };
    const snapshot = await lease.refreshWatcherLease();
    expect(snapshot.holder).toBe('mine');
  });

  it('못 읽으면 읽은 시각을 갱신하지 않는다 — 그래야 스스로 만료된다', async () => {
    await lease.claimWatcherLease();
    const t = now();
    expect(lease.canActOnchainNow(t + HANDOVER_DELAY_SEC)).toBe(true);

    readable = false;
    await lease.refreshWatcherLease();
    expect(lease.canActOnchainNow(t + OWNER_STALE_SEC + 60)).toBe(false);
  });

  it('스냅샷은 내용이 그대로면 같은 참조다 (무한 렌더 방지)', async () => {
    await lease.claimWatcherLease();
    const first = lease.getLeaseSnapshot();
    await lease.refreshWatcherLease();
    expect(lease.getLeaseSnapshot()).toBe(first);
  });
});

// ── 워처가 실제로 멈추는가 ───────────────────────────────────

describe('워처 게이트', () => {
  it('집행권이 없으면 보증금 감시조차 안 돈다', async () => {
    const watcher = await import('../onchain/watcher');
    const checkDeposits = vi.fn(async () => {});
    const listOrders = vi.fn(() => []);

    watcher.startOnchainWatcher({
      now,
      chain: {} as never,
      btcPriceKrw: () => undefined,
      sponsorBondAlive: async () => undefined,
      accountInfoSent: () => false,
      releaseFeeSat: () => undefined,
      commit: async () => null,
      prepareSettlement: async () => {},
      onOutcome: () => {},
      raise: () => {},
      listOrders,
      checkDeposits,
      canAct: async () => false,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    watcher.stopOnchainWatcher();

    expect(checkDeposits).not.toHaveBeenCalled();
    expect(listOrders).not.toHaveBeenCalled();
  });
});
