/**
 * 어드민 맨 위 경고 — 한쪽만 배포했을 때(프로토콜 비교) · 라이트닝 공개 보증금이 꺼져 있을 때
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, type DaemonSettings } from '@sajwo-tracker/shared';
import { depositWarnings, protocolWarning } from './format';

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

/** D9 — 보증금 0%로 운영했더니 의뢰 하나 올리자마자 트롤이 찜하고 잠수탔다. 막지는 않고 맨 위에 띄운다 */
describe('depositWarnings', () => {
  const withLn = (ln: Partial<DaemonSettings['ln']>) => ({ settings: { ...DEFAULT_SETTINGS, ln: { ...DEFAULT_SETTINGS.ln, ...ln } } });

  it('상태를 모르면 말하지 않는다', () => {
    expect(depositWarnings(null)).toEqual([]);
  });

  it('둘 다 켜져 있으면 없다', () => {
    expect(depositWarnings(withLn({ customerDepositPct: 1, sponsorDepositPct: 3 }))).toEqual([]);
  });

  it('후원자 0%면 찜 트롤, 고객 0%면 스팸 — 따로 말한다', () => {
    expect(depositWarnings(withLn({ customerDepositPct: 1, sponsorDepositPct: 0 }))).toEqual([expect.stringMatching(/후원자 보증금 0%.*지정 거래/)]);
    expect(depositWarnings(withLn({ customerDepositPct: 0, sponsorDepositPct: 3 }))).toEqual([expect.stringMatching(/고객 보증금 0%/)]);
    // 기본값(둘 다 0%)이면 둘 다
    expect(depositWarnings({ settings: DEFAULT_SETTINGS })).toHaveLength(2);
  });
});
