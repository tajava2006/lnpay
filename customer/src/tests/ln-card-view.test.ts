/**
 * 라이트닝 카드 — 할 일은 탭이 아니라 데이터로 정한다 (2026-09-24 mainnet 드릴)
 *
 * 드릴에서 본 것: 에스크로 결제는 의뢰하기 탭에서만 됐고, 후원자 보증금을 기다리는 동안 진행도는
 * "후원자 확정 · 에스크로 대기 중"이었다. 둘 다 여기서 막는다.
 */
import { describe, expect, it } from 'vitest';
import type { Order, OrderState } from '@sajwo-tracker/shared';
import type { CustomerOrder } from '../buyer/types';
import { lnCardView, type LnAction, type LnCardInput } from '../ln/card-view';

const NOW = 1_800_000_000;
const ME = 'm'.repeat(64);
const OTHER = 'o'.repeat(64);
const ACCOUNT = { bankName: '국민', accountNumber: '123', holderName: '갑' };

function order(state: OrderState, extra: Partial<Order> = {}): Order {
  return {
    orderId: 'x', state, customerPubkey: ME, sponsorPubkey: OTHER, price: 30_000,
    createdAt: NOW - 100, updatedAt: NOW - 100, expiration: NOW + 86_400, raw: {}, ...extra,
  };
}

function local(extra: Partial<CustomerOrder> = {}): CustomerOrder {
  return { orderId: 'x', price: 30_000, memo: '', createdAt: NOW - 200, expiration: NOW + 86_400, raw: '{}', ...extra };
}

function view(input: Partial<LnCardInput>) {
  return lnCardView({ orderId: 'x', order: null, local: null, myPubkey: ME, now: NOW, ...input });
}

const kinds = (actions: LnAction[]) => actions.map(a => (a.kind === 'pay' ? `pay:${a.purpose}` : a.kind));

describe('고객', () => {
  it('에스크로 결제는 오더만 있으면 어디서든 — 이 기기에 의뢰 기록이 없어도', () => {
    const v = view({ order: order('verified', { bolt11: 'lnbc1escrow' }) });
    expect(v.role).toBe('customer');
    expect(v.actions).toContainEqual({ kind: 'pay', purpose: 'escrow', bolt11: 'lnbc1escrow' });
    expect(v).toMatchObject({ title: '에스크로 결제', isMyTurn: true });
  });

  it('기한이 지난 에스크로는 결제 칸을 열지 않는다', () => {
    const v = view({ order: order('verified', { bolt11: 'lnbc1', expiration: NOW - 1 }) });
    expect(kinds(v.actions)).not.toContain('pay:escrow');
  });

  it('계좌 전달은 이 기기에 의뢰 기록이 있을 때만 — 다른 기기에서 이미 보냈으면 두 번째 계좌가 나간다', () => {
    expect(kinds(view({ order: order('invoiced'), local: local() }).actions)).toContain('send-account');
    const elsewhere = view({ order: order('invoiced') });
    expect(kinds(elsewhere.actions)).not.toContain('send-account');
    expect(elsewhere.notes.join()).toMatch(/판매를 올린 기기/);
  });

  it('계좌를 보냈으면 입금 컨펌, remitted면 기록이 없어도 컨펌', () => {
    expect(kinds(view({ order: order('invoiced'), local: local({ accountInfo: ACCOUNT }) }).actions)).toEqual(['confirm-paid']);
    expect(kinds(view({ order: order('remitted') }).actions)).toEqual(['confirm-paid']);
  });

  it('파싱 주문은 계좌를 자동으로 보낸다 — 버튼 대신 안내', () => {
    const v = view({ order: order('invoiced'), local: local({ fixedAccountInfo: ACCOUNT }) });
    expect(kinds(v.actions)).not.toContain('send-account');
    expect(v.notes.join()).toMatch(/자동으로/);
  });

  it('취소는 에스크로 전까지, 지우기는 종결된 것만', () => {
    expect(view({ order: order('verified'), local: local() }).side).toEqual({ cancel: true, delete: false });
    expect(view({ order: order('escrowed'), local: local() }).side).toEqual({ cancel: false, delete: false });
    expect(view({ order: order('paid'), local: local() }).side).toEqual({ cancel: false, delete: true });
  });

  /** 2026-10-24 메인넷: 사는 사람이 붙은 뒤 취소했더니 아무 말 없이 보증금이 몰수됐다(`cancel:customer-after-claim`) */
  it('사는 사람이 붙은 뒤 취소는 보증금 몰수를 먼저 말한다 — 보증금이 있을 때만', () => {
    const forfeits = (o: Order, l?: CustomerOrder) => view({ order: o, local: l ?? null }).side.cancelForfeitsDeposit === true;
    expect(forfeits(order('claimed', { depositPaymentHash: 'h' }))).toBe(true);
    expect(forfeits(order('verified', { depositPaymentHash: 'h' }))).toBe(true);
    // 오더 태그가 없어도 이 기기에 맡긴 기록이 있으면
    expect(forfeits(order('verified'), local({ depositStatus: 'accepted' }))).toBe(true);
    // 아직 아무도 안 붙었으면 돌려받는다
    expect(forfeits(order('requested', { depositPaymentHash: 'h' }))).toBe(false);
    // 보증금이 없는 거래(지정 거래 · 0%)는 잃을 게 없다
    expect(forfeits(order('verified'))).toBe(false);
  });
});

