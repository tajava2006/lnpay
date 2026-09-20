/**
 * 온체인 보증금 처리 (PLAN-ONCHAIN-TRACK §4.1 · §6.0)
 *
 * **여기가 실제 돈이 움직이는 자리다.** 표를 잘못 읽으면 억제 장치가 사라지거나
 * (몰수해야 하는데 환불) 남의 돈을 가져간다(환불해야 하는데 몰수).
 * 그래서 `OUTCOME_RULES` 전수를 돈다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OUTCOME_RULES, type OnchainOutcome, type OnchainOrder } from '@sajwo-tracker/shared/onchain';

const preimages: Record<string, string | null> = {
  'onchain:o-1': 'preimage-customer',
  'onchain:o-1:spon': 'preimage-sponsor',
};
vi.mock('../escrow-store', () => ({
  getPreimage: (key: string) => preimages[key] ?? null,
}));

const published: string[] = [];
vi.mock('../onchain/publish', () => ({
  publishOnchainDepositStatus: async (orderId: string, pubkey: string, status: string) => {
    published.push(`${orderId}:${pubkey}:${status}`);
  },
}));

const meta = await import('../onchain/escrow-meta-store');
const { handleOnchainOutcome } = await import('../onchain/deposit-lifecycle');

type HoldStatus = 'open' | 'accepted' | 'settled' | 'cancelled';
const ln = {
  lookupHoldInvoice: vi.fn(async (): Promise<HoldStatus> => 'accepted'),
  cancelInvoice: vi.fn(async () => {}),
  settleInvoice: vi.fn(async () => {}),
};

function order(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'o-1', state: 'settling', status: 'active',
    customerPubkey: 'cust', sponsorPubkey: 'spon', amountSat: 500_000,
    createdAt: 1, updatedAt: 1, expiration: 2_000_000_000, network: 'signet',
    customerDepositHash: 'hash-c', sponsorDepositHash: 'hash-s',
    raw: {},
    ...over,
  };
}

beforeEach(() => {
  meta._resetForTesting();
  meta.mergeEscrowMeta('o-1', {
    customerDepositKey: 'onchain:o-1',
    sponsorDepositKey: 'onchain:o-1:spon',
  });
  published.length = 0;
  vi.clearAllMocks();
  ln.lookupHoldInvoice.mockResolvedValue('accepted');
});

describe('표를 그대로 집행한다', () => {
  const OUTCOMES = Object.keys(OUTCOME_RULES) as OnchainOutcome[];

  it.each(OUTCOMES)('%s', async outcome => {
    await handleOnchainOutcome(order(), outcome, ln as never);
    const rule = OUTCOME_RULES[outcome];

    const expectedCancels =
      (rule.customerBond === 'refund' ? 1 : 0) + (rule.sponsorBond === 'refund' ? 1 : 0);
    const expectedSettles =
      (rule.customerBond === 'forfeit' ? 1 : 0) + (rule.sponsorBond === 'forfeit' ? 1 : 0);

    expect(ln.cancelInvoice, `${outcome} 환불 수`).toHaveBeenCalledTimes(expectedCancels);
    expect(ln.settleInvoice, `${outcome} 몰수 수`).toHaveBeenCalledTimes(expectedSettles);
  });

  /** 어드민이 죽은 종결이라 손댈 수 없다 — LN 만료가 알아서 환불한다. */
  it('swept은 아무것도 건드리지 않는다', async () => {
    await handleOnchainOutcome(order(), 'swept', ln as never);
    expect(ln.cancelInvoice).not.toHaveBeenCalled();
    expect(ln.settleInvoice).not.toHaveBeenCalled();
  });

  it('후원자가 안 붙은 취소는 고객 것만 환불한다', async () => {
    await handleOnchainOutcome(
      order({ sponsorPubkey: undefined, sponsorDepositHash: undefined }),
      'cancel:expired', ln as never,
    );
    expect(ln.cancelInvoice).toHaveBeenCalledTimes(1);
    expect(published).toContain('o-1:cust:cancelled');
  });
});

describe('안전장치', () => {
  /** 이미 정산·환불된 것을 다시 건드리면 남의 돈을 두 번 처리하려 든다. */
  it('accepted가 아니면 손대지 않는다', async () => {
    ln.lookupHoldInvoice.mockResolvedValue('settled');
    await handleOnchainOutcome(order(), 'customer_win', ln as never);
    expect(ln.cancelInvoice).not.toHaveBeenCalled();
    expect(ln.settleInvoice).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ 프리이미지가 없으면 몰수할 수 없다. **조용히 넘기면** 억제 장치가 통째로
   * 사라진 것이고 아무도 그 사실을 모른다.
   */
  it('프리이미지가 없으면 몰수하지 않고 크게 남긴다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    meta._resetForTesting(); // 저장 키가 사라진 상황
    await handleOnchainOutcome(order(), 'customer_win', ln as never);
    expect(ln.settleInvoice).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('보증금 해시가 없으면 조용히 넘어간다', async () => {
    await handleOnchainOutcome(
      order({ customerDepositHash: undefined, sponsorDepositHash: undefined }),
      'release', ln as never,
    );
    expect(ln.cancelInvoice).not.toHaveBeenCalled();
  });

  it('LN 어댑터가 없으면 아무것도 안 한다', async () => {
    await handleOnchainOutcome(order(), 'release', null);
    expect(ln.cancelInvoice).not.toHaveBeenCalled();
  });
});

describe('상대에게 결과를 알린다', () => {
  it('정상 완료는 양쪽 환불을 통지한다', async () => {
    await handleOnchainOutcome(order(), 'release', ln as never);
    expect(published).toEqual(
      expect.arrayContaining(['o-1:cust:cancelled', 'o-1:spon:cancelled']),
    );
  });

  it('몰수는 settled로 통지한다', async () => {
    await handleOnchainOutcome(order(), 'cancel:no-funding', ln as never);
    expect(published).toContain('o-1:cust:settled');
    expect(published).toContain('o-1:spon:cancelled');
  });
});
