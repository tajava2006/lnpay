/**
 * 라이트닝 카드 — 에스크로 결제 마감을 양쪽에 보여 준다 (2026-10-24 메인넷 확인)
 *
 * 유동성이 모자라 에스크로를 못 넣는 동안 "언제까지"가 어디에도 없었다. 판매 기한(최대 7일)은 결제 기한이 아니다 —
 * 데몬은 인보이스 만료(= `escrowPayBy`, 승인 + 24시간 이하)에 `cancel:unpaid-escrow`로 닫는다.
 * 인보이스 해석은 가짜로 바꾼다 — 진짜 인보이스는 서명된 시각을 바꿀 수 없다.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Order, OrderState } from '@sajwo-tracker/shared';

const NOW = 1_800_000_000;
const ME = 'a'.repeat(64);
const OTHER = 'b'.repeat(64); // 지정 거래 확인 코드가 hex를 요구한다

vi.mock('../buyer/bolt11', () => ({
  decodeBolt11: (bolt11: string) => (bolt11 === 'lnbc-escrow' ? { amountSat: 1000, expiresAt: NOW + 5 * 3600 + 1800 } : null),
}));

const { lnCardView } = await import('../ln/card-view');

function order(state: OrderState, extra: Partial<Order> = {}): Order {
  return {
    orderId: 'x', state, customerPubkey: ME, sponsorPubkey: OTHER, price: 30_000, bolt11: 'lnbc-escrow',
    createdAt: NOW - 100, updatedAt: NOW - 100, expiration: NOW + 6 * 86_400, raw: {}, ...extra,
  };
}

const view = (o: Order, myPubkey = ME) => lnCardView({ orderId: 'x', order: o, local: null, myPubkey, now: NOW });

describe('에스크로 결제 마감', () => {
  it('파는 사람 — 남은 시간과 넘기면 보증금 몰수', () => {
    const note = view(order('verified')).notes.find(n => n.startsWith('에스크로 결제 마감'));
    expect(note).toBe('에스크로 결제 마감: 5시간 30분 남음 — 넘기면 거래가 취소됩니다(내 보증금 몰수).');
  });

  it('사는 사람 — 같은 마감, 내 보증금은 돌려받는다', () => {
    const note = view(order('verified'), OTHER).notes.find(n => n.startsWith('파는 사람의 에스크로 결제 마감'));
    expect(note).toBe('파는 사람의 에스크로 결제 마감: 5시간 30분 남음 — 넘기면 거래가 취소됩니다(내 보증금은 돌려받음).');
  });

  it('지정 거래는 보증금이 없다 — 몰수 얘기를 안 한다', () => {
    const notes = view(order('verified', { designatedSponsor: OTHER })).notes;
    expect(notes).toContain('에스크로 결제 마감: 5시간 30분 남음 — 넘기면 거래가 취소됩니다.');
  });

  it('결제한 뒤(escrowed)엔 안 보인다', () => {
    expect(view(order('escrowed')).notes.some(n => n.includes('에스크로 결제 마감'))).toBe(false);
  });
});
