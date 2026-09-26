/**
 * 저장소 헬퍼 — 읽을 때 모양 확인 · 버전 · 저장 실패
 *
 * 저장 형식은 헬퍼 전과 같다(키·값 그대로) — 여기 테스트가 그걸 못박는다. 형식이 바뀌면 이미 쓰던 유저의
 * 로컬 기록이 한꺼번에 사라진다.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStore, recordOf } from '../persisted-store';
import { isNum, isStr, optional, shape } from '../shape';

/** 메모리 localStorage — 실패를 흉내 낼 수 있다 */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    failWrites: false,
    getItem: (k: string) => data.get(k) ?? null,
    setItem(k: string, v: string) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => { data.delete(k); },
  };
}

interface Item { id: string; n: number; note?: string }
const isItem = shape<Item>({ id: isStr, n: isNum, note: optional(isStr) });

describe('불러오기', () => {
  it('헬퍼 전 형식(값 JSON 그대로)을 그대로 읽는다 — 옮길 것이 없다', () => {
    const storage = memoryStorage({ k: JSON.stringify({ a: { id: 'a', n: 1 } }) });
    const store = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), storage });
    expect(store.get()).toEqual({ a: { id: 'a', n: 1 } });
  });

  it('모양이 틀린 항목만 버린다 — 망가진 한 건 때문에 나머지를 버리지 않는다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage({
      k: JSON.stringify({ a: { id: 'a', n: 1 }, b: { id: 'b', n: 'x' }, c: null, d: { id: 'd', n: 2, note: 3 } }),
    });
    const store = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), storage });
    expect(Object.keys(store.get())).toEqual(['a']);
    vi.restoreAllMocks();
  });

  it('맵이 아니거나 JSON이 망가졌으면 처음 값', () => {
    for (const raw of ['[1,2]', '"str"', 'null', '{not json']) {
      const store = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), storage: memoryStorage({ k: raw }) });
      expect(store.get()).toEqual({});
    }
  });
});

describe('버전', () => {
  it('표시가 없으면 1이다 — 헬퍼 전 데이터는 버전 1로 읽힌다', () => {
    const storage = memoryStorage({ k: JSON.stringify({ a: { id: 'a', n: 1 } }) });
    const store = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), version: 1, storage });
    expect(store.get()).toHaveProperty('a');
    expect(storage.data.has('k@v')).toBe(false);
  });

  it('올리면 한 번 비우고 새 버전을 적는다 — 그 뒤로는 유지된다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage({ k: JSON.stringify({ a: { id: 'a', n: 1 } }) });
    const v2 = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), version: 2, storage });
    expect(v2.get()).toEqual({});
    expect(storage.data.get('k@v')).toBe('2');

    v2.set({ b: { id: 'b', n: 2 } });
    const again = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), version: 2, storage });
    expect(again.get()).toEqual({ b: { id: 'b', n: 2 } });
    vi.restoreAllMocks();
  });
});

describe('쓰기 · 알림', () => {
  it('바뀌면 저장하고 알린다. 같은 참조면 아무 일도 없다', () => {
    const storage = memoryStorage();
    const store = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), storage });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(store.get());
    expect(listener).not.toHaveBeenCalled();

    store.update(prev => ({ ...prev, a: { id: 'a', n: 1 } }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data.get('k')!)).toEqual({ a: { id: 'a', n: 1 } });
  });

  it('저장이 실패해도(용량 초과) 메모리 값으로 계속 돈다 — 화면을 막지 않는다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage();
    storage.failWrites = true;
    const store = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), storage });
    expect(() => store.set({ a: { id: 'a', n: 1 } })).not.toThrow();
    expect(store.get()).toEqual({ a: { id: 'a', n: 1 } });
    vi.restoreAllMocks();
  });

  it('구독을 풀면 더 알리지 않는다', () => {
    const store = createStore(0);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.set(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset은 처음 값으로 돌리고 저장된 것도 지운다', () => {
    const storage = memoryStorage({ k: JSON.stringify({ a: { id: 'a', n: 1 } }) });
    const store = createStore<Record<string, Item>>({}, { key: 'k', parse: recordOf(isItem), storage });
    store.reset();
    expect(store.get()).toEqual({});
    expect(storage.data.has('k')).toBe(false);
  });

  it('저장 없는 저장소는 저장소를 건드리지 않는다', () => {
    const storage = memoryStorage();
    const store = createStore(false);
    store.set(true);
    expect(store.get()).toBe(true);
    expect(storage.data.size).toBe(0);
  });
});
