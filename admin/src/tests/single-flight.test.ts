import { describe, it, expect, vi } from 'vitest';
import { createSingleFlight } from '@sajwo-tracker/shared';

/** resolve를 밖에서 잡아 완료 시점을 조종한다. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createSingleFlight', () => {
  // 회귀 방지의 핵심: disburseSponsor는 "disbursed 검사 → LN 결제 await → 기록" 모양이라
  // 결제가 끝나기 전에 두 번째 호출이 들어오면 둘 다 결제를 시도했었다.
  it('진행 중인 키로 다시 들어오면 fn을 부르지 않는다', async () => {
    const flight = createSingleFlight();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);

    const first = flight.run('order-1', fn, () => 'BUSY');
    const second = await flight.run('order-1', fn, () => 'BUSY');

    expect(second).toBe('BUSY');
    expect(fn).toHaveBeenCalledTimes(1); // 두 번째는 실행 자체가 없었다

    gate.resolve('DONE');
    expect(await first).toBe('DONE');
  });

  it('키가 다르면 서로 막지 않는다', async () => {
    const flight = createSingleFlight();
    const a = deferred<string>();
    const b = deferred<string>();

    const p1 = flight.run('order-1', () => a.promise, () => 'BUSY');
    const p2 = flight.run('order-2', () => b.promise, () => 'BUSY');

    expect(flight.isBusy('order-1')).toBe(true);
    expect(flight.isBusy('order-2')).toBe(true);

    a.resolve('A');
    b.resolve('B');
    expect(await p1).toBe('A');
    expect(await p2).toBe('B');
  });

  it('완료되면 같은 키로 다시 실행할 수 있다', async () => {
    const flight = createSingleFlight();
    const fn = vi.fn(async () => 'DONE');

    expect(await flight.run('order-1', fn, () => 'BUSY')).toBe('DONE');
    expect(flight.isBusy('order-1')).toBe(false);
    expect(await flight.run('order-1', fn, () => 'BUSY')).toBe('DONE');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // fn이 던져도 키가 풀려야 한다. 안 그러면 한 번 실패한 오더가 영구히 지급 불가가 된다.
  it('fn이 실패해도 키가 잠기지 않는다', async () => {
    const flight = createSingleFlight();

    await expect(
      flight.run('order-1', () => Promise.reject(new Error('LN 장애')), () => 'BUSY'),
    ).rejects.toThrow('LN 장애');

    expect(flight.isBusy('order-1')).toBe(false);
    expect(await flight.run('order-1', async () => 'DONE', () => 'BUSY')).toBe('DONE');
  });

  it('동시에 여러 번 들어와도 한 번만 실행된다', async () => {
    const flight = createSingleFlight();
    const gate = deferred<number>();
    const fn = vi.fn(() => gate.promise);

    const results = [
      flight.run('order-1', fn, () => -1),
      flight.run('order-1', fn, () => -1),
      flight.run('order-1', fn, () => -1),
      flight.run('order-1', fn, () => -1),
    ];

    gate.resolve(42);
    const settled = await Promise.all(results);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(settled.filter(r => r === 42)).toHaveLength(1);
    expect(settled.filter(r => r === -1)).toHaveLength(3);
  });
});
