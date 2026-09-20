/**
 * 온체인 트랙 e2e 시나리오 (PLAN-ONCHAIN-TRACK §11 P6)
 *
 * **유닛 테스트가 못 잡는 걸 잡는다.** 각 조각은 다 통과하는데 이어 붙이면
 * 안 도는 경우 — 상태가 한 칸 어긋나거나, 어느 핸들러가 기대하는 필드를
 * 앞 단계가 안 채워두거나 — 가 여기서 걸린다.
 *
 * 체인과 LN을 가짜로 두고 **시계를 손으로 돌린다.** signet 드릴(실제 코인)의
 * 대역은 아니지만, 드릴에서 헤맬 자리를 먼저 줄여준다.
 *
 * 네 가지를 돌린다:
 *   ① 정상 완료
 *   ② 후원자 이탈 (사전서명 마감 초과 → 환불 + 후원자 몰수)
 *   ③ 분쟁 → 후원자 승
 *   ④ 고객 미펀딩 (마감 초과 → 취소 + 고객 몰수)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ACCOUNT_WINDOW_SEC, COSIGN_WINDOW_SEC, FUNDING_WINDOW_SEC, PRESIGN_WINDOW_SEC,
  buildSettlementTx, deriveEscrowAddress, deriveSingleKeyAddress, formatOutpoint,
  fromPsbtBase64, settlementFeeSat, signSettlement, toPsbtBase64, xonlyFromPrivkey,
  type AddressFunds, type ChainQuery, type TxStatus,
} from '@sajwo-tracker/shared/onchain';

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const SK_C = sk(1), SK_S = sk(40), SK_A = sk(80), SK_D = sk(120);
const XC = xonlyFromPrivkey(SK_C);
const XS = xonlyFromPrivkey(SK_S);
const XA = xonlyFromPrivkey(SK_A);
const CUST = 'customer-pubkey';
const SPON = 'sponsor-pubkey';
const ORDER = 'o-e2e';
const AMOUNT = 500_000;
const FUND_TXID = 'aa'.repeat(32);
const SETTLE_TXID = 'bb'.repeat(32);

// ── 배관 흉내 ────────────────────────────────────────────────

const signer = {
  nip44Encrypt: vi.fn(async (_pk: string, t: string) => `enc:${t}`),
  nip44Decrypt: vi.fn(async (_pk: string, c: string) => {
    if (!c.startsWith('enc:')) throw new Error('복호화 실패');
    return c.slice(4);
  }),
  signEvent: vi.fn(async (t: object) => ({ ...t, id: 'evt', sig: 'sig' })),
};
vi.mock('../nostr/nip46', () => ({ getSigner: () => signer }));
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish(relays: string[]) { return relays.map(() => Promise.resolve('ok')); }
    async get() { return null; }
    destroy() {}
  },
}));
vi.mock('@sajwo-tracker/shared', async importOriginal => ({
  ...(await importOriginal<object>()),
  getReadRelays: async () => ['wss://r'],
  getWriteRelays: async () => ['wss://r'],
}));
vi.mock('../onchain/key-store', () => ({
  createOrderKeyWithBackup: vi.fn(async () => ({ privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) })),
  getOrderKey: vi.fn(async () => ({ privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) })),
}));
vi.mock('../web-push/send', () => ({ sendPush: vi.fn(async () => {}) }));

const svc = await import('../onchain/service');
const store = await import('../onchain/order-store');
const deposits = await import('../onchain/pending-deposit-store');
const settlements = await import('../onchain/pending-settlement-store');
const meta = await import('../onchain/escrow-meta-store');
const alerts = await import('../onchain/alert-store');
const { tickOnchainOrder } = await import('../onchain/watcher');
const { handleOnchainOutcome } = await import('../onchain/deposit-lifecycle');

const DESCRIPTOR = deriveEscrowAddress({
  keys: { customer: XC, sponsor: XS, admin: XA }, network: 'signet',
});
const PAYOUT = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'signet');
const REFUND_ADDR = deriveSingleKeyAddress(XC, 'signet');

// ── 가짜 체인 ────────────────────────────────────────────────

class FakeChain {
  funded = false;
  confirmations = 0;
  settlementConfs = 0;
  broadcasted: string[] = [];

  async getAddressFunds(): Promise<ChainQuery<AddressFunds>> {
    if (!this.funded) return { known: true, value: { confirmed: [], mempool: [] } };
    return {
      known: true,
      value: {
        confirmed: [{
          txid: FUND_TXID, vout: 0, valueSat: AMOUNT, confirmations: this.confirmations,
        }],
        mempool: [],
      },
    };
  }
  async getTxStatus(): Promise<ChainQuery<TxStatus>> {
    return {
      known: true,
      value: {
        confirmed: this.settlementConfs > 0,
        confirmations: this.settlementConfs,
        blockHeight: 1,
      },
    };
  }
  async getFeeEstimates() {
    return {
      known: true as const,
      value: { fastest: 4, halfHour: 2, hour: 1, economy: 1, minimum: 1 },
    };
  }
  async getTipHeight() { return { known: true as const, value: 100 }; }
  async broadcastTx(hex: string) {
    this.broadcasted.push(hex);
    return { known: true as const, value: SETTLE_TXID };
  }
}

// ── 가짜 LN ──────────────────────────────────────────────────

type HoldStatus = 'open' | 'accepted' | 'settled' | 'cancelled';

class FakeLn {
  invoices = new Map<string, { id: string; amountSat: number; status: HoldStatus }>();
  actions: string[] = [];

  async createHoldInvoice(id: string, amountSat: number) {
    const paymentHash = `hash:${id}`;
    this.invoices.set(paymentHash, { id, amountSat, status: 'open' });
    return { bolt11: `lnbc-${id}`, paymentHash };
  }
  async lookupHoldInvoice(paymentHash: string): Promise<HoldStatus> {
    return this.invoices.get(paymentHash)?.status ?? 'cancelled';
  }
  async cancelInvoice(paymentHash: string) {
    const inv = this.invoices.get(paymentHash);
    if (inv) inv.status = 'cancelled';
    this.actions.push(`cancel:${inv?.id ?? paymentHash}`);
  }
  async settleInvoice(preimage: string) {
    this.actions.push(`settle:${preimage}`);
  }
  /** 유저가 결제했다 */
  pay(idPart: string) {
    for (const [, inv] of this.invoices) {
      if (inv.id.includes(idPart) && inv.status === 'open') inv.status = 'accepted';
    }
  }
}

