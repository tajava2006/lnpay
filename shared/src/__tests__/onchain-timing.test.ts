/**
 * 마감 시계 (PLAN-ONCHAIN-TRACK §6.2)
 *
 * 값 자체보다 **부등식**이 중요하다. 라이트닝 트랙의 `AUDIT-EXPIRY.md`가
 * 같은 형식으로 관리되고, 거기서 F2("에스크로가 2시간 남았는데 6시간짜리
 * 인보이스를 받아줬다")가 나온 자리다.
 */
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_WINDOW_SEC, COSIGN_GRACE_WARNING_SEC, COSIGN_WINDOW_SEC, DISPUTE_ESCALATION_SEC,
  FUNDING_WINDOW_SEC, KRW_WINDOW_SEC, MAX_OPTION_WINDOW_SEC, MAX_ORDER_EXPIRY_SEC,
  PRESIGN_WINDOW_SEC, SETTLING_WARN_SEC,
  accountDeadlineFrom, cosignDeadlineFrom, fundingDeadlineFrom, isOrderExpiryAllowed,
  krwDeadlineFrom, presignDeadlineFrom,
} from '../onchain/timing';
import { PRICE_VALIDITY_MS, DEFAULT_TIMELOCK_BLOCKS } from '../onchain';

const HOUR = 3600;
const DAY = 24 * HOUR;

