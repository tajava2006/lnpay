/**
 * 반응형 값 하나 (+ localStorage) — 유저 앱·어드민 앱 저장소가 전부 이걸 쓴다
 *
 * 예전엔 저장소 13개가 불러오기·저장·구독 알림을 각자 손으로 짰고, 읽을 때 `JSON.parse(...) as T`로 **믿었다**.
 * 모양이 바뀌면(필드를 빼거나 뜻을 바꾸면) 옛 데이터가 조용히 섞였다. 이제:
 *
 * - **읽을 때 확인한다**(`parse`). 맵 저장소는 항목마다 거른다(`recordOf`) — 망가진 한 건 때문에 나머지를 버리지
 *   않는다. 버린 항목은 대부분 릴레이에서 다시 채워진다(키 옮기기와 같은 경로).
 * - **버전**. 뜻이 바뀌어 모양 확인으로 못 가르면 `version`을 올린다 — 그 저장소는 한 번 비워진다. 버전 표시
 *   (`<key>@v`)가 없으면 1로 본다(이 헬퍼 이전의 데이터가 곧 버전 1이다). 저장 형식은 그대로라 옮길 것이 없다.
 * - **저장 실패는 화면을 막지 않는다**(용량 초과·사생활 모드) — 메모리 값으로 계속 돈다.
 *
 * `get()`은 바뀌기 전까지 같은 참조다 — `useSyncExternalStore`가 스냅샷 동일성으로 다시 그릴지 정한다.
 * 그래서 값을 바꿀 때는 늘 새 객체를 만든다(`update(prev => ({ ...prev, … }))`).
 */

export interface Store<T> {
  get(): T;
  /** 같은 참조면 아무 일도 없다 */
  set(next: T): void;
  update(fn: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
  /** 처음 값으로 — 저장된 것도 지운다 */
  reset(): void;
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface Persist<T> {
  key: string;
  /** 저장된 JSON을 `T`로. 못 쓰면 null → 처음 값 */
  parse: (raw: unknown, key: string) => T | null;
  /** 뜻이 바뀌어 옛 데이터를 한 번 버려야 할 때 올린다. 기본 1 */
  version?: number;
  /** 테스트용 — 기본은 `localStorage` */
  storage?: KeyValueStorage;
}

const versionKey = (key: string) => `${key}@v`;

export function createStore<T>(initial: T, persist?: Persist<T>): Store<T> {
  const backend = (): KeyValueStorage | null => persist?.storage ?? globalThis.localStorage ?? null;
  const version = persist?.version ?? 1;

  function load(): T {
    if (!persist) return initial;
    const s = backend();
    if (!s) return initial;
    try {
      const stored = Number(s.getItem(versionKey(persist.key)) ?? 1);
      if (stored !== version) {
        console.warn(`[저장소] ${persist.key}: 버전 ${stored} → ${version}, 비운다`);
        s.removeItem(persist.key);
        s.setItem(versionKey(persist.key), String(version));
        return initial;
      }
      const raw = s.getItem(persist.key);
      if (raw === null) return initial;
      return persist.parse(JSON.parse(raw), persist.key) ?? initial;
    } catch {
      return initial; // 망가진 JSON·접근 거부
    }
  }

  let value = load();
  const listeners = new Set<() => void>();
  let warnedWrite = false;

  function save(): void {
    if (!persist) return;
    try {
      backend()?.setItem(persist.key, JSON.stringify(value));
    } catch (e) {
      if (!warnedWrite) console.warn(`[저장소] ${persist.key}: 저장 실패 — 메모리로 계속 돈다`, e);
      warnedWrite = true;
    }
  }

  function set(next: T): void {
    if (next === value) return;
    value = next;
    save();
    for (const l of listeners) l();
  }

  return {
    get: () => value,
    set,
    update: fn => set(fn(value)),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reset() {
      value = initial;
      if (persist) {
        try { backend()?.removeItem(persist.key); } catch { /* 지우기 실패는 무시 */ }
      }
      for (const l of listeners) l();
    },
  };
}

/**
 * 맵 저장소의 `parse` — 항목마다 거른다. 맵 자체가 아니면 null(처음 값).
 * 버린 항목이 있으면 개수를 남긴다(값은 남기지 않는다 — 계좌 같은 게 들어 있다).
 */
export function recordOf<V>(isValue: (v: unknown) => v is V): (raw: unknown, key: string) => Record<string, V> | null {
  return (raw, key) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const out: Record<string, V> = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (isValue(v)) out[k] = v;
      else dropped++;
    }
    if (dropped > 0) console.warn(`[저장소] ${key}: 모양이 안 맞는 항목 ${dropped}건을 버렸다`);
    return out;
  };
}