describe('후원자 보증금 대기', () => {
  const pending = order('claimed', { customerPubkey: OTHER, sponsorPubkey: ME, sponsorDepositPending: true });

  it('후원자: 보증금 결제가 할 일이고, 아직 "후원자 찾는 중"', () => {
    const v = view({ order: pending, sponsorDeposit: { bolt11: 'lnbc1dep', at: NOW } });
    expect(v.actions).toEqual([{ kind: 'pay', purpose: 'sponsor-deposit', bolt11: 'lnbc1dep' }]);
    expect(v).toMatchObject({ title: '사는 사람 찾는 중', isMyTurn: true });
    expect(v.badge.label).toBe('보증금 대기');
  });

  it('고객: 할 일 없음, 후원자를 기다린다', () => {
    const v = view({ order: { ...pending, customerPubkey: ME, sponsorPubkey: OTHER }, local: local() });
    expect(v.actions).toEqual([]);
    expect(v).toMatchObject({ title: '사는 사람 찾는 중', isMyTurn: false, waitingFor: '사는 사람' });
    expect(v.progress.sponsorDepositPending).toBe(true);
  });

  it('인보이스가 아직 안 왔으면 기다린다고 말한다', () => {
    expect(view({ order: pending }).notes.join()).toMatch(/보증금 인보이스를 기다리는/);
  });

  it('보증금이 들어오면 "후원자 확정" — 결제 칸이 닫힌다', () => {
    const paid = order('claimed', { customerPubkey: OTHER, sponsorPubkey: ME, sponsorDepositPaymentHash: 'h' });
    const v = view({ order: paid, sponsorDeposit: { bolt11: 'lnbc1dep', at: NOW } });
    expect(v.actions).toEqual([]);
    expect(v).toMatchObject({ title: '사는 사람 확정', isMyTurn: false, waitingFor: '에스크로' });
  });
});

describe('후원자', () => {
  const mine = (state: OrderState, extra: Partial<Order> = {}) =>
    order(state, { customerPubkey: OTHER, sponsorPubkey: ME, ...extra });

  it('escrowed면 인보이스 등록', () => {
    expect(view({ order: mine('escrowed') }).actions).toEqual([{ kind: 'register-invoice', notice: null }]);
  });

  it('지급 전에 거절 통보가 오면 paid에서도 다시 낸다 · 지급됐으면 아니다', () => {
    expect(kinds(view({ order: mine('paid'), invoiceRejection: '만료' }).actions)).toEqual(['register-invoice']);
    expect(kinds(view({ order: mine('paid', { disbursed: true }), invoiceRejection: '만료' }).actions)).toEqual([]);
  });

  /** 지급 중엔 데몬이 만료를 확인해야 바꿔 준다(두 번 지급 방지) — 등록 때 받은 유동성 경고로는 칸을 열지 않는다 */
  it('paid에서 유동성 경고만 있으면 다시 내는 칸이 없다 — 그 전 단계에선 있다', () => {
    const warn = { invoiceRejection: '경로 확인 실패', invoiceRejectionIsWarning: true };
    expect(kinds(view({ order: mine('paid'), ...warn }).actions)).toEqual([]);
    expect(kinds(view({ order: mine('sponsor_wins'), ...warn }).actions)).toEqual([]);
    expect(kinds(view({ order: mine('invoiced'), ...warn }).actions)).toContain('register-invoice');
  });

  it('계좌가 오면 송금, 안 왔으면 기다린다', () => {
    expect(view({ order: mine('invoiced'), receivedAccount: ACCOUNT }).actions).toEqual([{ kind: 'remit', account: ACCOUNT }]);
    expect(view({ order: mine('invoiced') }).notes.join()).toMatch(/계좌 정보를 기다리는/);
  });

  it('어드민이 계좌 공개를 요청하면 공개 버튼', () => {
    expect(kinds(view({ order: mine('remitted'), receivedAccount: ACCOUNT, revealRequested: true }).actions)).toEqual(['reveal']);
  });

  it('고객 역할의 행동(취소·결제)은 후원자에게 없다', () => {
    const v = view({ order: mine('verified', { bolt11: 'lnbc1' }) });
    expect(v.actions).toEqual([]);
    expect(v.side.cancel).toBe(false);
  });
});

