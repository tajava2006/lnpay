/**
 * 온체인 트랙 e2e 시나리오 (PLAN-ONCHAIN-TRACK §11 P6 · 리뷰 #8)
 *
 * **유닛 테스트가 못 잡는 걸 잡는다.** 각 조각은 다 통과하는데 이어 붙이면
 * 안 도는 경우 — 상태가 한 칸 어긋나거나, 어느 핸들러가 기대하는 필드를
 * 앞 단계가 안 채워두거나 — 가 여기서 걸린다.
 *
 * 체인과 LN을 가짜로 두고 **시계를 손으로 돌린다.** signet 드릴(실제 코인)의
 * 대역은 아니지만, 드릴에서 헤맬 자리를 먼저 줄여준다.
 *
 * ⚠️ 리뷰 #8 전의 이 하네스는 릴레이를 **"항상 성공"**으로 흉내 냈다. 그래서
 * 발행 실패·NIP-40 만료 거절이 한 번도 안 걸렸고, 거기서 터지는 사고 둘(의뢰
 * 만료를 넘긴 거래 정지, 브로드캐스트 후 발행 실패 → 엉뚱한 쪽 몰수)을 놓쳤다.
 * 이제 릴레이가 **지난 `expiration`을 거절**하고, 발행을 일부러 실패시킬 수 있다.
 * 체인도 소모된 UTXO를 목록에서 빼고(esplora `/utxo`처럼) 소모 증인을 돌려준다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ACCOUNT_WINDOW_SEC, COSIGN_WINDOW_SEC, FUNDING_WINDOW_SEC, PRESIGN_WINDOW_SEC,
  buildSettlementTx, bytesToHex, deriveEscrowAddress, deriveSingleKeyAddress, finalizeSettlement,
  formatOutpoint, fromPsbtBase64, fromRawHex, outputAddressOf, signSettlement, toPsbtBase64, xonlyFromPrivkey,
  type AddressFunds, type ChainQuery, type SpendInfo, type TxStatus,
} from '@sajwo-tracker/shared/onchain';

const sk = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => i + n);
const SK_C = sk(1), SK_S = sk(40), SK_D = sk(120), SK_R = sk(150);
const XC = xonlyFromPrivkey(SK_C);
const XS = xonlyFromPrivkey(SK_S);
const XA = xonlyFromPrivkey(sk(80));
const CUST = 'customer-pubkey';
const SPON = 'sponsor-pubkey';
const ORDER = 'o-e2e';
const AMOUNT = 500_000;
const FUND_TXID = 'aa'.repeat(32);

// ── 릴레이 흉내 — NIP-40 만료 거절 · 발행 실패 ────────────────

const relay = { failNext: 0, rejectedExpired: 0 };
const published: Array<{ tags: string[][]; content: string }> = [];

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
    publish(relays: string[], event: { tags: string[][]; content: string }) {
      if (relay.failNext > 0) {
        relay.failNext -= 1;
        return relays.map(() => Promise.reject(new Error('relay down')));
      }
      // NIP-40: 이미 지난 expiration을 가진 이벤트는 거절한다 (라이트닝에서 실측한 동작)
      const exp = Number(event.tags.find(t => t[0] === 'expiration')?.[1] ?? 0);
      if (exp > 0 && exp < Math.floor(Date.now() / 1000)) {
        relay.rejectedExpired += 1;
        return relays.map(() => Promise.reject(new Error('invalid: event is expired')));
      }
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
vi.mock('../onchain/key-store', () => ({
  createOrderKeyWithBackup: vi.fn(async () => ({ privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) })),
  getOrderKey: vi.fn(async () => ({ privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) })),
}));
vi.mock('../web-push/send', () => ({ sendPush: vi.fn(async () => {}) }));
// 프리이미지 저장소 흉내 — 몰수에 필요하다
vi.mock('../escrow-store', () => ({
  getPreimage: (key: string) => `preimage:${key}`,
}));

const svc = await import('../onchain/service');
const store = await import('../onchain/order-store');
const deposits = await import('../onchain/pending-deposit-store');
const meta = await import('../onchain/escrow-meta-store');
const alerts = await import('../onchain/alert-store');
const requestLog = await import('../onchain/sign-request-log');
const { tickOnchainOrder, _resetWatcherForTesting } = await import('../onchain/watcher');
const { handleOnchainOutcome } = await import('../onchain/deposit-lifecycle');

const DESCRIPTOR = deriveEscrowAddress({
  keys: { customer: XC, sponsor: XS, admin: XA }, network: 'signet',
});
const PAYOUT = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'signet');
/** 고객이 의뢰 때 낸 환불 주소 */
const REFUND = deriveSingleKeyAddress(xonlyFromPrivkey(SK_R), 'signet');

