import { describe, it, expect, vi } from 'vitest';
import { createSubscriptionGuard } from '@sajwo-tracker/shared';

/** 시작이 await에 걸려 있는 구독 팩토리. resolve()로 완료 시점을 직접 조종한다. */
function deferredFactory() {
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const gates: Array<() => void> = [];

  const factory = () =>
    new Promise<() => void>((resolve) => {
      const cleanup = vi.fn();
      cleanups.push(cleanup);
      gates.push(() => resolve(cleanup));
    });

  return {
    factory,
    cleanups,
    /** n번째 시작을 완료시킨다 */
    resolve: async (n: number) => {
      gates[n]!();
      await Promise.resolve();
      await Promise.resolve();
    },
    started: () => gates.length,
  };
}

describe('createSubscriptionGuard', () => {
  it('시작이 진행 중이면 중복 진입해도 구독을 두 번 만들지 않는다', async () => {
    const guard = createSubscriptionGuard('test');
    const f = deferredFactory();

    void guard.start(f.factory);
    void guard.start(f.factory); // await 구간에 재진입
    void guard.start(f.factory);

    expect(f.started()).toBe(1);

    await f.resolve(0);
    expect(guard.active).toBe(true);
    expect(f.cleanups[0]).not.toHaveBeenCalled();
  });

  it('이미 살아있으면 새 구독을 만들지 않는다', async () => {
    const guard = createSubscriptionGuard('test');
    const f = deferredFactory();

    void guard.start(f.factory);
    await f.resolve(0);

    void guard.start(f.factory);
    expect(f.started()).toBe(1);
  });

  // 회귀 방지: 모바일에서 로드 직후 visibilitychange가 뜨면 벌어지던 일.
  // 예전 코드는 stop 시점에 핸들이 null이라 아무것도 닫지 못했고,
  // 가드도 통과해 두 번째 구독이 생기면서 첫 번째가 영구 누수됐다.
  it('시작 대기 중에 stop이 끼어들면, 뒤늦게 완료된 구독을 스스로 닫는다', async () => {
    const guard = createSubscriptionGuard('test');
    const f = deferredFactory();

    void guard.start(f.factory); // (1) 시작 — 아직 대기 중
    guard.stop();                // (2) 대기 중에 stop
    void guard.start(f.factory); // (3) 재시작

    expect(f.started()).toBe(2);

    await f.resolve(0); // 무효화된 첫 번째가 뒤늦게 완료
    expect(f.cleanups[0]).toHaveBeenCalledTimes(1); // 유령이므로 스스로 닫힘
    expect(guard.active).toBe(false);

    await f.resolve(1); // 두 번째가 완료
    expect(f.cleanups[1]).not.toHaveBeenCalled();
    expect(guard.active).toBe(true);

    guard.stop();
    expect(f.cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it('stop은 살아있는 구독을 닫고 재시작을 허용한다', async () => {
    const guard = createSubscriptionGuard('test');
    const f = deferredFactory();

    void guard.start(f.factory);
    await f.resolve(0);
    guard.stop();

    expect(f.cleanups[0]).toHaveBeenCalledTimes(1);
    expect(guard.active).toBe(false);

    void guard.start(f.factory);
    await f.resolve(1);
    expect(guard.active).toBe(true);
  });

  it('시작이 실패해도 가드가 잠기지 않는다', async () => {
    const guard = createSubscriptionGuard('test');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await guard.start(() => Promise.reject(new Error('relay down')));
    expect(guard.active).toBe(false);
    expect(err).toHaveBeenCalled();

    const cleanup = vi.fn();
    await guard.start(() => Promise.resolve(cleanup));
    expect(guard.active).toBe(true);

    err.mockRestore();
  });
});