// 프리이미지 저장소 흉내 — 몰수에 필요하다
vi.mock('../escrow-store', () => ({
  getPreimage: (key: string) => `preimage:${key}`,
}));

let chain: FakeChain;
let ln: FakeLn;
let clock: number;

function req<T extends object>(over: T, content = '') {
  return { eventId: 'e', createdAt: clock, expiration: 0, raw: { content }, ...over };
}

function advance(seconds: number): void {
  clock += seconds;
  vi.setSystemTime(clock * 1000);
}

/**
 * 한 틱. 보증금 처리는 프로덕션에서 fire-and-forget이라(상태 전이가 LN을
 * 기다리면 안 된다) 여기서는 **그 약속들을 모아 끝까지 기다린다** — 안 그러면
 * 테스트가 LN 동작을 관측하기 전에 단언한다.
 */
async function tick(): Promise<void> {
  const settled: Promise<unknown>[] = [];
  await svc.checkOnchainDeposits();
  for (const order of svc.listOnchainOrders()) {
    await tickOnchainOrder(order, {
      now: () => clock,
      chain: chain as never,
      btcPriceKrw: () => 100_000_000,
      sponsorBondAlive: async o => {
        if (!o.sponsorDepositHash) return undefined;
        return (await ln.lookupHoldInvoice(o.sponsorDepositHash)) === 'accepted';
      },
      accountInfoSent: svc.accountInfoSent,
      releaseFeeSat: svc.onchainReleaseFeeSat,
      commit: svc.commitOnchainOrder,
      prepareSettlement: svc.prepareOnchainSettlement,
      onOutcome: (o, outcome) => { settled.push(handleOnchainOutcome(o, outcome, ln as never)); },
      raise: (o, level, why) => alerts.raiseOnchainAlert(o, level, why),
      listOrders: svc.listOnchainOrders,
      checkDeposits: svc.checkOnchainDeposits,
    });
  }
  await Promise.all(settled);
}

/** 의뢰 등록 → 보증금 결제 → `listed` */
async function openOrder(): Promise<void> {
  await svc.handleOnchainOrderRequest(req({
    orderId: ORDER, pubkey: CUST, action: 'onchain-order-request' as const,
    amountSat: AMOUNT, customerXonly: XC, expiration: clock + 3 * 86_400,
  }) as never);
  ln.pay(`onchain:${ORDER}`);
  await tick();
}

/** 클레임 → 보증금 결제 → `bonded` */
async function claimOrder(): Promise<void> {
  await svc.handleOnchainClaim(req(
    { orderId: ORDER, pubkey: SPON, action: 'onchain-claim' as const, sponsorXonly: XS },
    `enc:${JSON.stringify({ payoutAddress: PAYOUT, feerateSatPerVb: 2 })}`,
  ) as never);
  ln.pay(`${ORDER}:${SPON}`);
  await tick();
}

