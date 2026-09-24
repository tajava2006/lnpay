/**
 * 라이트닝 오더 코덱 · 닫기 사유 (PLAN-DAEMON §7 L-1, §14 D4)
 *
 * 데몬이 만들고 유저 앱·어드민이 읽는 같은 파일이다 — 발행만 하고 안 읽는 태그가 생기면(예전 payout)
 * 에코에 값이 증발한다. 왕복으로 묶는다.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ORDER_STATES, SAJWO_REQUEST_KIND, TERMINAL_STATES, type OrderState } from '../constants';
import {
  CLOSE_RULES, LN_ACTIVE_RETENTION_SEC, LN_CLOSE_REASON_LABEL, LN_MIN_CLAIM_LEAD_SEC, LN_TERMINAL_RETENTION_SEC,
  canTransition, expiryReasonFor, isClaimableLn, isLnCloseReason, lnOrderTags, lnRetention, parseLnOrderEvent,
  type LnCloseReason,
} from '../ln';

const app = generateSecretKey();
const APP = getPublicKey(app);
const NOW = 1_800_000_000;
const DAY = 86_400;

function sign(tags: string[][], sk = app) {
  return finalizeEvent({ kind: SAJWO_REQUEST_KIND, created_at: NOW, tags, content: '' }, sk);
}

describe('오더 코덱 왕복', () => {
  it('데몬이 싣는 모든 칸이 그대로 읽힌다 — 기한은 expiration, 보존은 retainUntil', () => {
    const tags = lnOrderTags({
      orderId: 'o1', state: 'paid', customerPubkey: 'c'.repeat(64), sponsorPubkey: 's'.repeat(64),
      price: 50_000, deadline: NOW + DAY, bolt11: 'lnbc1escrow', payoutSat: 33_333, sponsorInvoice: 'lnbc1pay',
      disbursed: true, depositPaymentHash: 'd'.repeat(64), sponsorDepositPaymentHash: 'e'.repeat(64),
      closeReason: 'paid',
    }, 'sajwo-tracker', NOW + 7 * DAY);
    const order = parseLnOrderEvent(sign(tags), APP)!;
    expect(order).toMatchObject({
      orderId: 'o1', status: 'sold', state: 'paid', customerPubkey: 'c'.repeat(64), sponsorPubkey: 's'.repeat(64),
      price: 50_000, expiration: NOW + DAY, retainUntil: NOW + 7 * DAY, bolt11: 'lnbc1escrow', payoutSat: 33_333,
      sponsorInvoice: 'lnbc1pay', disbursed: true, depositPaymentHash: 'd'.repeat(64),
      sponsorDepositPaymentHash: 'e'.repeat(64), closeReason: 'paid',
    });
  });

  it('후원자 보증금 대기가 왕복한다 — 없으면 칸 자체가 없다', () => {
    const base = { orderId: 'o2', state: 'claimed' as const, customerPubkey: 'c'.repeat(64), sponsorPubkey: 's'.repeat(64),
      price: 50_000, deadline: NOW + DAY };
    const pending = parseLnOrderEvent(sign(lnOrderTags({ ...base, sponsorDepositPending: true }, 't', NOW + DAY)), APP)!;
    expect(pending.sponsorDepositPending).toBe(true);
    const paid = parseLnOrderEvent(sign(lnOrderTags(base, 't', NOW + DAY)), APP)!;
    expect(paid).not.toHaveProperty('sponsorDepositPending');
  });

  it('APP이 서명한 것만 — 누구나 30402를 낼 수 있다', () => {
    const tags = lnOrderTags({ orderId: 'o1', state: 'requested', customerPubkey: 'c', price: 1, deadline: NOW }, 't', NOW);
    expect(parseLnOrderEvent(sign(tags, generateSecretKey()), APP)).toBeNull();
  });

  /** 데몬 전 이벤트는 expiration이 곧 쿠팡 기한이었다 */
  it('deadline 태그가 없는 옛 이벤트는 expiration을 기한으로 읽는다', () => {
    const order = parseLnOrderEvent(sign([['d', 'old'], ['state', 'requested'], ['expiration', String(NOW + 60)]]), APP)!;
    expect(order.expiration).toBe(NOW + 60);
  });
});

