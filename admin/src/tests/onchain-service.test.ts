/**
 * 온체인 요청 핸들러 (PLAN-ONCHAIN-TRACK §5.2 · §9)
 *
 * 사람이 미는 쪽 전부 — 의뢰·클레임·사전서명·최종서명·분쟁. 여기서 지키는 건
 * "**누가** 보냈는지"와 "**무엇에 대한** 서명인지"다. 둘 중 하나만 놓쳐도
 * 남의 주문에 남의 서명이 붙는다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildSettlementTx, deriveEscrowAddress, deriveSingleKeyAddress, formatOutpoint,
  signSettlement, toPsbtBase64, xonlyFromPrivkey, settlementFeeSat,
  type OnchainOrder,
} from '@sajwo-tracker/shared/onchain';

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const SK_C = sk(1), SK_S = sk(40), SK_A = sk(80), SK_D = sk(120);
const XC = xonlyFromPrivkey(SK_C);
const XS = xonlyFromPrivkey(SK_S);
const CUST = 'cust-pubkey';
const SPON = 'sponsor-pubkey';
const TXID = 'd4'.repeat(32);
const AMOUNT = 500_000;

// ── 배관 흉내 ────────────────────────────────────────────────

const signer = {
  nip44Encrypt: vi.fn(async (_pk: string, text: string) => `enc:${text}`),
  nip44Decrypt: vi.fn(async (_pk: string, c: string) => {
    if (!c.startsWith('enc:')) throw new Error('복호화 실패');
    return c.slice(4);
  }),
  signEvent: vi.fn(async (t: object) => ({ ...t, id: 'evt', sig: 'sig' })),
};
vi.mock('../nostr/nip46', () => ({ getSigner: () => signer }));

const published: Array<{ tags: string[][]; content: string }> = [];
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish(relays: string[], event: { tags: string[][]; content: string }) {
      published.push(event);
      return relays.map(() => Promise.resolve('ok'));
    }
    async get() { return null; }
    destroy() {}
  },
}));
vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  getReadRelays: async () => ['wss://r'],
  getWriteRelays: async () => ['wss://r'],
}));

/** 어드민 키는 결정론적이어야 테스트가 주소를 미리 안다 */
let keyBackupOk = true;
vi.mock('../onchain/key-store', () => ({
  createOrderKeyWithBackup: vi.fn(async () => {
    if (!keyBackupOk) throw new Error('백업 발행 실패');
    return { privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) };
  }),
  getOrderKey: vi.fn(async () => ({ privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) })),
}));

const svc = await import('../onchain/service');
const store = await import('../onchain/order-store');
const deposits = await import('../onchain/pending-deposit-store');
const pendingSettle = await import('../onchain/pending-settlement-store');
const meta = await import('../onchain/escrow-meta-store');

const XA = xonlyFromPrivkey(SK_A);
const DESCRIPTOR = deriveEscrowAddress({
  keys: { customer: XC, sponsor: XS, admin: XA }, network: 'signet',
});
const PAYOUT = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'signet');

type HoldStatus = 'open' | 'accepted' | 'settled' | 'cancelled';
const ln = {
  createHoldInvoice: vi.fn(async (_id: string, amountSat: number) => ({
    bolt11: `lnbc${amountSat}`, paymentHash: `hash-${amountSat}`,
  })),
  lookupHoldInvoice: vi.fn(async (): Promise<HoldStatus> => 'open'),
  cancelInvoice: vi.fn(async () => {}),
  settleInvoice: vi.fn(async () => {}),
};

type Fees = { fastest: number; halfHour: number; hour: number; economy: number; minimum: number };
type Q<T> = { known: true; value: T } | { known: false; reason: string };
const chain = {
  getAddressFunds: vi.fn(),
  getTxStatus: vi.fn(),
  getFeeEstimates: vi.fn(async (): Promise<Q<Fees>> => ({
    known: true, value: { fastest: 4, halfHour: 2, hour: 1, economy: 1, minimum: 1 },
  })),
  getTipHeight: vi.fn(),
  broadcastTx: vi.fn(async (): Promise<Q<string>> => ({ known: true, value: TXID })),
};