/** 펀딩 컨펌 → `funded` */
async function fundOrder(): Promise<void> {
  chain.funded = true;
  chain.confirmations = 3;
  await tick();
}

/** 후원자 사전서명 → `presigned` */
async function presign(): Promise<void> {
  const order = store.getOnchainOrder(ORDER)!;
  const tx = buildSettlementTx({
    descriptor: DESCRIPTOR,
    input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: AMOUNT },
    path: 'release', destination: PAYOUT, feeSat: order.releaseFeeSat!,
  });
  signSettlement(tx, SK_S);
  await svc.handleOnchainPresig(req(
    { orderId: ORDER, pubkey: SPON, action: 'onchain-presig' as const },
    `enc:${JSON.stringify({ psbt: toPsbtBase64(tx) })}`,
  ) as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_700_000_000;
  vi.setSystemTime(clock * 1000);
  store._resetForTesting();
  deposits._resetForTesting();
  settlements._resetForTesting();
  meta._resetForTesting();
  alerts._resetForTesting();
  chain = new FakeChain();
  ln = new FakeLn();
  svc.configureOnchainService({ lnAdapter: ln as never, chain: chain as never, network: 'signet' });
});

afterEach(() => vi.useRealTimers());

// ─── ① 정상 완료 ─────────────────────────────────────────────

describe('① 정상 완료', () => {
  it('등록 → 클레임 → 펀딩 → 사전서명 → 계좌 → 송금 → 릴리스', async () => {
    await openOrder();
    expect(store.getOnchainOrder(ORDER)?.state).toBe('listed');

    await claimOrder();
    const bonded = store.getOnchainOrder(ORDER)!;
    expect(bonded.state).toBe('bonded');
    expect(bonded.escrowAddress).toBe(DESCRIPTOR.address);
    expect(bonded.fundingDeadline).toBe(clock + FUNDING_WINDOW_SEC);

    await fundOrder();
    const funded = store.getOnchainOrder(ORDER)!;
    expect(funded.state).toBe('funded');
    // 가격은 **컨펌 시점**에 고정된다 (§2.4)
    expect(funded.priceKrw).toBe(500_000);
    expect(funded.payoutSat).toBe(AMOUNT - funded.releaseFeeSat!);
    expect(funded.fundingOutpoint).toBe(formatOutpoint(FUND_TXID, 0));

    await presign();
    expect(store.getOnchainOrder(ORDER)?.state).toBe('presigned');

    // 고객이 계좌를 공개하면 **거기서부터** 후원자 30분이 시작된다 (O-013)
    await svc.noteAccountInfoSent(ORDER);
    const presigned = store.getOnchainOrder(ORDER)!;
    expect(presigned.krwDeadline).toBe(presigned.accountSentAt! + 30 * 60);

    advance(600);
    await svc.handleOnchainRemit({ orderId: ORDER, pubkey: SPON });
    expect(store.getOnchainOrder(ORDER)?.state).toBe('remitted');

    // 고객이 입금을 확인하고 서명한다 — **여기가 유일한 릴리스 트리거**다 (O-007)
    const order = store.getOnchainOrder(ORDER)!;
    const release = buildSettlementTx({
      descriptor: DESCRIPTOR,
      input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'release', destination: PAYOUT, feeSat: order.releaseFeeSat!,
    });
    signSettlement(release, SK_S);
    signSettlement(release, SK_C);
    await svc.handleOnchainCosign(req(
      { orderId: ORDER, pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(release) })}`,
    ) as never);

    const settling = store.getOnchainOrder(ORDER)!;
    expect(settling.state).toBe('settling');
    expect(settling.settlementTxid).toBe(SETTLE_TXID);
    expect(chain.broadcasted).toHaveLength(1);

    // 종결 tx가 컨펌되면 터미널
    chain.settlementConfs = 2;
    await tick();
    expect(store.getOnchainOrder(ORDER)?.state).toBe('released');

    // 양쪽 보증금이 **환불**된다 (몰수 없음)
    expect(ln.actions.filter(a => a.startsWith('settle:'))).toHaveLength(0);
    expect(ln.actions.filter(a => a.startsWith('cancel:'))).toHaveLength(2);
  });
});

// ─── ② 후원자 이탈 ───────────────────────────────────────────

describe('② 후원자 이탈 (사전서명 마감 초과)', () => {
  it('환불 tx가 준비되고 후원자 보증금이 몰수된다', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();
    expect(store.getOnchainOrder(ORDER)?.state).toBe('funded');

    // 15분이 지나도 사전서명이 없다
    advance(PRESIGN_WINDOW_SEC + 1);
    await tick();

    const pending = settlements.getPendingSettlement(ORDER)!;
    expect(pending.settlementKind).toBe('refund:sponsor-timeout');
    // **환불 주소는 고객에게 묻지 않는다** — 주문별 키에서 결정론적으로 나온다
    expect(pending.destination).toBe(REFUND_ADDR);
    expect(pending.awaiting).toBe('customer');

    // 상태는 아직 `funded`다 — 체인에 아무 일도 안 일어났다
    expect(store.getOnchainOrder(ORDER)?.state).toBe('funded');

    // 다음 틱에 **또 만들지 않는다**
    await tick();
    expect(settlements.getPendingSettlement(ORDER)!.psbt).toBe(pending.psbt);

    // 고객이 환불에 서명한다
    const signed = fromPsbtBase64(pending.psbt);
    signSettlement(signed, SK_C);
    await svc.handleOnchainCosign(req(
      { orderId: ORDER, pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'refund' as const },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(signed) })}`,
    ) as never);

    expect(store.getOnchainOrder(ORDER)?.state).toBe('settling');

    chain.settlementConfs = 2;
    await tick();
    expect(store.getOnchainOrder(ORDER)?.state).toBe('refunded');

    // 후원자 보증금 **몰수**, 고객 보증금 환불
    expect(ln.actions).toContain(`settle:preimage:onchain:${ORDER}:${SPON}`);
    expect(ln.actions).toContain(`cancel:onchain:${ORDER}`);
  });
});