describe('보존 (DM-009)', () => {
  const deadline = NOW + DAY;

  it('의뢰 대기는 기한에 사라진다 — 오더북에 죽은 의뢰가 남지 않게', () => {
    expect(lnRetention('requested', deadline, NOW)).toBe(deadline);
  });

  /** 예전엔 기한 = 보존이라 기한 직후의 종결·판정 발행이 릴레이에서 거절됐다 */
  it('진행 중은 기한 뒤로 넉넉히, 기한이 지났어도 지금부터 넉넉히', () => {
    expect(lnRetention('remitted', deadline, NOW)).toBe(deadline + LN_ACTIVE_RETENTION_SEC);
    expect(lnRetention('remitted', deadline, deadline + 5 * DAY)).toBe(deadline + 5 * DAY + LN_ACTIVE_RETENTION_SEC);
  });

  it('종결은 지금부터 일주일 — 양쪽이 결과를 한 번은 보게', () => {
    for (const s of TERMINAL_STATES) expect(lnRetention(s, deadline, deadline + 3 * DAY)).toBe(deadline + 3 * DAY + LN_TERMINAL_RETENTION_SEC);
  });
});

describe('오더북 클레임 가능', () => {
  it('requested이고 기한이 한 시간 넘게 남아야 한다 (데몬과 같은 값)', () => {
    expect(isClaimableLn({ state: 'requested', expiration: NOW + LN_MIN_CLAIM_LEAD_SEC }, NOW)).toBe(true);
    expect(isClaimableLn({ state: 'requested', expiration: NOW + LN_MIN_CLAIM_LEAD_SEC - 1 }, NOW)).toBe(false);
    expect(isClaimableLn({ state: 'claimed', expiration: NOW + DAY }, NOW)).toBe(false);
  });
});

describe('닫기 사유 (CLOSE_RULES)', () => {
  const reasons = Object.keys(CLOSE_RULES) as LnCloseReason[];

  it('모든 사유는 종결 상태로 가고, 문장이 있다', () => {
    for (const r of reasons) {
      expect(TERMINAL_STATES.has(CLOSE_RULES[r].terminal)).toBe(true);
      expect(LN_CLOSE_REASON_LABEL[r].length).toBeGreaterThan(0);
      expect(isLnCloseReason(r)).toBe(true);
    }
    expect(isLnCloseReason('toString')).toBe(false);
    expect(isLnCloseReason(undefined)).toBe(false);
  });

  it('에스크로를 받는(settle) 사유는 지급 사유뿐이다 — 받지 않은 돈을 주거나, 받은 돈을 안 주는 길이 없다', () => {
    const settles = reasons.filter(r => CLOSE_RULES[r].escrow === 'settle');
    expect(settles.sort()).toEqual(['paid', 'sponsor_wins']);
  });

  it('기한 만료: remitted 이후는 닫지 않는다 — 원화가 갔다는 주장은 판정으로', () => {
    const all = Object.values(ORDER_STATES) as OrderState[];
    for (const s of all) {
      const reason = expiryReasonFor(s, true);
      if (reason === null) {
        expect(['remitted', ...TERMINAL_STATES]).toContain(s);
      } else {
        // 그 상태에서 실제로 갈 수 있는 전이여야 한다
        expect(canTransition(s, CLOSE_RULES[reason].terminal)).toBe(true);
      }
    }
  });

  it('D4 — 인보이스도 안 낸 이탈은 후원자 몰수, 계좌까지 나간 뒤는 환불', () => {
    expect(CLOSE_RULES['expired:no-invoice'].sponsorDeposit).toBe('forfeit');
    expect(CLOSE_RULES['expired:no-remit'].sponsorDeposit).toBe('refund');
    expect(CLOSE_RULES.admin_closed).toMatchObject({ customerDeposit: 'refund', sponsorDeposit: 'refund' });
  });
});