function req<T extends object>(over: T & { orderId: string; pubkey: string }, content = '') {
  return {
    eventId: 'e', createdAt: 1, expiration: 0,
    raw: { content }, ...over,
  };
}

function order(over: Partial<OnchainOrder> = {}): OnchainOrder {
  return {
    orderId: 'o-1', state: 'listed', status: 'active',
    customerPubkey: CUST, amountSat: AMOUNT,
    createdAt: 1, updatedAt: 1,
    expiration: Math.floor(Date.now() / 1000) + 86_400,
    network: 'signet', customerXonly: XC, raw: {},
    ...over,
  };
}

/** `funded`까지 간 주문 — 사전서명·종결 테스트의 출발점 */
function fundedOrder(over: Partial<OnchainOrder> = {}): OnchainOrder {
  const releaseFeeSat = settlementFeeSat('release', DESCRIPTOR, PAYOUT, 2);
  return order({
    state: 'funded', sponsorPubkey: SPON, sponsorXonly: XS, adminXonly: XA,
    escrowAddress: DESCRIPTOR.address, timelockBlocks: DESCRIPTOR.timelockBlocks,
    fundingOutpoint: formatOutpoint(TXID, 0), fundingConfs: 2,
    fundedAt: Math.floor(Date.now() / 1000), priceKrw: 500_000,
    payoutSat: AMOUNT - releaseFeeSat, releaseFeeSat,
    ...over,
  });
}

beforeEach(() => {
  store._resetForTesting();
  deposits._resetForTesting();
  pendingSettle._resetForTesting();
  meta._resetForTesting();
  published.length = 0;
  keyBackupOk = true;
  vi.clearAllMocks();
  ln.lookupHoldInvoice.mockResolvedValue('open');
  chain.getFeeEstimates.mockResolvedValue({
    known: true, value: { fastest: 4, halfHour: 2, hour: 1, economy: 1, minimum: 1 },
  });
  chain.broadcastTx.mockResolvedValue({ known: true, value: TXID });
  svc.configureOnchainService({ lnAdapter: ln as never, chain: chain as never, network: 'signet' });
});

// ── ① 의뢰 등록 ─────────────────────────────────────────────