// ── 가짜 체인 — 소모된 UTXO는 목록에서 빠진다 (esplora `/utxo`처럼) ──

class FakeChain {
  funded = false;
  confirmations = 0;
  /** 에스크로를 쓴 tx (멤풀이든 블록이든) */
  spender: ReturnType<typeof fromRawHex> | null = null;
  spenderConfs = 0;
  broadcasted: string[] = [];

  async getAddressFunds(): Promise<ChainQuery<AddressFunds>> {
    if (!this.funded || this.spender) return { known: true, value: { confirmed: [], mempool: [] } };
    return {
      known: true,
      value: {
        confirmed: [{ txid: FUND_TXID, vout: 0, valueSat: AMOUNT, confirmations: this.confirmations }],
        mempool: [],
      },
    };
  }
  async getTxStatus(txid: string): Promise<ChainQuery<TxStatus>> {
    if (txid === FUND_TXID) {
      return { known: true, value: { seen: this.funded, confirmed: this.funded, confirmations: this.confirmations } };
    }
    if (this.spender && this.spender.id === txid) {
      return {
        known: true,
        value: { seen: true, confirmed: this.spenderConfs > 0, confirmations: this.spenderConfs, blockHeight: 1 },
      };
    }
    return { known: true, value: { seen: false, confirmed: false, confirmations: 0 } };
  }
  async getSpend(): Promise<ChainQuery<SpendInfo>> {
    if (!this.spender) return { known: true, value: { spent: false } };
    const witness = this.spender.getInput(0).finalScriptWitness?.map(w => bytesToHex(w)) ?? null;
    return { known: true, value: { spent: true, txid: this.spender.id, confirmed: this.spenderConfs > 0, witness } };
  }
  async getFeeEstimates() {
    return { known: true as const, value: { fastest: 4, halfHour: 2, hour: 1, economy: 1, minimum: 1 } };
  }
  async getTipHeight() { return { known: true as const, value: 100 }; }
  async broadcastTx(hex: string) {
    this.broadcasted.push(hex);
    this.spender = fromRawHex(hex);
    return { known: true as const, value: this.spender.id };
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
    for (const [, inv] of this.invoices) {
      if (preimage === `preimage:${inv.id}`) inv.status = 'settled';
    }
    this.actions.push(`settle:${preimage}`);
  }
  /** 유저가 결제했다 */
  pay(idPart: string) {
    for (const [, inv] of this.invoices) {
      if (inv.id.includes(idPart) && inv.status === 'open') inv.status = 'accepted';
    }
  }
}

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
      decideSettlement: svc.decideOnchainSettlement,
      requestSignature: svc.requestSettlementSignature,
      lastSignatureRequestAt: requestLog.lastSignatureRequestAt,
      outboxTxid: svc.outboxTxidFor,
      flushOutbox: svc.flushOnchainOutbox,
      rebroadcast: svc.rebroadcastSettlement,
      onOutcome: (o, outcome) => { settled.push(handleOnchainOutcome(o, outcome, ln as never)); },
      raise: (o, level, why) => alerts.raiseOnchainAlert(o, level, why),
      raiseRescue: (o, utxos) => alerts.setOnchainRescueAlert(o, utxos),
      notifyDisputeSoon: () => {},
      listOrders: svc.listOnchainOrders,
      getOrder: store.getOnchainOrder,
      checkDeposits: svc.checkOnchainDeposits,
    });
  }
  await Promise.all(settled);
}

const state = () => store.getOnchainOrder(ORDER)?.state;

/** 의뢰 등록 → 보증금 결제 → `listed` */
async function openOrder(listingSec = 3 * 86_400): Promise<void> {
  await svc.handleOnchainOrderRequest(req({
    orderId: ORDER, pubkey: CUST, action: 'onchain-order-request' as const,
    amountSat: AMOUNT, customerXonly: XC, expiration: clock + listingSec,
  }, `enc:${JSON.stringify({ refundAddress: REFUND })}`) as never);
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

function presigPsbt(): string {
  const tx = buildSettlementTx({
    descriptor: DESCRIPTOR,
    input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: AMOUNT },
    path: 'release', destination: PAYOUT, feeSat: store.getOnchainOrder(ORDER)!.releaseFeeSat!,
  });
  signSettlement(tx, SK_S);
  return toPsbtBase64(tx);
}

