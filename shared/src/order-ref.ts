/**
 * 오더 좌표 (`<ORDER_KIND>:<APP>:<orderId>`) — 요청 이벤트의 `a` 태그.
 *
 * 순수 모듈로 따로 둔다 — `dispute-message.ts`는 IndexedDB를 끌고 와서 데몬(Node)이 못 부른다.
 */
import { ORDER_KIND } from './constants';

/** `a` 태그에서 orderId. 형식이 다르면 null */
export function extractOrderId(tags: string[][]): string | null {
  const aTag = tags.find(t => t[0] === 'a')?.[1];
  if (!aTag) return null;
  const parts = aTag.split(':');
  if (parts.length < 3 || parts[0] !== String(ORDER_KIND)) return null;
  return parts[2]!;
}

/** `a` 태그 값 */
export function orderRef(appPubkey: string, orderId: string): string {
  return `${ORDER_KIND}:${appPubkey}:${orderId}`;
}
