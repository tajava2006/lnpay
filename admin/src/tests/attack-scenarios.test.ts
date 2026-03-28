/**
 * 공격 시나리오 테스트
 *
 * 악의적인 사용자가 시스템을 속여 자금을 빼돌리려는 시나리오를 검증한다.
 * LN 노드와 Nostr 릴레이를 mock으로 대체하여 실제 BTC 이동 없이 로직만 테스트한다.
 *
 * 검증 방법: publishOrder 호출 여부 = 상태 전이 시도 여부
 *   - publishOrder 호출됨 → Admin이 상태 전이를 승인함
 *   - publishOrder 미호출 → 공격이 FSM/검증에서 차단됨
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Order, ClaimRequest, Request } from '@sajwo-tracker/shared';
import type { PriceTracker } from '@sajwo-tracker/shared';
import { upsertOrder, getOrder, _resetForTesting } from '../order-store';
import {
  setLnAdapter,
  setPriceTracker,
  handleClaim,
  handlePaymentConfirm,
  handleCancelRequest,
} from '../nostr/service';
import { MockLightningAdapter } from './mock-ln';

// ── Nostr 발행 mock ──────────────────────────────────────────────────
vi.mock('../nostr/publish', () => ({
  publishOrder: vi.fn().mockResolvedValue({}),
  publishClaimPriceError: vi.fn().mockResolvedValue({}),
  publishDepositRequired: vi.fn().mockResolvedValue({}),
  publishDepositStatus: vi.fn().mockResolvedValue({}),
  publishDisputeMessage: vi.fn().mockResolvedValue({}),
}));
// relays/escrow 관련 의존성 mock
vi.mock('../nostr/ln-config-service', () => ({ getLnConfig: vi.fn() }));
vi.mock('../escrow-store', () => ({
  getPreimage: vi.fn().mockReturnValue(null),
  getEscrowEntry: vi.fn().mockReturnValue(null),
  saveEscrowEntry: vi.fn(),
}));
vi.mock('../pending-deposit-store', () => ({
  getPendingDeposit: vi.fn().mockReturnValue(null),
  savePendingDeposit: vi.fn(),
}));
vi.mock('../deposit-lifecycle', () => ({
  handleDepositOnTransition: vi.fn().mockResolvedValue(undefined),
}));

// publishOrder spy - 각 테스트에서 호출 여부를 검증한다
import { publishOrder } from '../nostr/publish';
const publishOrderSpy = publishOrder as ReturnType<typeof vi.fn>;

// ── 테스트 픽스처 ────────────────────────────────────────────────────

// 100만 KRW 오더, BTC 1억 KRW → 기대 sat = 1,000,000
const ORDER_PRICE = 1_000_000;  // KRW
const BTC_PRICE = 100_000_000;  // KRW/BTC
const EXPECTED_SAT = 1_000_000; // sat

const CUSTOMER_PUBKEY = 'customer-pubkey-aaaa';
const SPONSOR_PUBKEY  = 'sponsor-pubkey-bbbb';
const ATTACKER_PUBKEY = 'attacker-pubkey-cccc';

function makeOrder(overrides: Partial<Order> = {}): Order {
  const now = Math.floor(Date.now() / 1000);
  return {
    orderId: 'order-1',
    status: 'active',
    state: 'requested',
    customerPubkey: CUSTOMER_PUBKEY,
    price: ORDER_PRICE,
    createdAt: now,
    updatedAt: now,
    expiration: now + 86400,
    raw: {},
    ...overrides,
  };
}

function makeClaimRequest(overrides: Partial<ClaimRequest> = {}): ClaimRequest {
  const now = Math.floor(Date.now() / 1000);
  return {
    eventId: 'event-claim-1',
    orderId: 'order-1',
    pubkey: SPONSOR_PUBKEY,
    action: 'claim',
    createdAt: now,
    expiration: now + 3600,
    raw: {},
    invoice: {
      bolt11: 'lnbc-test-invoice',
      decoded: {
        destination: SPONSOR_PUBKEY,
        amountSat: EXPECTED_SAT,
        paymentHash: 'sponsor-payment-hash',
        expiresAt: now + 3600,
        routeHints: [],
      },
      liquidityVerified: true,
    },
    ...overrides,
  };
}

function makeRequest(action: string, pubkey: string, overrides: Partial<Request> = {}): Request {
  const now = Math.floor(Date.now() / 1000);
  return {
    eventId: `event-${action}-1`,
    orderId: 'order-1',
    pubkey,
    action,
    createdAt: now,
    expiration: now + 3600,
    raw: {},
    ...overrides,
  } as Request;
}

function makePriceTracker(price: number | null): PriceTracker {
  return {
    start: () => {},
    stop: () => {},
    subscribe: () => () => {},
    getSnapshot: () => ({ price, exchanges: [] }),
  };
}

// ── 테스트 setup/teardown ────────────────────────────────────────────

let mockLn: MockLightningAdapter;

beforeEach(() => {
  _resetForTesting();
  mockLn = new MockLightningAdapter();
  setLnAdapter(mockLn);
  setPriceTracker(makePriceTracker(BTC_PRICE));
  publishOrderSpy.mockClear();
});

// ── FSM replay / 상태 조작 공격 ──────────────────────────────────────

describe('FSM 공격 — 취소/완료된 오더 재활용', () => {
  it('cancelled 오더에 claim replay → 차단', async () => {
    upsertOrder(makeOrder({ state: 'cancelled', status: 'sold' }));
    await handleClaim(makeClaimRequest());
    expect(publishOrderSpy).not.toHaveBeenCalled();
    expect(mockLn.calls.createHoldInvoice).toHaveLength(0);
  });

  it('paid 오더에 claim replay → 차단', async () => {
    upsertOrder(makeOrder({ state: 'paid', status: 'sold' }));
    await handleClaim(makeClaimRequest());
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('이미 claimed 오더에 두 번째 Sponsor가 claim → 차단', async () => {
    upsertOrder(makeOrder({ state: 'claimed', sponsorPubkey: SPONSOR_PUBKEY }));
    const secondSponsor = makeClaimRequest({ pubkey: 'sponsor2-pubkey-dddd' });
    await handleClaim(secondSponsor);
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('escrowed 오더를 취소 시도 (에스크로 후 일방 취소 불가) → 차단', async () => {
    upsertOrder(makeOrder({ state: 'escrowed', sponsorPubkey: SPONSOR_PUBKEY }));
    await handleCancelRequest(makeRequest('cancel-request', CUSTOMER_PUBKEY));
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('remitted 오더를 취소 시도 → 차단', async () => {
    upsertOrder(makeOrder({ state: 'remitted', sponsorPubkey: SPONSOR_PUBKEY }));
    await handleCancelRequest(makeRequest('cancel-request', CUSTOMER_PUBKEY));
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });
});

// ── 가격 조작 공격 ────────────────────────────────────────────────────

describe('가격 조작 공격 — 허용 범위 밖 인보이스 제출', () => {
  beforeEach(() => {
    upsertOrder(makeOrder({ state: 'requested' }));
  });

  it('50% 저가 인보이스 제출 (500,000 sat) → 차단', async () => {
    const claim = makeClaimRequest({
      invoice: {
        bolt11: 'lnbc-underpay',
        decoded: {
          destination: SPONSOR_PUBKEY,
          amountSat: Math.round(EXPECTED_SAT * 0.5),
          paymentHash: 'hash-underpay',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          routeHints: [],
        },
        liquidityVerified: true,
      },
    });
    await handleClaim(claim);
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('200% 고가 인보이스 제출 (2,000,000 sat) → 차단', async () => {
    const claim = makeClaimRequest({
      invoice: {
        bolt11: 'lnbc-overpay',
        decoded: {
          destination: SPONSOR_PUBKEY,
          amountSat: Math.round(EXPECTED_SAT * 2.0),
          paymentHash: 'hash-overpay',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          routeHints: [],
        },
        liquidityVerified: true,
      },
    });
    await handleClaim(claim);
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('3사 거래소 전체 다운 시 claim → 차단 (S-008)', async () => {
    setPriceTracker(makePriceTracker(null));
    await handleClaim(makeClaimRequest());
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('decoded 없는 인보이스 제출 → 차단', async () => {
    const claim = makeClaimRequest({
      invoice: { bolt11: 'lnbc-nodecode', decoded: null, liquidityVerified: false },
    });
    await handleClaim(claim);
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });
});

// ── pubkey 위조 공격 ──────────────────────────────────────────────────

describe('pubkey 위조 공격 — 타인 권한 사칭', () => {
  it('payment-confirm: 공격자가 Customer 사칭 → 차단', async () => {
    upsertOrder(makeOrder({ state: 'escrowed', sponsorPubkey: SPONSOR_PUBKEY }));
    await handlePaymentConfirm(makeRequest('payment-confirm', ATTACKER_PUBKEY));
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('payment-confirm: Sponsor가 Customer 사칭 → 차단', async () => {
    upsertOrder(makeOrder({ state: 'escrowed', sponsorPubkey: SPONSOR_PUBKEY }));
    await handlePaymentConfirm(makeRequest('payment-confirm', SPONSOR_PUBKEY));
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('cancel-request: 공격자가 Customer 사칭 → 차단', async () => {
    upsertOrder(makeOrder({ state: 'requested' }));
    await handleCancelRequest(makeRequest('cancel-request', ATTACKER_PUBKEY));
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });
});

// ── 정상 플로우 (positive case) ──────────────────────────────────────

describe('정상 플로우 — 올바른 Actor가 올바른 액션 수행', () => {
  it('Sponsor가 정상 claim 발행 → 상태 전이 승인', async () => {
    upsertOrder(makeOrder({ state: 'requested' }));
    await handleClaim(makeClaimRequest());
    expect(publishOrderSpy).toHaveBeenCalledTimes(1);
    const published = publishOrderSpy.mock.calls[0][0] as Order;
    expect(published.state).toBe('claimed');
    expect(published.sponsorPubkey).toBe(SPONSOR_PUBKEY);
  });

  it('Customer가 escrowed 상태에서 payment-confirm → 상태 전이 승인', async () => {
    upsertOrder(makeOrder({ state: 'escrowed', sponsorPubkey: SPONSOR_PUBKEY }));
    await handlePaymentConfirm(makeRequest('payment-confirm', CUSTOMER_PUBKEY));
    expect(publishOrderSpy).toHaveBeenCalledTimes(1);
    const published = publishOrderSpy.mock.calls[0][0] as Order;
    expect(published.state).toBe('paid');
  });

  it('Customer가 requested 상태에서 cancel → 상태 전이 승인', async () => {
    upsertOrder(makeOrder({ state: 'requested' }));
    await handleCancelRequest(makeRequest('cancel-request', CUSTOMER_PUBKEY));
    expect(publishOrderSpy).toHaveBeenCalledTimes(1);
    const published = publishOrderSpy.mock.calls[0][0] as Order;
    expect(published.state).toBe('cancelled');
  });

  it('±4% 허용 범위 내 인보이스 claim → 승인', async () => {
    upsertOrder(makeOrder({ state: 'requested' }));
    const claim = makeClaimRequest({
      invoice: {
        bolt11: 'lnbc-within-range',
        decoded: {
          destination: SPONSOR_PUBKEY,
          amountSat: Math.round(EXPECTED_SAT * 1.04),
          paymentHash: 'hash-range',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          routeHints: [],
        },
        liquidityVerified: true,
      },
    });
    await handleClaim(claim);
    expect(publishOrderSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 존재하지 않는 오더 공격 ──────────────────────────────────────────

describe('유령 오더 공격 — 존재하지 않는 orderId 사용', () => {
  it('없는 orderId로 claim → 차단', async () => {
    // order-store가 비어있는 상태에서 claim
    await handleClaim(makeClaimRequest({ orderId: 'non-existent-order' }));
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });

  it('없는 orderId로 payment-confirm → 차단', async () => {
    await handlePaymentConfirm(makeRequest('payment-confirm', CUSTOMER_PUBKEY, { orderId: 'non-existent-order' }));
    expect(publishOrderSpy).not.toHaveBeenCalled();
  });
});