/** 후원자 사전서명 */
async function presign(): Promise<void> {
  await svc.handleOnchainPresig(req(
    { orderId: ORDER, pubkey: SPON, action: 'onchain-presig' as const },
    `enc:${JSON.stringify({ psbt: presigPsbt() })}`,
  ) as never);
}

/** 가장 최근 서명 요청 (어드민 → 유저) */
function lastSignRequest(): { purpose: string; psbt: string } {
  const e = [...published].reverse().find(ev => ev.tags.some(t => t[0] === 'action' && t[1] === 'onchain-cosign'))!;
  return {
    purpose: e.tags.find(t => t[0] === 'purpose')![1]!,
    psbt: (JSON.parse(e.content.slice(4)) as { psbt: string }).psbt,
  };
}

/** 유저가 서명 요청에 서명해 돌려보낸다 */
async function cosign(pubkey: string, key: Uint8Array, purpose: 'release' | 'refund' | 'dispute-sponsor' | 'dispute-customer'): Promise<void> {
  const tx = fromPsbtBase64(lastSignRequest().psbt);
  signSettlement(tx, key);
  await svc.handleOnchainCosign(req(
    { orderId: ORDER, pubkey, action: 'onchain-cosign' as const, purpose },
    `enc:${JSON.stringify({ psbt: toPsbtBase64(tx) })}`,
  ) as never);
}

/** 종결 tx 컨펌 */
async function confirmSettlement(): Promise<void> {
  chain.spenderConfs = 2;
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_700_000_000;
  vi.setSystemTime(clock * 1000);
  store._resetForTesting();
  deposits._resetForTesting();
  meta._resetForTesting();
  alerts._resetForTesting();
  requestLog._resetForTesting();
  _resetWatcherForTesting();
  published.length = 0;
  relay.failNext = 0;
  relay.rejectedExpired = 0;
  chain = new FakeChain();
  ln = new FakeLn();
  svc.configureOnchainService({
    lnAdapter: ln as never, chain: chain as never, network: 'signet', btcPriceKrw: () => 100_000_000,
  });
});

afterEach(() => vi.useRealTimers());

// ─── ① 정상 완료 ─────────────────────────────────────────────

describe('① 정상 완료', () => {
  it('등록 → 클레임 → 펀딩 → 사전서명 → 계좌 → 송금 → 릴리스', async () => {
    await openOrder();
    expect(state()).toBe('listed');

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
    expect(state()).toBe('presigned');
    expect(lastSignRequest().purpose).toBe('release');

    // 고객이 계좌를 공개하면 **거기서부터** 후원자 30분이 시작된다 (O-013)
    await svc.noteAccountInfoSent(ORDER, CUST);
    const presigned = store.getOnchainOrder(ORDER)!;
    expect(presigned.krwDeadline).toBe(presigned.accountSentAt! + 30 * 60);

    advance(600);
    await svc.handleOnchainRemit({ orderId: ORDER, pubkey: SPON });
    expect(state()).toBe('remitted');

    // 고객이 입금을 확인하고 서명한다 — **여기가 유일한 릴리스 트리거**다 (O-007)
    await cosign(CUST, SK_C, 'release');
    const settling = store.getOnchainOrder(ORDER)!;
    expect(settling.state).toBe('settling');
    expect(chain.broadcasted).toHaveLength(1);
    expect(settling.settlementTxid).toBe(chain.spender!.id);

    // 우리 tx가 에스크로를 썼다 — 리오그로 읽지 않고 컨펌을 기다린다
    await tick();
    expect(state()).toBe('settling');

    await confirmSettlement();
    expect(state()).toBe('released');
    expect(outputAddressOf(chain.spender!, DESCRIPTOR)).toBe(PAYOUT);

    // 양쪽 보증금이 **환불**된다 (몰수 없음)
    expect(ln.actions.filter(a => a.startsWith('settle:'))).toHaveLength(0);
    expect(ln.actions.filter(a => a.startsWith('cancel:'))).toHaveLength(2);
  });
});

// ─── ② 후원자 이탈 ───────────────────────────────────────────

