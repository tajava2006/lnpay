/**
 * 모양 확인 — 브라우저 저장소에서 읽은 값을 믿지 않는다
 *
 * `JSON.parse(...) as T`는 확인이 아니라 선언이다. 저장된 모양이 옛것이거나(필드를 빼거나 뜻을 바꾼 뒤) 망가졌으면
 * 그대로 화면·서명 경로에 흘러든다. 여기 가드로 **코드가 기대는 칸**만 본다 — 적지 않은 칸은 보지 않는다(선택 칸을
 * 전부 적으면 칸 하나 더할 때마다 옛 데이터가 통째로 버려진다).
 */

export type Guard = (v: unknown) => boolean;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isStr = (v: unknown): v is string => typeof v === 'string';

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** 없어도 되는 칸 — 있으면 이 모양 */
export const optional = (g: Guard): Guard => v => v === undefined || g(v);

/** 이 값들 중 하나 */
export function oneOf(values: Iterable<string>): Guard {
  const set = new Set(values);
  return v => typeof v === 'string' && set.has(v);
}

/** 원소가 전부 이 모양인 배열 */
export function arrayOf<T>(g: (v: unknown) => v is T): (v: unknown) => v is T[] {
  return (v: unknown): v is T[] => Array.isArray(v) && v.every(g);
}

/**
 * 적은 칸이 전부 맞는 객체면 `T`로 본다. **적은 칸만 확인한다** — `T`의 나머지 칸은 믿는다.
 */
export function shape<T>(spec: Record<string, Guard>): (v: unknown) => v is T {
  const entries = Object.entries(spec);
  return (v: unknown): v is T => isObject(v) && entries.every(([k, g]) => g(v[k]));
}
