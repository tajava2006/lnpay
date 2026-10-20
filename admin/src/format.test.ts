/**
 * 어드민 맨 위 경고 — 한쪽만 배포했을 때(프로토콜 비교) · 라이트닝 공개 보증금이 꺼져 있을 때
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, type DaemonSettings, type OrderState } from '@sajwo-tracker/shared';
import { LN_PAYOUT_INVOICE_EXPIRED, LN_PAYOUT_MANUAL, LN_PAYOUT_MANUAL_REQUESTED } from '@sajwo-tracker/shared/ln';
import { depositWarnings, lnPayoutText, protocolWarning } from './format';

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

/** "대기" 한 단어가 아직 때가 아닌 것과 지급하다 멈춘 것을 섞었다(2026-10-20) */
describe('lnPayoutText', () => {
  const at = (state: OrderState, rest: Partial<Parameters<typeof lnPayoutText>[0]> = {}) =>
    lnPayoutText({ state, disbursed: false, ...rest });

  it('나갔으면 완료 — 상태와 무관하게', () => {
    expect(at('paid', { disbursed: true })).toEqual({ text: '완료', warn: false });
  });

  it('고객 확인 전이면 아직 아님 — 경고 아님', () => {
    expect(at('remitted', { sponsorInvoice: 'lnbc1' })).toMatchObject({ text: expect.stringMatching(/^아직 아님.*등록됨/), warn: false });
    expect(at('escrowed')).toMatchObject({ text: expect.stringMatching(/인보이스 미등록/), warn: false });
  });

  it('지급 사유로 닫혔는데 안 나갔으면 — 만료(후원자 몫)와 결제 실패(데몬이 다시)를 가른다', () => {
    expect(at('paid', { payoutError: LN_PAYOUT_INVOICE_EXPIRED })).toMatchObject({ text: expect.stringMatching(/^멈춤.*만료/), warn: true });
    expect(at('sponsor_wins', { payoutError: 'FAILURE_REASON_NO_ROUTE' }))
      .toMatchObject({ text: expect.stringMatching(/^실패 — FAILURE_REASON_NO_ROUTE/), warn: true });
    expect(at('paid')).toEqual({ text: '보내는 중', warn: false });
  });

  /** 멈추는 중과 멈춤 확인을 섞으면 운영자가 확인 전에 직접 결제한다 — 진행 중인 HTLC가 풀리면 두 번 나간다 */
  it('자동 지급 멈춤 — 확인 전(직접 결제 금지)과 확인 뒤(직접 결제)를 가른다', () => {
    expect(at('paid', { payoutError: LN_PAYOUT_MANUAL_REQUESTED })).toMatchObject({ text: expect.stringMatching(/^멈추는 중.*두 번/), warn: true });
    expect(at('paid', { payoutError: LN_PAYOUT_MANUAL })).toMatchObject({ text: expect.stringMatching(/^직접 처리.*지급 완료로 기록/), warn: true });
    expect(at('paid', { payoutError: LN_PAYOUT_MANUAL, disbursed: true })).toEqual({ text: '완료 (운영자가 직접 결제)', warn: false });
  });

  it('지급 없이 닫힌 거래는 없음', () => {
    for (const s of ['cancelled', 'expired', 'admin_closed', 'customer_wins'] as const) {
      expect(at(s).text).toMatch(/^없음/);
    }
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