describe('② 후원자 이탈 (사전서명 마감 초과)', () => {
  it('환불이 결정되고, 몰수는 그때 집행되고, 고객이 서명하면 환불 주소로 간다', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();

    advance(PRESIGN_WINDOW_SEC + 1);
    await tick();

    const refunding = store.getOnchainOrder(ORDER)!;
    expect(refunding.state).toBe('refunding');
    expect(refunding.settlementKind).toBe('refund:sponsor-timeout');
    // **결정 시점에** 후원자 보증금 몰수 (리뷰 #8 — 서명을 기다리지 않는다)
    expect(ln.actions).toContain(`settle:preimage:onchain:${ORDER}:${SPON}`);

    // 고객에게 간 PSBT는 **서명 없는** 것이고, 받는 곳은 고객이 낸 환불 주소다
    const sent = lastSignRequest();
    expect(sent.purpose).toBe('refund');
    expect(fromPsbtBase64(sent.psbt).getInput(0).tapScriptSig ?? []).toHaveLength(0);
    expect(outputAddressOf(fromPsbtBase64(sent.psbt), DESCRIPTOR)).toBe(REFUND);

    // 다음 틱에 **다시 결정하지 않는다**
    await tick();
    expect(store.getOnchainOrder(ORDER)!.decidedAt).toBe(refunding.decidedAt);

    await cosign(CUST, SK_C, 'refund');
    expect(state()).toBe('settling');

    await confirmSettlement();
    expect(state()).toBe('refunded');
    expect(outputAddressOf(chain.spender!, DESCRIPTOR)).toBe(REFUND);
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
    await svc.noteAccountInfoSent(ORDER, CUST);
    await svc.handleOnchainRemit({ orderId: ORDER, pubkey: SPON });

    // 고객이 24시간 동안 아무것도 안 한다 → **동의를 묻지 않고** 분쟁으로 (O-010)
    advance(COSIGN_WINDOW_SEC + 1);
    await tick();
    expect(state()).toBe('disputed');

    // 어드민이 판정한다 — 유일하게 사람이 하는 자리. 몰수는 **지금** 집행된다
    await svc.decideOnchainSettlement(store.getOnchainOrder(ORDER)!, 'sponsor_win');
    expect(ln.actions).toContain(`settle:preimage:onchain:${ORDER}`);
    expect(lastSignRequest().purpose).toBe('dispute-sponsor');

    await cosign(SPON, SK_S, 'dispute-sponsor');
    expect(state()).toBe('settling');
    await confirmSettlement();
    expect(state()).toBe('sponsor_wins');
    expect(outputAddressOf(chain.spender!, DESCRIPTOR)).toBe(PAYOUT);
  });
});

// ─── ④ 고객 미펀딩 ───────────────────────────────────────────

describe('④ 고객이 마감까지 펀딩을 컨펌 못 시킴', () => {
  it('취소되고 고객 보증금이 몰수된다', async () => {
    await openOrder();
    await claimOrder();

    advance(FUNDING_WINDOW_SEC + 1);
    await tick();

    expect(state()).toBe('cancelled');
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

    expect(state()).toBe('bonded');
  });
});

// ─── 리뷰 #8 ─────────────────────────────────────────────────

describe('리뷰 #8 R1 — 환불이 결정되면 거래는 앞으로 가지 않는다', () => {
  it('늦은 사전서명·계좌·송금 주장이 전부 거절되고, 고객은 환불로만 나간다', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();
    advance(PRESIGN_WINDOW_SEC + 1);
    await tick();
    expect(state()).toBe('refunding');

    // 후원자 앱이 5분 늦게 깨어나 사전서명 — 받지 않는다
    advance(300);
    await presign();
    expect(state()).toBe('refunding');

    // 고객이 계좌를 보내고 후원자가 송금을 주장해도 — 받지 않는다
    await svc.noteAccountInfoSent(ORDER, CUST);
    await svc.handleOnchainRemit({ orderId: ORDER, pubkey: SPON });
    expect(state()).toBe('refunding');
    expect(store.getOnchainOrder(ORDER)!.accountSentAt).toBeUndefined();

    // 고객이 쥔 것은 **서명 없는** PSBT뿐 — 혼자서는 아무 tx도 완성할 수 없다
    expect(fromPsbtBase64(lastSignRequest().psbt).getInput(0).tapScriptSig ?? []).toHaveLength(0);
  });

  it('계좌 공개 마감이 지나면 늦은 계좌는 받지 않고 고객 몰수로 접는다', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();
    await presign();
    advance(ACCOUNT_WINDOW_SEC + 1);

    await svc.noteAccountInfoSent(ORDER, CUST); // 늦었다
    expect(store.getOnchainOrder(ORDER)!.accountSentAt).toBeUndefined();

    await tick();
    expect(store.getOnchainOrder(ORDER)!.settlementKind).toBe('refund:customer-late');
    expect(ln.actions).toContain(`settle:preimage:onchain:${ORDER}`); // 고객 몰수 — 결정 시점
  });
});