describe('값', () => {
  it.each([
    ['의뢰 만료 상한', MAX_ORDER_EXPIRY_SEC, 7 * DAY],
    ['펀딩(컨펌까지)', FUNDING_WINDOW_SEC, 6 * HOUR],
    ['사전서명', PRESIGN_WINDOW_SEC, 15 * 60],
    ['계좌 공개', ACCOUNT_WINDOW_SEC, 15 * 60],
    ['원화 송금', KRW_WINDOW_SEC, 30 * 60],
    ['cosign', COSIGN_WINDOW_SEC, 24 * HOUR],
    ['종결 정체 경고', SETTLING_WARN_SEC, 24 * HOUR],
  ])('%s', (_label, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('지켜야 할 부등식 (§6.3)', () => {
  /**
   * 보증금은 이 창의 변동폭을 덮어야 한다. 창이 무한하면 어떤 고정 프리미엄도
   * 언젠가 추월당한다 — 그래서 **유한해야** 보증금이 의미를 갖는다(§2.4).
   */
  it('총 옵션 창 = T0+60분, 그리고 앞 두 마감이 T0에 묶여 있다', () => {
    expect(MAX_OPTION_WINDOW_SEC).toBe(60 * 60);
    expect(PRESIGN_WINDOW_SEC + ACCOUNT_WINDOW_SEC + KRW_WINDOW_SEC).toBe(MAX_OPTION_WINDOW_SEC);
  });

  /** 타임락(8주)은 분쟁 최장 소요보다 **한참** 길어야 한다 (§7 F). */
  it('타임락이 전체 마감 합보다 훨씬 길다', () => {
    const timelockSec = DEFAULT_TIMELOCK_BLOCKS * 600;
    const worstCase = FUNDING_WINDOW_SEC + MAX_OPTION_WINDOW_SEC + COSIGN_WINDOW_SEC + SETTLING_WARN_SEC;
    expect(timelockSec).toBeGreaterThan(worstCase * 10);
  });

  /** 최악 소요가 55시간 언저리 — 모든 구간에 하드 마감이 있다(§4.1c 이후) */
  it('최악 소요 ≈ 55시간', () => {
    const worst = FUNDING_WINDOW_SEC + MAX_OPTION_WINDOW_SEC + COSIGN_WINDOW_SEC + SETTLING_WARN_SEC;
    expect(worst / HOUR).toBeGreaterThan(54);
    expect(worst / HOUR).toBeLessThan(56);
  });

  it('유예 경고는 cosign 마감보다 앞선다', () => {
    expect(COSIGN_GRACE_WARNING_SEC).toBeLessThan(COSIGN_WINDOW_SEC);
  });

  it('분쟁 에스컬레이션은 오름차순이다', () => {
    expect(DISPUTE_ESCALATION_SEC[0]).toBeLessThan(DISPUTE_ESCALATION_SEC[1]);
  });

  /**
   * "노브가 하나 더 늘지 않는다"(§7.6 ③) — cosign 마감과 가격 유효창은
   * **같은 값**이어야 한다. 갈라지면 정직한 거래에 우회 프롬프트가 뜬다.
   */
  it('cosign 마감 = 가격 유효창', () => {
    expect(COSIGN_WINDOW_SEC * 1000).toBe(PRICE_VALIDITY_MS);
  });
});

describe('마감 계산', () => {
  const T = 1_700_000_000;

  it.each([
    [fundingDeadlineFrom, FUNDING_WINDOW_SEC],
    [presignDeadlineFrom, PRESIGN_WINDOW_SEC],
    [accountDeadlineFrom, ACCOUNT_WINDOW_SEC],
    [krwDeadlineFrom, KRW_WINDOW_SEC],
    [cosignDeadlineFrom, COSIGN_WINDOW_SEC],
  ])('기준점 + 창', (fn, window) => {
    expect(fn(T)).toBe(T + window);
  });
});

describe('의뢰 만료 상한 (§2.2)', () => {
  const NOW = 1_700_000_000;

  /** 넘으면 보증금 CLTV가 채널 상한을 넘어 **인보이스를 만들 수 없다.** */
  it('7일까지 허용, 그 너머는 거부', () => {
    expect(isOrderExpiryAllowed(NOW + 7 * DAY, NOW)).toBe(true);
    expect(isOrderExpiryAllowed(NOW + 7 * DAY + 1, NOW)).toBe(false);
  });

  it('이미 지난 만료는 거부', () => {
    expect(isOrderExpiryAllowed(NOW, NOW)).toBe(false);
    expect(isOrderExpiryAllowed(NOW - 1, NOW)).toBe(false);
  });
});

// ─── 지금 걸린 마감 ──────────────────────────────────────────

/**
 * 화면이 "몇 분 남았는지"를 보여주려면 **어느 시계가 도는지** 한 곳에서 알아야
 * 한다. 특히 `presigned`는 한 상태 안에서 주인이 바뀌므로(O-013) 화면이 스스로
 * 판단하게 두면 갈린다.
 */
describe('currentOnchainDeadline', () => {
  const T = 1_700_000_000;
  const base = { expiration: T + 86_400, updatedAt: T };

  it('listed → 의뢰 만료', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');
    expect(currentOnchainDeadline({ ...base, state: 'listed' })?.at).toBe(T + 86_400);
  });

  it('bonded → 펀딩 컨펌 마감 (몰수 경고 포함)', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');
    const d = currentOnchainDeadline({ ...base, state: 'bonded', fundingDeadline: T + 100 });
    expect(d?.at).toBe(T + 100);
    expect(d?.penalty).toMatch(/몰수/);
  });

  it('funded → T0+15분', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');
    expect(currentOnchainDeadline({ ...base, state: 'funded', fundedAt: T })?.at)
      .toBe(T + PRESIGN_WINDOW_SEC);
  });

  /** ⚠️ 한 상태 안에서 시계 주인이 바뀐다 (O-013). */
  it('presigned → 계좌 공개 전엔 고객 시계, 그 뒤엔 후원자 시계', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');

    const beforeSend = currentOnchainDeadline({ ...base, state: 'presigned', presignedAt: T });
    expect(beforeSend?.label).toBe('계좌 공개 마감');
    expect(beforeSend?.at).toBe(T + ACCOUNT_WINDOW_SEC);

    const afterSend = currentOnchainDeadline({
      ...base, state: 'presigned', presignedAt: T, accountSentAt: T + 60,
      krwDeadline: T + 60 + KRW_WINDOW_SEC,
    });
    expect(afterSend?.label).toBe('원화 송금 마감');
    expect(afterSend?.at).toBe(T + 60 + KRW_WINDOW_SEC);
  });

  it('remitted → 24시간, 넘기면 분쟁', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');
    const d = currentOnchainDeadline({ ...base, state: 'remitted', remittedAt: T });
    expect(d?.at).toBe(T + COSIGN_WINDOW_SEC);
    expect(d?.penalty).toMatch(/분쟁/);
  });

  /** 자동 해소가 어느 방향이든 탈취라 마감이 없다(§7.5). */
  it('disputed에는 마감이 없다', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');
    expect(currentOnchainDeadline({ ...base, state: 'disputed' })).toBeNull();
  });

  /** 넘겨도 잃는 게 없다 — CPFP 안내일 뿐이라 penalty를 안 붙인다. */
  it('settling은 경고성 마감이라 벌칙이 없다', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');
    const d = currentOnchainDeadline({ ...base, state: 'settling', settlingAt: T });
    expect(d?.at).toBe(T + SETTLING_WARN_SEC);
    expect(d?.penalty).toBeUndefined();
  });

  it('기준 시각이 없으면 마감을 지어내지 않는다', async () => {
    const { currentOnchainDeadline } = await import('../onchain/timing');
    expect(currentOnchainDeadline({ ...base, state: 'funded' })).toBeNull();
    expect(currentOnchainDeadline({ ...base, state: 'remitted' })).toBeNull();
  });
});
