/**
 * 한쪽만 배포했을 때의 경고 — 데몬과 이 앱의 프로토콜 비교
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@sajwo-tracker/shared';
import { protocolWarning } from './format';

describe('protocolWarning', () => {
  it('같으면·상태를 아직 모르면 말하지 않는다', () => {
    expect(protocolWarning({ protocol: PROTOCOL_VERSION })).toBeNull();
    expect(protocolWarning(null)).toBeNull();
  });

  it('데몬이 옛것이면 데몬을 다시 빌드하라고 — 버전을 안 싣는 옛 데몬도', () => {
    expect(protocolWarning({})).toMatch(/다시 빌드/);
    expect(protocolWarning({ protocol: PROTOCOL_VERSION - 1 })).toMatch(/다시 빌드/);
  });

  it('이 앱이 옛것이면 새로고침·배포하라고', () => {
    expect(protocolWarning({ protocol: PROTOCOL_VERSION + 1 })).toMatch(/pnpm ship/);
  });
});