describe('의뢰 등록', () => {
  const orderReq = (over: Partial<{ amountSat: number; expiration: number }> = {}) => req({
    orderId: 'o-1', pubkey: CUST, action: 'onchain-order-request' as const,
    amountSat: AMOUNT, customerXonly: XC,
    ...over,
  });

  it('보증금 인보이스를 내고 대기에 넣는다', async () => {
    await svc.handleOnchainOrderRequest({
      ...orderReq(), expiration: Math.floor(Date.now() / 1000) + 86_400,
    } as never);

    expect(ln.createHoldInvoice).toHaveBeenCalledTimes(1);
    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(1);
    // 아직 오더는 없다 — **보증금 결제가 곧 등록**이다
    expect(store.getOnchainOrder('o-1')).toBeUndefined();
  });

  /** 넘으면 보증금 CLTV가 채널 상한을 넘어 **인보이스를 못 만든다**(§2.2). */
  it('의뢰 만료가 7일을 넘으면 거부한다', async () => {
    await svc.handleOnchainOrderRequest({
      ...orderReq(), expiration: Math.floor(Date.now() / 1000) + 8 * 86_400,
    } as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  /** 이 아래로는 보증금이 거래액의 3%를 넘어 억제가 아니라 허들이 된다(§12 Q8). */
  it('최소 거래액 미만이면 거부한다', async () => {
    await svc.handleOnchainOrderRequest({
      ...orderReq({ amountSat: 1000 }), expiration: Math.floor(Date.now() / 1000) + 86_400,
    } as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  it('수수료를 모르면 보증금을 계산하지 않는다', async () => {
    chain.getFeeEstimates.mockResolvedValue({ known: false, reason: '502' });
    await svc.handleOnchainOrderRequest({
      ...orderReq(), expiration: Math.floor(Date.now() / 1000) + 86_400,
    } as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  it('같은 의뢰를 두 번 받아도 인보이스는 하나다', async () => {
    const r = { ...orderReq(), expiration: Math.floor(Date.now() / 1000) + 86_400 };
    await svc.handleOnchainOrderRequest(r as never);
    await svc.handleOnchainOrderRequest(r as never);
    expect(ln.createHoldInvoice).toHaveBeenCalledTimes(1);
  });
});

// ── ② 클레임 ────────────────────────────────────────────────

describe('클레임', () => {
  const payload = JSON.stringify({ payoutAddress: PAYOUT, feerateSatPerVb: 2 });
  const claim = (pubkey = SPON) => req(
    { orderId: 'o-1', pubkey, action: 'onchain-claim' as const, sponsorXonly: XS },
    `enc:${payload}`,
  );

  beforeEach(() => store.upsertOnchainOrder(order()));

  it('후원자 보증금 인보이스를 낸다 (3%)', async () => {
    await svc.handleOnchainClaim(claim() as never);
    expect(ln.createHoldInvoice).toHaveBeenCalledTimes(1);
    const [, amount] = ln.createHoldInvoice.mock.calls[0]!;
    expect(amount).toBeGreaterThanOrEqual(Math.ceil(AMOUNT * 0.03));
  });

  /** 한 사람이 양쪽이면 2-of-3 보장이 사라진다 (§3.3 · T-005 인접). */
  it('자기 의뢰를 자기가 클레임할 수 없다', async () => {
    await svc.handleOnchainClaim(claim(CUST) as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  it('이미 누가 가져간 주문은 받지 않는다', async () => {
    store.upsertOnchainOrder(order({ state: 'bonded', updatedAt: 2 }));
    await svc.handleOnchainClaim(claim() as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  it('페이로드가 이상하면 거부한다', async () => {
    await svc.handleOnchainClaim(
      req({ orderId: 'o-1', pubkey: SPON, action: 'onchain-claim' as const, sponsorXonly: XS },
        'enc:{"payoutAddress":"","feerateSatPerVb":0}') as never,
    );
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  /** 나중에 알면 **종결 직전에** 막힌다. 지금 확인한다. */
  it('다른 네트워크 주소를 내면 거부한다', async () => {
    const mainnetAddr = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'mainnet');
    await svc.handleOnchainClaim(
      req({ orderId: 'o-1', pubkey: SPON, action: 'onchain-claim' as const, sponsorXonly: XS },
        `enc:${JSON.stringify({ payoutAddress: mainnetAddr, feerateSatPerVb: 2 })}`) as never,
    );
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  /** 여러 명이 동시에 시도해도 된다 — **먼저 결제한 쪽**이 가져간다(§4.1b). */
  it('여러 후원자가 동시에 인보이스를 받을 수 있다', async () => {
    await svc.handleOnchainClaim(claim('sponsor-a') as never);
    await svc.handleOnchainClaim(claim('sponsor-b') as never);
    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(2);
  });
});

// ── ③ 보증금 결제 ───────────────────────────────────────────

describe('보증금 결제 감시', () => {
  it('고객 보증금이 잡히면 오더가 등록된다', async () => {
    deposits.putOnchainDeposit({
      orderId: 'o-1', type: 'customer', customerPubkey: CUST,
      depositPaymentHash: 'h', depositBolt11: 'lnbc', amountSat: 5000, createdAt: 1,
      tradeAmountSat: AMOUNT, expiration: Math.floor(Date.now() / 1000) + 86_400,
      customerXonly: XC,
    });
    ln.lookupHoldInvoice.mockResolvedValue('accepted');

    await svc.checkOnchainDeposits();

    expect(store.getOnchainOrder('o-1')?.state).toBe('listed');
    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(0);
  });

  describe('후원자 보증금 = 클레임 성립', () => {
    beforeEach(() => {
      store.upsertOnchainOrder(order());
      for (const who of ['sponsor-a', 'sponsor-b']) {
        deposits.putOnchainDeposit({
          orderId: 'o-1', type: 'sponsor', sponsorPubkey: who, customerPubkey: CUST,
          depositPaymentHash: `h-${who}`, depositBolt11: 'lnbc', amountSat: 15_000, createdAt: 1,
          sponsorXonly: XS, payoutAddress: PAYOUT, feerateSatPerVb: 2,
        });
      }
      ln.lookupHoldInvoice.mockResolvedValue('accepted');
    });

    it('먼저 결제한 쪽이 가져가고 주소가 발행된다', async () => {
      await svc.checkOnchainDeposits();
      const after = store.getOnchainOrder('o-1')!;
      expect(after.state).toBe('bonded');
      expect(after.escrowAddress).toBe(DESCRIPTOR.address);
      expect(after.fundingDeadline).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    /** 나머지 HTLC는 취소한다 — **실패라 라우팅 수수료가 0**이다. */
    it('나머지 후보의 인보이스를 취소한다', async () => {
      await svc.checkOnchainDeposits();
      expect(ln.cancelInvoice).toHaveBeenCalled();
      expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(0);
    });

    /**
     * ⚠️ **공격 M.** 백업이 안 올라갔는데 주소를 발행하면, 그 기기를 잃는 순간
     * 그 주문은 중재도 환불도 영영 불가능해진다.
     */
    it('어드민 키 백업이 실패하면 주소를 발행하지 않는다', async () => {
      keyBackupOk = false;
      await svc.checkOnchainDeposits();
      const after = store.getOnchainOrder('o-1')!;
      expect(after.state).toBe('listed');
      expect(after.escrowAddress).toBeUndefined();
    });
  });
});

// ── ④ 사전서명 ──────────────────────────────────────────────

describe('사전서명', () => {
  function presigPsbt(over: { destination?: string; feeSat?: number } = {}): string {
    const o = fundedOrder();
    const tx = buildSettlementTx({
      descriptor: DESCRIPTOR,
      input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'release',
      destination: over.destination ?? PAYOUT,
      feeSat: over.feeSat ?? o.releaseFeeSat!,
    });
    signSettlement(tx, SK_S);
    return toPsbtBase64(tx);
  }

  beforeEach(() => {
    store.upsertOnchainOrder(fundedOrder());
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2 });
  });

  it('검증을 통과하면 presigned로 가고 고객에게 서명 요청을 보낸다', async () => {
    await svc.handleOnchainPresig(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-presig' as const },
      `enc:${JSON.stringify({ psbt: presigPsbt() })}`,
    ) as never);

    const after = store.getOnchainOrder('o-1')!;
    expect(after.state).toBe('presigned');
    expect(after.presignedAt).toBeGreaterThan(0);

    const signReq = published.find(e =>
      e.tags.some(t => t[0] === 'action' && t[1] === 'onchain-cosign'));
    expect(signReq).toBeDefined();
    // PSBT는 **암호문**으로 나간다 — 안에 후원자 지갑 주소가 들어 있다
    expect(signReq!.content.startsWith('enc:')).toBe(true);
  });

  it('후원자가 아닌 쪽이 보내면 무시한다', async () => {
    await svc.handleOnchainPresig(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-presig' as const },
      `enc:${JSON.stringify({ psbt: presigPsbt() })}`,
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('funded');
  });

  /** ⚠️ T-109 — 자기에게 유리한 다른 tx에 서명해 보내는 것. */
  it('다른 금액으로 서명한 PSBT는 거부한다', async () => {
    await svc.handleOnchainPresig(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-presig' as const },
      `enc:${JSON.stringify({ psbt: presigPsbt({ feeSat: 100 }) })}`,
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('funded');
  });

  it('funded가 아니면 받지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', updatedAt: 99 }));
    await svc.handleOnchainPresig(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-presig' as const },
      `enc:${JSON.stringify({ psbt: presigPsbt() })}`,
    ) as never);
    expect(store.getOnchainOrder('o-1')!.presignedAt).toBeUndefined();
  });
});

// ── ⑤ 최종 서명 → 브로드캐스트 ──────────────────────────────

describe('최종 서명', () => {
  function releaseReady(): string {
    const o = fundedOrder();
    const tx = buildSettlementTx({
      descriptor: DESCRIPTOR,
      input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'release', destination: PAYOUT, feeSat: o.releaseFeeSat!,
    });
    signSettlement(tx, SK_S);
    signSettlement(tx, SK_C);
    return toPsbtBase64(tx);
  }

  beforeEach(() => {
    store.upsertOnchainOrder(fundedOrder({ state: 'remitted', remittedAt: 1 }));
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2 });
  });

  it('고객 서명이 붙으면 브로드캐스트하고 settling으로 간다', async () => {
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: releaseReady() })}`,
    ) as never);

    expect(chain.broadcastTx).toHaveBeenCalledTimes(1);
    const after = store.getOnchainOrder('o-1')!;
    expect(after.state).toBe('settling');
    expect(after.settlementTxid).toBe(TXID);
    expect(after.settlementKind).toBe('release');
    expect(after.settlingAt).toBeGreaterThan(0);
  });

  it('브로드캐스트가 실패하면 상태를 바꾸지 않는다', async () => {
    chain.broadcastTx.mockResolvedValue({ known: false, reason: 'min relay fee not met' });
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: releaseReady() })}`,
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('remitted');
  });

  it('고객이 아닌 쪽의 릴리스 서명은 무시한다', async () => {
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: releaseReady() })}`,
    ) as never);
    expect(chain.broadcastTx).not.toHaveBeenCalled();
  });

  it('서명이 빠진 PSBT는 거부한다', async () => {
    const tx = buildSettlementTx({
      descriptor: DESCRIPTOR,
      input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'release', destination: PAYOUT, feeSat: fundedOrder().releaseFeeSat!,
    });
    signSettlement(tx, SK_S); // 고객 서명 없음
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(tx) })}`,
    ) as never);
    expect(chain.broadcastTx).not.toHaveBeenCalled();
  });
});

// ── ⑥ 분쟁 ──────────────────────────────────────────────────

describe('분쟁', () => {
  it('remitted에서는 분쟁이 열린다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'remitted', remittedAt: 1 }));
    await svc.handleOnchainDispute(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-dispute' as const },
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('disputed');
  });

  /**
   * ⚠️ **계좌 이의는 상태가 아니다**(§5.2b). 상태로 받으면 원화 마감 시계가
   * 멈추고 그 순간 **최장 8주짜리 무한 옵션**이 열린다(§7.6 R4-H1).
   */
  it('presigned에서 계좌 이의는 시계를 멈추지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: 1 }));
    await svc.handleOnchainDispute(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-dispute' as const,
        stage: 'account-unusable' as const },
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('presigned');
  });

  it('제3자는 분쟁을 걸 수 없다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'remitted', remittedAt: 1 }));
    await svc.handleOnchainDispute(req(
      { orderId: 'o-1', pubkey: 'stranger', action: 'onchain-dispute' as const },
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('remitted');
  });
});

// ── ⑦ 종결 준비 ─────────────────────────────────────────────

describe('종결 준비', () => {
  beforeEach(() => {
    store.upsertOnchainOrder(fundedOrder());
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2 });
  });

  /**
   * ⚠️ 환불이 발동하는 순간이 바로 **고객이 응답하지 않는** 순간이다.
   * 주소를 물어보는 설계면 물어볼 수 없을 때 물어봐야 한다.
   */
  it('환불 주소는 고객 주문별 키에서 결정론적으로 나온다', async () => {
    await svc.prepareOnchainSettlement(
      store.getOnchainOrder('o-1')!, 'refund:sponsor-timeout',
    );
    const pending = pendingSettle.getPendingSettlement('o-1')!;
    expect(pending.destination).toBe(deriveSingleKeyAddress(XC, 'signet'));
    expect(pending.awaiting).toBe('customer');
    expect(pending.path).toBe('refund');
  });

  it('후원자승은 후원자 주소로 가고 후원자가 서명한다', async () => {
    await svc.prepareOnchainSettlement(store.getOnchainOrder('o-1')!, 'sponsor_win');
    const pending = pendingSettle.getPendingSettlement('o-1')!;
    expect(pending.destination).toBe(PAYOUT);
    expect(pending.awaiting).toBe('sponsor');
  });

  /** 대기 중인 PSBT에는 이미 어드민 서명이 있다. 새로 만들면 둘이 갈린다. */
  it('이미 대기 중이면 새로 만들지 않는다', async () => {
    const o = store.getOnchainOrder('o-1')!;
    await svc.prepareOnchainSettlement(o, 'refund:sponsor-timeout');
    const first = pendingSettle.getPendingSettlement('o-1')!.psbt;
    await svc.prepareOnchainSettlement(o, 'refund:customer-late');
    expect(pendingSettle.getPendingSettlement('o-1')!.psbt).toBe(first);
    expect(pendingSettle.getPendingSettlement('o-1')!.settlementKind).toBe('refund:sponsor-timeout');
  });

  /** `releaseFeeSat`은 T0 고정이라 분쟁이 길어지면 낡는다 — tx가 멤풀에서 썩는다(§6.1). */
  it('수수료를 새로 추정한다', async () => {
    chain.getFeeEstimates.mockResolvedValue({
      known: true, value: { fastest: 60, halfHour: 50, hour: 40, economy: 10, minimum: 1 },
    });
    await svc.prepareOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:reserve');
    const pending = pendingSettle.getPendingSettlement('o-1')!;
    expect(pending.feeSat).toBeGreaterThan(store.getOnchainOrder('o-1')!.releaseFeeSat! * 10);
  });

  it('수수료를 모르면 미룬다', async () => {
    chain.getFeeEstimates.mockResolvedValue({ known: false, reason: '502' });
    await svc.prepareOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:reserve');
    expect(pendingSettle.getPendingSettlement('o-1')).toBeUndefined();
  });
});

// ── ⑧ 계좌 공개 시점 ────────────────────────────────────────

describe('계좌 공개 (O-013)', () => {
  it('공개 시점부터 후원자 마감을 센다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: 1 }));
    await svc.noteAccountInfoSent('o-1');

    const after = store.getOnchainOrder('o-1')!;
    expect(after.accountSentAt).toBeGreaterThan(0);
    expect(after.krwDeadline).toBe(after.accountSentAt! + 30 * 60);
    expect(svc.accountInfoSent('o-1')).toBe(true);
  });

  /** 사전서명 전에는 계좌가 **릴레이에 존재하지도 않아야** 한다 (O-003). */
  it('presigned 전에는 기록하지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder());
    await svc.noteAccountInfoSent('o-1');
    expect(store.getOnchainOrder('o-1')!.accountSentAt).toBeUndefined();
  });

  it('두 번 불러도 시각이 안 밀린다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: 1 }));
    await svc.noteAccountInfoSent('o-1');
    const first = store.getOnchainOrder('o-1')!.accountSentAt;
    await svc.noteAccountInfoSent('o-1');
    expect(store.getOnchainOrder('o-1')!.accountSentAt).toBe(first);
  });
});
