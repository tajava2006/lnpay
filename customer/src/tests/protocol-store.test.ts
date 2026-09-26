/**
 * 새 데몬 알아보기 — 캐시된 옛 앱이면 새로고침 배너
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@sajwo-tracker/shared';
import { _resetForTesting, getProtocolAhead, noteOrderProtocol } from '../protocol-store';

beforeEach(() => _resetForTesting());

describe('noteOrderProtocol', () => {
  it('같거나 옛 버전·버전 없는 오더는 아무 일도 없다', () => {
    noteOrderProtocol([['protocol', String(PROTOCOL_VERSION)]]);
    noteOrderProtocol([['protocol', String(PROTOCOL_VERSION - 1)]]);
    noteOrderProtocol([['d', 'x']]);
    expect(getProtocolAhead()).toBeNull();
  });

  it('이 앱보다 새 버전을 보면 기억한다 — 가장 새 것', () => {
    noteOrderProtocol([['protocol', String(PROTOCOL_VERSION + 2)]]);
    noteOrderProtocol([['protocol', String(PROTOCOL_VERSION + 1)]]);
    expect(getProtocolAhead()).toBe(PROTOCOL_VERSION + 2);
  });
});