describe('리뷰 #8 R2 — 의뢰 만료를 넘긴 거래도 끝까지 간다 (NIP-40)', () => {
  /**
   * 1시간짜리 의뢰가 50분에 클레임되고 70분에 컨펌됐다. 전에는 진행 중 상태에도
   * 의뢰 만료(60분)를 이벤트 만료로 실어서 `funded`부터 릴레이가 전부 거절했다.
   */
  it('막바지 클레임 → 의뢰 만료 뒤 펀딩 → 릴리스까지', async () => {
    await openOrder(3600);
    advance(3000);
    await claimOrder();
    expect(state()).toBe('bonded');

    advance(1200); // 의뢰 만료는 지났다
    await fundOrder();
    expect(state()).toBe('funded');

    await presign();
    await svc.noteAccountInfoSent(ORDER, CUST);
    await svc.handleOnchainRemit({ orderId: ORDER, pubkey: SPON });
    await cosign(CUST, SK_C, 'release');
    await confirmSettlement();

    expect(state()).toBe('released');
    expect(relay.rejectedExpired).toBe(0);
  });
});

describe('리뷰 #8 R3 — 브로드캐스트 전 발행이 실패해도 엉뚱한 쪽이 몰수되지 않는다', () => {
  /**
   * 전에는: 브로드캐스트 성공 → settling 발행 실패 → 롤백 + 대기 기록 삭제 →
   * 다음 틱에 "UTXO가 없다"를 리오그로 읽고 bonded로 → 6시간 뒤 **고객 몰수 ·
   * 후원자 환불**. 후원자가 버린 거래인데 정반대로 처리됐다.
   */
  it('발행이 실패하면 뿌리지 않고, 워처가 outbox로 마무리한 뒤 사유대로 끝난다', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();
    advance(PRESIGN_WINDOW_SEC + 1);
    await tick(); // refund:sponsor-timeout 결정

    relay.failNext = 1;                 // settling 발행만 실패
    await cosign(CUST, SK_C, 'refund');
    expect(chain.broadcasted).toHaveLength(0);
    expect(state()).toBe('refunding');

    await tick();                       // 워처가 outbox를 마무리한다
    expect(state()).toBe('settling');
    expect(chain.broadcasted).toHaveLength(1);

    await tick();                       // 우리 tx가 에스크로를 썼다 — 리오그가 아니다
    expect(state()).toBe('settling');

    await confirmSettlement();
    expect(state()).toBe('refunded');
    // 후원자 몰수 · 고객 환불 — 사유 그대로
    expect(ln.actions).toContain(`settle:preimage:onchain:${ORDER}:${SPON}`);
    expect(ln.actions).not.toContain(`settle:preimage:onchain:${ORDER}`);
  });

  /** O-005 — 멤풀에서 쫓겨난 종결 tx는 같은 바이트로 다시 뿌린다 */
  it('종결 tx가 멤풀에서 사라지면 다시 뿌린다', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();
    await presign();
    await svc.noteAccountInfoSent(ORDER, CUST);
    await svc.handleOnchainRemit({ orderId: ORDER, pubkey: SPON });
    await cosign(CUST, SK_C, 'release');
    const first = chain.broadcasted[0]!;

    chain.spender = null;               // 쫓겨났다
    await tick();
    expect(chain.broadcasted).toEqual([first, first]);
  });
});

describe('리뷰 #8 — 타임락 회수를 관측한다 (O-006)', () => {
  it('어드민이 사라진 사이 고객이 타임락으로 뺐으면 swept으로 적는다', async () => {
    await openOrder();
    await claimOrder();
    await fundOrder();
    await presign();

    const tx = buildSettlementTx({
      descriptor: DESCRIPTOR, input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'timelock', destination: REFUND, feeSat: 300,
    });
    signSettlement(tx, SK_C);
    finalizeSettlement(tx, 'timelock');
    chain.spender = tx;
    chain.spenderConfs = 1;

    await tick();
    expect(state()).toBe('swept');
  });
});

describe('리뷰 #8 — 취소된 주문 주소에 늦게 들어온 자금', () => {
  it('구조 경보를 띄운다 (전에는 아무도 안 봤다)', async () => {
    await openOrder();
    await claimOrder();
    advance(FUNDING_WINDOW_SEC + 1);
    await tick();
    expect(state()).toBe('cancelled');

    // 취소 직후 컨펌됐다
    chain.funded = true;
    chain.confirmations = 1;
    await tick();
    expect(alerts.getOnchainRescueAlertsSnapshot()[ORDER]?.utxos).toEqual([
      { txid: FUND_TXID, vout: 0, valueSat: AMOUNT },
    ]);
  });
});
