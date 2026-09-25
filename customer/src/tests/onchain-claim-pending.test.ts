/**
 * 클레임을 보낸 뒤 답을 기다리는 중인가 — 그동안 폼을 잠근다 (2026-09-25 드릴)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetForTesting, forgetMyClaim, pendingClaim, rememberMyClaim } from '../onchain/claim-store';

const T = 1_800_000_000_000; // ms

afterEach(() => {
  _resetForTesting();
  vi.useRealTimers();
});

function claimAt(ms: number) {
  rememberMyClaim({ orderId: 'o', payoutAddress: 'tb1q', feerateSatPerVb: 5, requestedAt: ms });
}

describe('pendingClaim', () => {
  it('보내고 아무 답이 없으면 기다리는 중', () => {
    claimAt(T);
    expect(pendingClaim('o', undefined, undefined)).toMatchObject({ feerateSatPerVb: 5 });
  });

  it('보낸 뒤 인보이스나 거절이 오면 끝', () => {
    claimAt(T);
    expect(pendingClaim('o', T / 1000 + 3, undefined)).toBeNull();
    expect(pendingClaim('o', undefined, T / 1000 + 3)).toBeNull();
  });

  it('보내기 전의 옛 답(지난 클레임의 인보이스·거절)은 이 요청의 답이 아니다', () => {
    claimAt(T);
    expect(pendingClaim('o', T / 1000 - 3600, T / 1000 - 3600)).not.toBeNull();
  });

  it('데몬 시계가 조금 뒤처져도 답으로 친다', () => {
    claimAt(T);
    expect(pendingClaim('o', T / 1000 - 30, undefined)).toBeNull();
  });

  it('보낸 적 없거나 발행에 실패해 잊었으면 기다리지 않는다', () => {
    expect(pendingClaim('o', undefined, undefined)).toBeNull();
    claimAt(T);
    forgetMyClaim('o');
    expect(pendingClaim('o', undefined, undefined)).toBeNull();
  });

  it('옛 기록(requestedAt 없음)은 기다리지 않는다', () => {
    rememberMyClaim({ orderId: 'o', payoutAddress: 'tb1q', feerateSatPerVb: 5 });
    expect(pendingClaim('o', undefined, undefined)).toBeNull();
  });
});