// ─── ③ 분쟁 → 후원자 승 ──────────────────────────────────────

describe('③ 분쟁 (후원자 승)', () => {
  it('24시간 무응답 → 강제 분쟁 → 판정 → 후원자가 서명해 집행', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();
    await presign();
    await svc.noteAccountInfoSent(ORDER);
    await svc.handleOnchainRemit({ orderId: ORDER, pubkey: SPON });

    // 고객이 24시간 동안 아무것도 안 한다 → **동의를 묻지 않고** 분쟁으로 (O-010)
    advance(COSIGN_WINDOW_SEC + 1);
    await tick();
    expect(store.getOnchainOrder(ORDER)?.state).toBe('disputed');

    // 어드민이 판정한다 — 유일하게 사람이 하는 자리
    await svc.prepareOnchainSettlement(store.getOnchainOrder(ORDER)!, 'sponsor_win');
    const pending = settlements.getPendingSettlement(ORDER)!;
    expect(pending.awaiting).toBe('sponsor');
    expect(pending.destination).toBe(PAYOUT);

    // 후원자가 서명한다 ({A,S})
    const signed = fromPsbtBase64(pending.psbt);
    signSettlement(signed, SK_S);
    await svc.handleOnchainCosign(req(
      {
        orderId: ORDER, pubkey: SPON, action: 'onchain-cosign' as const,
        purpose: 'dispute-sponsor' as const,
      },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(signed) })}`,
    ) as never);

    expect(store.getOnchainOrder(ORDER)?.state).toBe('settling');
    chain.settlementConfs = 2;
    await tick();
    expect(store.getOnchainOrder(ORDER)?.state).toBe('sponsor_wins');

    // 고객 보증금 **몰수** → 중재료 충당
    expect(ln.actions).toContain(`settle:preimage:onchain:${ORDER}`);
  });
});

// ─── ④ 고객 미펀딩 ───────────────────────────────────────────

describe('④ 고객이 마감까지 펀딩을 컨펌 못 시킴', () => {
  it('취소되고 고객 보증금이 몰수된다', async () => {
    await openOrder();
    await claimOrder();

    advance(FUNDING_WINDOW_SEC + 1);
    await tick();

    expect(store.getOnchainOrder(ORDER)?.state).toBe('cancelled');
    expect(ln.actions).toContain(`settle:preimage:onchain:${ORDER}`);
    expect(ln.actions).toContain(`cancel:onchain:${ORDER}:${SPON}`);
  });

  /** ⚠️ 컨펌된 자금이 있으면 **마감이 지나도** 취소하지 않는다 (O-014). */
  it('마감이 지나도 컨펌된 펀딩이 있으면 취소하지 않는다', async () => {
    await openOrder();
    await claimOrder();

    chain.funded = true;
    chain.confirmations = 1;          // 500k sats는 2컨펌이 필요하다
    advance(FUNDING_WINDOW_SEC + 1);
    await tick();

    expect(store.getOnchainOrder(ORDER)?.state).toBe('bonded');
  });
});
