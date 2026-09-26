/**
 * 라이트닝 오더 코덱 · 닫기 사유
 *
 * 데몬이 만들고 유저 앱·어드민이 읽는 같은 파일이다 — 발행만 하고 안 읽는 태그가 생기면(예전 payout)
 * 에코에 값이 증발한다. 왕복으로 묶는다.
 */
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ORDER_STATES, ORDER_KIND, PROTOCOL_VERSION, TERMINAL_STATES, protocolOf, type OrderState } from '../constants';
import {
  CLOSE_RULES, LN_ACTIVE_RETENTION_SEC, LN_CLOSE_REASON_LABEL, LN_MIN_CLAIM_LEAD_SEC, LN_TERMINAL_RETENTION_SEC,
  canTransition, expiryReasonFor, isClaimableLn, isLnCloseReason, isStoredLnOrder, lnOrderTags, lnRetention,
  parseLnOrderEvent,
  type LnCloseReason,
} from '../ln';

const app = generateSecretKey();
const APP = getPublicKey(app);
const NOW = 1_800_000_000;
const DAY = 86_400;

function sign(tags: string[][], sk = app) {
  return finalizeEvent({ kind: ORDER_KIND, created_at: NOW, tags, content: '' }, sk);
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
      orderId: 'o1', state: 'paid', customerPubkey: 'c'.repeat(64), sponsorPubkey: 's'.repeat(64),
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

  it('APP이 서명한 것만 — 누구나 같은 kind를 낼 수 있다', () => {
    const tags = lnOrderTags({ orderId: 'o1', state: 'requested', customerPubkey: 'c', price: 1, deadline: NOW }, 't', NOW);
    expect(parseLnOrderEvent(sign(tags, generateSecretKey()), APP)).toBeNull();
  });

  it('deadline이 없으면 지난 마감으로 읽는다 — 보존(expiration)을 마감으로 믿지 않는다', () => {
    const order = parseLnOrderEvent(sign([['d', 'x'], ['state', 'requested'], ['expiration', String(NOW + 60)]]), APP)!;
    expect(order.expiration).toBe(0);
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

  /** 2026-09-25 — 고객 보증금이 에스크로 뒤에도 살아 있어 이 몰수가 가능해졌다 */
  it('invoiced 만료는 계좌가 나갔는지로 갈린다 — 안 나갔으면 고객 몰수, 나갔으면 전부 환불', () => {
    expect(expiryReasonFor('invoiced', true, false)).toBe('expired:no-account');
    expect(CLOSE_RULES['expired:no-account']).toMatchObject({ customerDeposit: 'forfeit', sponsorDeposit: 'refund', escrow: 'cancel' });
    expect(expiryReasonFor('invoiced', true, true)).toBe('expired:no-remit');
    expect(CLOSE_RULES['expired:no-remit']).toMatchObject({ customerDeposit: 'refund', sponsorDeposit: 'refund' });
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

describe('NIP-69 태그', () => {
  const nip = (tags: string[][], name: string) => tags.filter(t => t[0] === name).map(t => t.slice(1));
  const base = { orderId: 'o1', customerPubkey: 'c'.repeat(64), price: 32_900, deadline: NOW + DAY };

  it('의뢰는 pending — sats는 검증 때 시세로 정하므로 0, 만료는 쿠팡 기한', () => {
    const tags = lnOrderTags({ ...base, state: 'requested' }, 't', NOW + DAY);
    for (const name of ['k', 'f', 's', 'amt', 'fa', 'pm', 'premium', 'network', 'layer', 'expires_at', 'y', 'z']) {
      expect(nip(tags, name), name).toHaveLength(1);
    }
    expect(nip(tags, 's')).toEqual([['pending']]);
    expect(nip(tags, 'amt')).toEqual([['0']]);
    expect(nip(tags, 'fa')).toEqual([['32900']]);
    expect(nip(tags, 'layer')).toEqual([['lightning']]);
    expect(nip(tags, 'expires_at')).toEqual([[String(NOW + DAY)]]);
  });

  it('앱 주소를 주면 source로 이 오더를 여는 주소가 실린다 — 없으면 태그 자체가 없다', () => {
    expect(nip(lnOrderTags({ ...base, state: 'requested' }, 't', NOW + DAY, 'https://app.test/'), 'source'))
      .toEqual([['https://app.test/?order=o1']]);
    expect(nip(lnOrderTags({ ...base, state: 'requested' }, 't', NOW + DAY), 'source')).toEqual([]);
  });

  it('지급액이 정해지면 amt가 그 sats다', () => {
    expect(nip(lnOrderTags({ ...base, state: 'escrowed', payoutSat: 24_512 }, 't', NOW + DAY), 'amt')).toEqual([['24512']]);
  });

  it.each([
    ['claimed', 'in-progress'], ['remitted', 'in-progress'], ['paid', 'success'], ['sponsor_wins', 'success'],
    ['customer_wins', 'canceled'], ['cancelled', 'canceled'], ['admin_closed', 'canceled'], ['expired', 'expired'],
  ] as const)('%s → %s', (state, status) => {
    expect(nip(lnOrderTags({ ...base, state }, 't', NOW + DAY), 's')).toEqual([[status]]);
  });
});

/** 저장소는 읽을 때 모양을 본다 — 파서가 낸 값이 거기서 떨어지면 새로고침마다 오더가 사라진다 */
describe('저장소 모양 확인과 파서가 맞물린다', () => {
  it('파서가 낸 오더는 JSON 왕복 뒤에도 통과한다 — 칸이 다 찬 것도, 최소한인 것도', () => {
    const full = parseLnOrderEvent(sign(lnOrderTags({
      orderId: 'o1', state: 'paid', customerPubkey: 'c'.repeat(64), sponsorPubkey: 's'.repeat(64),
      price: 50_000, deadline: NOW + DAY, bolt11: 'lnbc1', payoutSat: 33_333, sponsorInvoice: 'lnbc2', disbursed: true,
      closeReason: 'paid',
    }, 't', NOW + DAY)), APP)!;
    const bare = parseLnOrderEvent(sign([['d', 'o2']]), APP)!;
    for (const order of [full, bare]) expect(isStoredLnOrder(JSON.parse(JSON.stringify(order)))).toBe(true);
  });

  it('모르는 상태·숫자가 아닌 금액은 떨어진다', () => {
    const order = parseLnOrderEvent(sign(lnOrderTags({ orderId: 'o1', state: 'requested', customerPubkey: 'c', price: 1, deadline: NOW }, 't', NOW)), APP)!;
    expect(isStoredLnOrder({ ...order, state: 'sold' })).toBe(false);
    expect(isStoredLnOrder({ ...order, price: '1' })).toBe(false);
  });
});

describe('프로토콜 버전', () => {
  it('오더 이벤트에 실리고 protocolOf로 읽힌다 — 유저 앱이 새 데몬을 알아보는 근거', () => {
    const tags = lnOrderTags({ orderId: 'o1', state: 'requested', customerPubkey: 'c', price: 1, deadline: NOW }, 't', NOW);
    expect(protocolOf(tags)).toBe(PROTOCOL_VERSION);
  });

  it('없거나 숫자가 아니면 null — 버전을 싣기 전 데몬', () => {
    expect(protocolOf([['d', 'x']])).toBeNull();
    expect(protocolOf([['protocol', 'two']])).toBeNull();
  });
});