describe('참여하지 않는 의뢰 (풀린 클레임)', () => {
  it('할 일 없이 풀렸다고만 말한다', () => {
    const v = view({ order: order('requested', { customerPubkey: OTHER, sponsorPubkey: undefined }) });
    expect(v.role).toBeNull();
    expect(v.actions).toEqual([]);
    expect(v.isMyTurn).toBe(false);
    expect(v.notes.join()).toMatch(/배정이 풀린/);
  });
});

describe('오더가 되기 전 (내 기기에만 있는 의뢰)', () => {
  it('올리기 전이면 올리기', () => {
    const v = view({ local: local({ raw: undefined }) });
    expect(v).toMatchObject({ draft: true, title: '판매 올리기 전', isMyTurn: true });
    expect(kinds(v.actions)).toEqual(['publish']);
  });

  it('보증금 인보이스가 오면 보증금 결제', () => {
    const v = view({ local: local({ depositBolt11: 'lnbc1c' }) });
    expect(v.actions).toEqual([{ kind: 'pay', purpose: 'customer-deposit', bolt11: 'lnbc1c' }]);
  });

  it('보증금이 취소됐거나 기한이 지났으면 할 일 없음 — 지우기만', () => {
    expect(view({ local: local({ depositBolt11: 'lnbc1c', depositStatus: 'cancelled' }) }).actions).toEqual([]);
    const late = view({ local: local({ raw: undefined, expiration: NOW - 1 }) });
    expect(late.actions).toEqual([]);
    expect(late.side.delete).toBe(true);
  });
});

/** RISKS R-5 — 에스크로 뒤 후원자 인보이스 마감. 양쪽이 같은 시각을 본다 */
describe('인보이스 등록 마감', () => {
  it('후원자에게는 남은 시간과 결과를, 고객에게는 기다리는 시간을', () => {
    const o = order('escrowed', { invoiceDeadline: NOW + 2 * 3600 });
    const sponsor = lnCardView({ orderId: 'x', order: { ...o, customerPubkey: OTHER, sponsorPubkey: ME }, local: null, myPubkey: ME, now: NOW });
    expect(sponsor.notes.some(n => n.startsWith('인보이스 등록 마감: 2시간 0분 남음'))).toBe(true);
    const customer = view({ order: o });
    expect(customer.notes.some(n => n.startsWith('사는 사람 인보이스 마감: 2시간 0분 남음'))).toBe(true);
  });

  it('마감이 없는 옛 오더나 다른 상태에서는 말하지 않는다', () => {
    expect(view({ order: order('escrowed') }).notes.some(n => n.includes('마감'))).toBe(false);
    expect(view({ order: order('invoiced', { invoiceDeadline: NOW + 60 }) }).notes.some(n => n.includes('인보이스 마감'))).toBe(false);
  });
});

/** 상대방 채팅(docs/PLAN-PEER-CHAT.md D11) — 사는 사람이 확정된 뒤에만, 끝나면 읽기만 */
describe('상대방 채팅', () => {
  it('사는 사람이 없거나 보증금을 기다리는 클레임이면 없다 — 풀리면 다른 사람에게 간다', () => {
    expect(view({ order: order('requested', { sponsorPubkey: undefined }) }).peer).toBeNull();
    expect(view({ order: order('claimed', { sponsorDepositPending: true }) }).peer).toBeNull();
  });

  it('확정되면 반대쪽과 — 파는 사람은 사는 사람과, 사는 사람은 파는 사람과', () => {
    expect(view({ order: order('claimed') }).peer).toEqual({ pubkey: OTHER, readOnly: false });
    expect(view({ order: order('invoiced', { customerPubkey: OTHER, sponsorPubkey: ME }) }).peer)
      .toEqual({ pubkey: OTHER, readOnly: false });
  });

  it('끝난 거래는 읽기만 · 배정이 풀린 사람과 올리기 전 판매는 없다', () => {
    expect(view({ order: order('paid') }).peer).toEqual({ pubkey: OTHER, readOnly: true });
    expect(view({ order: order('verified', { customerPubkey: OTHER, sponsorPubkey: 'z'.repeat(64) }) }).peer).toBeNull();
    expect(view({ local: local({ raw: undefined }) }).peer).toBeNull();
  });

  /** 지정 거래에 엉뚱한 사람이 붙었다 — 결제도 계좌도 막는데 대화만 열면 그 사람에게 말을 걸게 된다 */
  it('지정한 상대가 아닌 사람이 붙었으면 없다', () => {
    const v = view({ order: order('claimed', { sponsorPubkey: 'b'.repeat(64) }), local: local({ designatedSponsor: 'a'.repeat(64) }) });
    expect(v.peer).toBeNull();
  });
});
