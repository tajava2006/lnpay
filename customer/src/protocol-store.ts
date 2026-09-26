/**
 * 이 앱보다 새 데몬을 봤나 — 캐시된 옛 앱이면 새로고침을 권한다 (`PROTOCOL_VERSION`)
 *
 * 오더 이벤트의 `protocol` 태그를 본다. 저장하지 않는다 — 새로고침하면 새 앱이 뜨고 처음부터 다시 본다.
 * 데몬이 이 앱보다 **옛것**인 경우는 유저가 할 일이 없어 여기서 다루지 않는다(어드민이 경고한다).
 */
import { PROTOCOL_VERSION, createStore, protocolOf } from '@sajwo-tracker/shared';

/** 본 것 중 이 앱보다 새 버전 (없으면 null) */
const ahead = createStore<number | null>(null);

export const subscribeProtocolAhead = ahead.subscribe;
export const getProtocolAhead = ahead.get;

/** 오더 이벤트가 오면 부른다 */
export function noteOrderProtocol(tags: readonly string[][]): void {
  const v = protocolOf(tags);
  if (v === null || v <= PROTOCOL_VERSION) return;
  if ((ahead.get() ?? 0) < v) ahead.set(v);
}

/** @testing-only */
export const _resetForTesting = ahead.reset;
