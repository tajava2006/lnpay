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
  fromPsbtBase64, outputAddressOf,
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

const published: Array<{ kind?: number; tags: string[][]; content: string }> = [];
/** 이 횟수만큼 다음 발행을 실패시킨다 (릴레이가 전부 죽은 상황) */
let failPublishes = 0;
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish(relays: string[], event: { tags: string[][]; content: string }) {
      if (failPublishes > 0) {
        failPublishes -= 1;
        return relays.map(() => Promise.reject(new Error('relay down')));
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

/** 어드민 키는 결정론적이어야 테스트가 주소를 미리 안다 */
let keyBackupOk = true;
vi.mock('../onchain/key-store', () => ({
  createOrderKeyWithBackup: vi.fn(async () => {
    if (!keyBackupOk) throw new Error('백업 발행 실패');
    return { privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) };
  }),
  getOrderKey: vi.fn(async () => ({ privkey: sk(80), xonly: xonlyFromPrivkey(sk(80)) })),
}));

// 몰수에 필요한 프리이미지 — 실제 저장소는 escrow 백업 경로라 여기서는 흉내만 낸다
vi.mock('../escrow-store', () => ({ getPreimage: (key: string) => `preimage:${key}` }));

const svc = await import('../onchain/service');
const store = await import('../onchain/order-store');
const deposits = await import('../onchain/pending-deposit-store');
const meta = await import('../onchain/escrow-meta-store');
const requestLog = await import('../onchain/sign-request-log');
const rescueStore = await import('../onchain/rescue-store');

const XA = xonlyFromPrivkey(SK_A);
const DESCRIPTOR = deriveEscrowAddress({
  keys: { customer: XC, sponsor: XS, admin: XA }, network: 'signet',
});
const PAYOUT = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'signet');
/** 고객이 의뢰 때 낸 환불 주소 (리뷰 #8) */
const REFUND = deriveSingleKeyAddress(xonlyFromPrivkey(sk(150)), 'signet');
const nowSec = () => Math.floor(Date.now() / 1000);

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
  getSpend: vi.fn(),
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

/** 사전서명된 릴리스 PSBT — `presigned`에서 어드민이 보관하는 그것 */
function sponsorPresig(o: OnchainOrder = fundedOrder()): string {
  const tx = buildSettlementTx({
    descriptor: DESCRIPTOR,
    input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
    path: 'release', destination: PAYOUT, feeSat: o.releaseFeeSat!,
  });
  signSettlement(tx, SK_S);
  return toPsbtBase64(tx);
}

function lastSignRequest(): { purpose: string; psbt: string } | undefined {
  const e = [...published].reverse().find(ev => ev.tags.some(t => t[0] === 'action' && t[1] === 'onchain-cosign'));
  if (!e) return undefined;
  return {
    purpose: e.tags.find(t => t[0] === 'purpose')![1]!,
    psbt: (JSON.parse(e.content.slice(4)) as { psbt: string }).psbt,
  };
}

function rejections(): string[] {
  return published
    .filter(e => e.tags.some(t => t[0] === 'action' && t[1] === 'onchain-rejected'))
    .map(e => e.tags.find(t => t[0] === 'reason')![1]!);
}

let price: number | undefined = 100_000_000;

beforeEach(() => {
  store._resetForTesting();
  deposits._resetForTesting();
  meta._resetForTesting();
  requestLog._resetForTesting();
  rescueStore._resetForTesting();
  published.length = 0;
  failPublishes = 0;
  price = 100_000_000;
  keyBackupOk = true;
  vi.clearAllMocks();
  ln.lookupHoldInvoice.mockResolvedValue('open');
  chain.getFeeEstimates.mockResolvedValue({
    known: true, value: { fastest: 4, halfHour: 2, hour: 1, economy: 1, minimum: 1 },
  });
  chain.broadcastTx.mockResolvedValue({ known: true, value: TXID });
  svc.configureOnchainService({
    lnAdapter: ln as never, chain: chain as never, network: 'signet', btcPriceKrw: () => price,
  });
});

// ── ① 의뢰 등록 ─────────────────────────────────────────────

describe('의뢰 등록', () => {
  const orderReq = (
    over: Partial<{ amountSat: number; expiration: number; reserveKrw: number }> = {},
    content = `enc:${JSON.stringify({ refundAddress: REFUND })}`,
  ) => req({
    orderId: 'o-1', pubkey: CUST, action: 'onchain-order-request' as const,
    amountSat: AMOUNT, customerXonly: XC,
    ...over,
  }, content);

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

  /**
   * 리뷰 #8 — 환불 주소를 **받아둔다.** 전에는 환불이 이 앱만 쓸 수 있는 주소로 갔고
   * 꺼낼 화면이 없었다. 주소는 공개 이벤트에 싣지 않고 대기 기록(→ 백업되는 메타)에만 둔다.
   */
  it('환불 주소를 받아 대기 기록에 둔다', async () => {
    await svc.handleOnchainOrderRequest({ ...orderReq(), expiration: nowSec() + 86_400 } as never);
    expect(deposits.getOnchainDepositsFor('o-1')[0]!.refundAddress).toBe(REFUND);
  });

  it('환불 주소가 없으면 거절을 알린다', async () => {
    await svc.handleOnchainOrderRequest({ ...orderReq({}, ''), expiration: nowSec() + 86_400 } as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
    expect(rejections()[0]).toMatch(/환불 받을 주소/);
  });

  it('다른 네트워크의 환불 주소는 거절한다', async () => {
    const mainnet = deriveSingleKeyAddress(XC, 'mainnet');
    await svc.handleOnchainOrderRequest({
      ...orderReq({}, `enc:${JSON.stringify({ refundAddress: mainnet })}`), expiration: nowSec() + 86_400,
    } as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
  });

  /** 리뷰 #8 — 시세에 붙은 최저가는 컨펌 대기 중의 공짜 풋옵션이다 */
  it('최저가가 시세에 붙어 있으면 거절한다', async () => {
    await svc.handleOnchainOrderRequest({
      ...orderReq({ reserveKrw: 499_000 }), expiration: nowSec() + 86_400,
    } as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
    expect(rejections()[0]).toMatch(/3%/);
  });

  it('시세를 모르면 최저가 의뢰를 받지 않는다 (최저가 없으면 받는다)', async () => {
    price = undefined;
    await svc.handleOnchainOrderRequest({
      ...orderReq({ reserveKrw: 300_000 }), expiration: nowSec() + 86_400,
    } as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
    await svc.handleOnchainOrderRequest({ ...orderReq(), expiration: nowSec() + 86_400 } as never);
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

  /** 여러 명이 동시에 시도해도 된다 — **결제가 먼저 확인된 쪽**이 가져간다(§4.1b). */
  it('여러 후원자가 동시에 인보이스를 받을 수 있다', async () => {
    await svc.handleOnchainClaim(claim('sponsor-a') as never);
    await svc.handleOnchainClaim(claim('sponsor-b') as never);
    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(2);
  });

  it('같은 후원자가 두 번 눌러도 인보이스는 하나다', async () => {
    await svc.handleOnchainClaim(claim('sponsor-a') as never);
    await svc.handleOnchainClaim(claim('sponsor-a') as never);
    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(1);
  });

  /**
   * 키가 공짜라 중복 방지(`orderId:sponsorPubkey`)를 시빌로 우회할 수 있다.
   * 돈이 걸린 문제는 아니고(미결제 홀드 인보이스는 아무것도 안 묶는다) 어드민
   * 노드와 릴레이를 태우는 위생 문제라 **상한 하나**로 끝낸다.
   */
  it('대기 인보이스가 상한에 닿으면 더 내주지 않고 거절을 알린다', async () => {
    for (let i = 0; i < 5; i += 1) {
      await svc.handleOnchainClaim(claim(`sybil-${i}`) as never);
    }
    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(5);

    published.length = 0;
    await svc.handleOnchainClaim(claim('sybil-5') as never);

    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(5);
    // **조용히 버리지 않는다** — 유저 쪽에 흔적이 남아야 한다.
    const rejected = published.find(e =>
      e.tags.some(([k, v]) => k === 'action' && v === 'onchain-rejected'));
    expect(rejected).toBeTruthy();
  });

  /**
   * 리뷰 #8 R6 — feerate 상한이 없어서, 터무니없는 값으로 클레임하면 가격을 고정할 수
   * 없어 주문이 `bonded`에 영원히 묶였다. 고객 BTC가 후원자 보증금이 만료될 때까지
   * 갇히고, 후원자는 잃는 게 없었다 — 공짜 그리핑.
   */
  it('터무니없는 feerate는 거절한다 — 인보이스를 내주지 않는다', async () => {
    await svc.handleOnchainClaim(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-claim' as const, sponsorXonly: XS },
      `enc:${JSON.stringify({ payoutAddress: PAYOUT, feerateSatPerVb: 1_000_000 })}`,
    ) as never);
    expect(ln.createHoldInvoice).not.toHaveBeenCalled();
    expect(rejections()[0]).toMatch(/수수료/);
  });

  /** 리뷰 #8 — 클레임의 실패 경로가 전부 콘솔에만 남았다. 이제 유저에게 간다. */
  it('다른 네트워크 주소도 거절을 알린다', async () => {
    const mainnetAddr = deriveSingleKeyAddress(xonlyFromPrivkey(SK_D), 'mainnet');
    await svc.handleOnchainClaim(
      req({ orderId: 'o-1', pubkey: SPON, action: 'onchain-claim' as const, sponsorXonly: XS },
        `enc:${JSON.stringify({ payoutAddress: mainnetAddr, feerateSatPerVb: 2 })}`) as never,
    );
    expect(rejections()).toHaveLength(1);
  });

  /** 한 자리가 비면 다시 받는다 — 상한은 영구 차단이 아니다. */
  it('결제 실패로 자리가 비면 다시 받는다', async () => {
    for (let i = 0; i < 5; i += 1) {
      await svc.handleOnchainClaim(claim(`sybil-${i}`) as never);
    }
    deposits.deleteOnchainDeposit('o-1:sybil-0');

    await svc.handleOnchainClaim(claim('late-comer') as never);
    expect(deposits.getOnchainDepositsFor('o-1').map(d => d.sponsorPubkey))
      .toContain('late-comer');
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

    /**
     * 리뷰 #8 R4 — 백업 복원이 이미 처리해 지운 **이긴 쪽의 대기 기록**을 되살리면,
     * 전에는 "먼저 결제한 쪽이 이미 가져갔다"로 보고 **살아 있는 보증금을 취소**했다.
     * 후원자가 아무것도 안 건 채 거래를 계속하게 된다.
     */
    it('되살아난 이긴 쪽의 대기 기록은 보증금을 건드리지 않고 치운다', async () => {
      await svc.checkOnchainDeposits();
      const bonded = store.getOnchainOrder('o-1')!;
      ln.cancelInvoice.mockClear();

      deposits.mergeOnchainDeposits([{
        orderId: 'o-1', type: 'sponsor', sponsorPubkey: bonded.sponsorPubkey!, customerPubkey: CUST,
        depositPaymentHash: bonded.sponsorDepositHash!, depositBolt11: 'lnbc', amountSat: 15_000,
        createdAt: 1, sponsorXonly: XS, payoutAddress: PAYOUT, feerateSatPerVb: 2,
      }]);
      await svc.checkOnchainDeposits();

      expect(ln.cancelInvoice).not.toHaveBeenCalled();
      expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(0);
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

  /**
   * 리뷰 #8 R1 — 사전서명 마감이 지나 환불이 결정될 자리인데, 전에는 워처 틱 사이에
   * 들어온 늦은 사전서명을 받아 `presigned`로 굴려버렸다. 핸들러가 마감을 직접 본다.
   */
  it('마감(T0+15분)이 지난 사전서명은 받지 않고 이유를 알린다', async () => {
    store.upsertOnchainOrder(fundedOrder({ fundedAt: nowSec() - 16 * 60, updatedAt: 99 }));
    await svc.handleOnchainPresig(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-presig' as const },
      `enc:${JSON.stringify({ psbt: presigPsbt() })}`,
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('funded');
    expect(rejections()[0]).toMatch(/마감/);
  });

  it('환불이 결정된 주문(refunding)에는 사전서명을 받지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'refunding', settlementKind: 'refund:sponsor-timeout', settlementFeeSat: 400, updatedAt: 99,
    }));
    await svc.handleOnchainPresig(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-presig' as const },
      `enc:${JSON.stringify({ psbt: presigPsbt() })}`,
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('refunding');
  });

  it('검증에 실패하면 이유를 후원자에게 알린다', async () => {
    await svc.handleOnchainPresig(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-presig' as const },
      `enc:${JSON.stringify({ psbt: presigPsbt({ feeSat: 100 }) })}`,
    ) as never);
    expect(rejections()[0]).toMatch(/사전서명이 맞지 않습니다/);
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
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2, presigPsbt: sponsorPresig() });
  });

  it('고객 서명이 붙으면 브로드캐스트하고 settling으로 간다', async () => {
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: releaseReady() })}`,
    ) as never);

    expect(chain.broadcastTx).toHaveBeenCalledTimes(1);
    const after = store.getOnchainOrder('o-1')!;
    expect(after.state).toBe('settling');
    // 브로드캐스트 **전에** 우리가 만든 tx의 txid를 박는다 (outbox)
    expect(after.settlementTxid).toBe(fromPsbtBase64(releaseReady()).id);
    expect(after.settlementKind).toBe('release');
    expect(after.settlingAt).toBeGreaterThan(0);
  });

  /**
   * 리뷰 #8 — **발행이 먼저, 브로드캐스트가 나중.** 브로드캐스트가 실패해도 이미
   * `settling`이고, raw tx가 outbox에 남아 워처가 같은 tx를 다시 뿌린다(O-005).
   */
  it('브로드캐스트가 실패해도 settling이고, 다시 뿌릴 원본이 남는다', async () => {
    chain.broadcastTx.mockResolvedValue({ known: false, reason: 'min relay fee not met' });
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: releaseReady() })}`,
    ) as never);
    const after = store.getOnchainOrder('o-1')!;
    expect(after.state).toBe('settling');
    expect(svc.outboxTxidFor('o-1')).toBe(after.settlementTxid);

    chain.broadcastTx.mockResolvedValue({ known: true, value: after.settlementTxid! });
    await svc.rebroadcastSettlement(after);
    expect(chain.broadcastTx).toHaveBeenCalledTimes(2);
    expect(chain.broadcastTx.mock.calls[1]).toEqual(chain.broadcastTx.mock.calls[0]); // 같은 바이트
  });

  /**
   * 리뷰 #8 R3 — 전에는 브로드캐스트한 뒤 발행했다. 발행이 실패하면 체인엔 tx가 떠
   * 있고 장부엔 없어서, 워처가 그걸 리오그로 읽고 `bonded`로 되돌려 **엉뚱한 쪽이
   * 몰수**됐다. 이제 발행이 실패하면 **뿌리지 않는다** — outbox가 남아 나중에 마무리된다.
   */
  it('settling 발행이 실패하면 브로드캐스트하지 않고, outbox로 나중에 마무리한다', async () => {
    failPublishes = 1;
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: releaseReady() })}`,
    ) as never);
    expect(chain.broadcastTx).not.toHaveBeenCalled();
    expect(store.getOnchainOrder('o-1')!.state).toBe('remitted');
    expect(svc.outboxTxidFor('o-1')).toBeDefined();

    await svc.flushOnchainOutbox(store.getOnchainOrder('o-1')!);
    expect(store.getOnchainOrder('o-1')!.state).toBe('settling');
    expect(chain.broadcastTx).toHaveBeenCalledTimes(1);
  });

  /** 고객 PSBT 안의 후원자 서명을 믿지 않는다 — 우리가 검증해 보관한 사전서명을 쓴다 */
  it('보관한 사전서명이 없으면 완성하지 않는다', async () => {
    meta._resetForTesting();
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2 });
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'release' as const },
      `enc:${JSON.stringify({ psbt: releaseReady() })}`,
    ) as never);
    expect(chain.broadcastTx).not.toHaveBeenCalled();
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

// ── ⑤b 환불 — 어드민은 마지막에 서명한다 (리뷰 #8 R1) ────────

describe('환불 서명 — 어드민이 마지막', () => {
  beforeEach(() => {
    store.upsertOnchainOrder(fundedOrder({ fundedAt: nowSec() - 20 * 60 }));
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2, refundAddress: REFUND });
  });

  it('결정하면 refunding으로 가고, 고객에게 **서명 없는** PSBT를 보낸다', async () => {
    const updated = await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:sponsor-timeout');
    expect(updated?.state).toBe('refunding');
    const sent = lastSignRequest()!;
    expect(sent.purpose).toBe('refund');
    const tx = fromPsbtBase64(sent.psbt);
    expect(tx.getInput(0).tapScriptSig ?? []).toHaveLength(0);
    // 받는 곳은 고객이 낸 환불 주소
    expect(outputAddressOf(tx, DESCRIPTOR)).toBe(REFUND);
  });

  it('고객 서명을 받으면 어드민이 서명해 브로드캐스트한다', async () => {
    await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:sponsor-timeout');
    const tx = fromPsbtBase64(lastSignRequest()!.psbt);
    signSettlement(tx, SK_C);

    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'refund' as const },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(tx) })}`,
    ) as never);
    expect(chain.broadcastTx).toHaveBeenCalledTimes(1);
    expect(store.getOnchainOrder('o-1')!.state).toBe('settling');
    expect(store.getOnchainOrder('o-1')!.settlementKind).toBe('refund:sponsor-timeout');
  });

  /**
   * R1 — 거래가 remitted로 굴러간 뒤에 들어온 환불 서명을 받아 브로드캐스트하면
   * 고객이 원화와 BTC를 다 가진다. 핸들러가 FSM으로 막는다.
   */
  it('remitted에서는 환불 서명을 받지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'remitted', remittedAt: 1, settlementKind: 'refund:sponsor-timeout', settlementFeeSat: 400, updatedAt: 99,
    }));
    const tx = buildSettlementTx({
      descriptor: DESCRIPTOR, input: { outpoint: { txid: TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'refund', destination: REFUND, feeSat: 400,
    });
    signSettlement(tx, SK_C);
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'refund' as const },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(tx) })}`,
    ) as never);
    expect(chain.broadcastTx).not.toHaveBeenCalled();
  });

  /**
   * R5 — 몰수는 **결정 시점**에 집행된다. 전에는 종결 tx 컨펌 때라서, 몰수당할 고객이
   * 환불 서명을 HTLC 만료까지 미루면 몰수가 사라졌다.
   */
  it('customer-late를 결정하는 순간 고객 보증금을 몰수한다 (서명을 기다리지 않는다)', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'presigned', presignedAt: nowSec() - 20 * 60, customerDepositHash: 'hc', sponsorDepositHash: 'hs', updatedAt: 99,
    }));
    meta.mergeEscrowMeta('o-1', { customerDepositKey: 'onchain:o-1', sponsorDepositKey: 'onchain:o-1:s' });
    ln.lookupHoldInvoice.mockResolvedValue('accepted');

    await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:customer-late');
    expect(ln.settleInvoice).toHaveBeenCalledTimes(1);   // 고객 몰수
    expect(ln.cancelInvoice).toHaveBeenCalledTimes(1);   // 후원자 환불
  });

  it('결정은 한 번뿐이다 — 두 번째 결정은 무시된다', async () => {
    const o = store.getOnchainOrder('o-1')!;
    await svc.decideOnchainSettlement(o, 'refund:sponsor-timeout');
    const again = await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:customer-late');
    expect(again).toBeNull();
    expect(store.getOnchainOrder('o-1')!.settlementKind).toBe('refund:sponsor-timeout');
  });

  it('옛 주문(환불 주소 없음)은 주문별 키 단일키 주소로 간다', async () => {
    meta._resetForTesting();
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2 });
    await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:sponsor-timeout');
    expect(outputAddressOf(fromPsbtBase64(lastSignRequest()!.psbt), DESCRIPTOR))
      .toBe(deriveSingleKeyAddress(XC, 'signet'));
  });
});

// ── ⑥ 분쟁 ──────────────────────────────────────────────────

describe('분쟁', () => {
  it('remitted에서는 분쟁이 열리고 진입 시각이 박힌다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'remitted', remittedAt: 1 }));
    await svc.handleOnchainDispute(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-dispute' as const },
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('disputed');
    expect(store.getOnchainOrder('o-1')!.disputedAt).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **계좌 이의는 상태가 아니다**(§5.2b). 상태로 받으면 원화 마감 시계가
   * 멈추고 그 순간 **최장 8주짜리 무한 옵션**이 열린다(§7.6 R4-H1).
   * 리뷰 #8 — 전에는 콘솔에만 남아 판정할 방법이 없었다. 이제 오더에 박힌다.
   */
  it('presigned에서 계좌 이의는 시계를 멈추지 않고 증거로 박힌다', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'presigned', presignedAt: nowSec() - 60, accountSentAt: nowSec() - 30,
      krwDeadline: nowSec() + 1000,
    }));
    await svc.handleOnchainDispute(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-dispute' as const,
        stage: 'account-unusable' as const },
    ) as never);
    const after = store.getOnchainOrder('o-1')!;
    expect(after.state).toBe('presigned');
    expect(after.accountDisputedAt).toBeGreaterThan(0);
    expect(after.krwDeadline).toBe(nowSec() + 1000); // 시계는 그대로
  });

  it('계좌 이의는 후원자가 계좌를 받은 뒤에만 낼 수 있다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: nowSec() - 60 }));
    await svc.handleOnchainDispute(req(
      { orderId: 'o-1', pubkey: SPON, action: 'onchain-dispute' as const, stage: 'account-unusable' as const },
    ) as never);
    expect(store.getOnchainOrder('o-1')!.accountDisputedAt).toBeUndefined();
  });

  it('계좌 이의 판정 — 사유를 확정하고 그때 보증금을 처리한다', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'refunding', settlementKind: 'refund:account-disputed', settlementFeeSat: 400,
      customerDepositHash: 'hc', sponsorDepositHash: 'hs',
    }));
    meta.mergeEscrowMeta('o-1', { customerDepositKey: 'k-c', sponsorDepositKey: 'k-s' });
    ln.lookupHoldInvoice.mockResolvedValue('accepted');

    await svc.resolveAccountDispute(store.getOnchainOrder('o-1')!, 'account-bad');
    expect(store.getOnchainOrder('o-1')!.settlementKind).toBe('refund:customer-late');
    expect(ln.settleInvoice).toHaveBeenCalledTimes(1); // 고객 몰수
  });

  it('제3자는 분쟁을 걸 수 없다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'remitted', remittedAt: 1 }));
    await svc.handleOnchainDispute(req(
      { orderId: 'o-1', pubkey: 'stranger', action: 'onchain-dispute' as const },
    ) as never);
    expect(store.getOnchainOrder('o-1')!.state).toBe('remitted');
  });
});

// ── ⑦ 종결 결정 ─────────────────────────────────────────────

describe('종결 결정', () => {
  beforeEach(() => {
    store.upsertOnchainOrder(fundedOrder());
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2, refundAddress: REFUND });
  });

  it('후원자승 판정은 disputed에 박히고 후원자에게 서명을 요청한다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'disputed', remittedAt: 1, disputedAt: 2, updatedAt: 99 }));
    const updated = await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'sponsor_win');
    expect(updated?.state).toBe('disputed');
    expect(updated?.settlementKind).toBe('sponsor_win');
    const sent = lastSignRequest()!;
    expect(sent.purpose).toBe('dispute-sponsor');
    expect(outputAddressOf(fromPsbtBase64(sent.psbt), DESCRIPTOR)).toBe(PAYOUT);
  });

  it('판정은 disputed에서만', async () => {
    expect(await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'sponsor_win')).toBeNull();
  });

  /** `releaseFeeSat`은 T0 고정이라 분쟁이 길어지면 낡는다 — tx가 멤풀에서 썩는다(§6.1). */
  it('수수료를 새로 추정해 오더에 박는다', async () => {
    chain.getFeeEstimates.mockResolvedValue({
      known: true, value: { fastest: 60, halfHour: 50, hour: 40, economy: 10, minimum: 1 },
    });
    const updated = await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:reserve');
    expect(updated!.settlementFeeSat!).toBeGreaterThan(store.getOnchainOrder('o-1')!.releaseFeeSat! * 10);
  });

  it('수수료를 모르면 미룬다 (상태를 안 바꾼다)', async () => {
    chain.getFeeEstimates.mockResolvedValue({ known: false, reason: '502' });
    expect(await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:reserve')).toBeNull();
    expect(store.getOnchainOrder('o-1')!.state).toBe('funded');
  });

  /** 결정이 오더에 있으므로 **어느 기기에서든** 같은 tx를 다시 만든다(리뷰 #8 — 기기 이전) */
  it('다시 보내기는 같은 tx를 보낸다', async () => {
    const decided = (await svc.decideOnchainSettlement(store.getOnchainOrder('o-1')!, 'refund:sponsor-timeout'))!;
    const first = fromPsbtBase64(lastSignRequest()!.psbt).id;
    await svc.requestSettlementSignature(decided);
    expect(fromPsbtBase64(lastSignRequest()!.psbt).id).toBe(first);
    expect(requestLog.lastSignatureRequestAt('o-1')).toBeGreaterThan(0);
  });
});

// ── ⑦b 구조 — 약정 밖의 자금을 고객에게 (리뷰 #8) ────────────

describe('구조', () => {
  const STRAY = { txid: 'e1'.repeat(32), vout: 0, valueSat: 70_000 };

  beforeEach(() => {
    store.upsertOnchainOrder(fundedOrder({ state: 'remitted', remittedAt: 1 }));
    meta.mergeEscrowMeta('o-1', { payoutAddress: PAYOUT, feerateSatPerVb: 2, refundAddress: REFUND });
  });

  /** 진행 중 거래의 에스크로를 고객에게 돌리면 그게 탈취다 — 후원자가 원화를 보냈을 수 있다 */
  it('진행 중인 거래의 에스크로는 구조하지 않는다', async () => {
    const err = await svc.requestOnchainRescue(store.getOnchainOrder('o-1')!, { txid: TXID, vout: 0, valueSat: AMOUNT });
    expect(err).toMatch(/진행 중/);
    expect(lastSignRequest()).toBeUndefined();
  });

  it('추가 입금은 고객 환불 주소로 돌려준다 — 고객 서명 → 어드민 서명 → 브로드캐스트', async () => {
    expect(await svc.requestOnchainRescue(store.getOnchainOrder('o-1')!, STRAY)).toBeNull();
    const sent = lastSignRequest()!;
    expect(sent.purpose).toBe('rescue');
    const tx = fromPsbtBase64(sent.psbt);
    expect(outputAddressOf(tx, DESCRIPTOR)).toBe(REFUND);
    signSettlement(tx, SK_C);

    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'rescue' as const },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(tx) })}`,
    ) as never);
    expect(chain.broadcastTx).toHaveBeenCalledTimes(1);
    expect(store.getOnchainOrder('o-1')!.state).toBe('remitted'); // FSM은 안 건드린다
  });

  it('요청한 적 없는 UTXO의 구조 서명은 받지 않는다', async () => {
    const tx = buildSettlementTx({
      descriptor: DESCRIPTOR, input: { outpoint: STRAY, valueSat: STRAY.valueSat },
      path: 'refund', destination: REFUND, feeSat: 400,
    });
    signSettlement(tx, SK_C);
    await svc.handleOnchainCosign(req(
      { orderId: 'o-1', pubkey: CUST, action: 'onchain-cosign' as const, purpose: 'rescue' as const },
      `enc:${JSON.stringify({ psbt: toPsbtBase64(tx) })}`,
    ) as never);
    expect(chain.broadcastTx).not.toHaveBeenCalled();
  });
});

// ── ⑦c 송금 주장 ────────────────────────────────────────────

describe('송금 주장', () => {
  it('계좌를 받고 마감 전이면 remitted', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'presigned', presignedAt: nowSec() - 100, accountSentAt: nowSec() - 60, krwDeadline: nowSec() + 1000,
    }));
    await svc.handleOnchainRemit({ orderId: 'o-1', pubkey: SPON });
    expect(store.getOnchainOrder('o-1')!.state).toBe('remitted');
  });

  /** R1 — 마감 뒤 주장을 받으면 환불이 걸린 거래가 remitted로 굴러간다 */
  it('송금 마감이 지나면 받지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'presigned', presignedAt: nowSec() - 3000, accountSentAt: nowSec() - 2000, krwDeadline: nowSec() - 1,
    }));
    await svc.handleOnchainRemit({ orderId: 'o-1', pubkey: SPON });
    expect(store.getOnchainOrder('o-1')!.state).toBe('presigned');
    expect(rejections()[0]).toMatch(/마감/);
  });

  it('환불이 결정된 주문에는 받지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder({
      state: 'refunding', settlementKind: 'refund:customer-late', settlementFeeSat: 400,
      accountSentAt: nowSec() - 60, krwDeadline: nowSec() + 1000,
    }));
    await svc.handleOnchainRemit({ orderId: 'o-1', pubkey: SPON });
    expect(store.getOnchainOrder('o-1')!.state).toBe('refunding');
  });
});

// ── ⑧ 계좌 공개 시점 ────────────────────────────────────────

describe('계좌 공개 (O-013)', () => {
  it('공개 시점부터 후원자 마감을 센다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: nowSec() - 60 }));
    await svc.noteAccountInfoSent('o-1', CUST, 'commit-1');

    const after = store.getOnchainOrder('o-1')!;
    expect(after.accountSentAt).toBeGreaterThan(0);
    expect(after.krwDeadline).toBe(after.accountSentAt! + 30 * 60);
    expect(svc.accountInfoSent('o-1')).toBe(true);
    // 계좌 이의 판정에 쓸 커밋먼트를 남긴다
    expect(meta.getEscrowMeta('o-1')?.accountCommitment).toBe('commit-1');
  });

  /** 사전서명 전에는 계좌가 **릴레이에 존재하지도 않아야** 한다 (O-003). */
  it('presigned 전에는 기록하지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder());
    await svc.noteAccountInfoSent('o-1', CUST);
    expect(store.getOnchainOrder('o-1')!.accountSentAt).toBeUndefined();
  });

  it('두 번 불러도 시각이 안 밀린다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: nowSec() - 60 }));
    await svc.noteAccountInfoSent('o-1', CUST);
    const first = store.getOnchainOrder('o-1')!.accountSentAt;
    await svc.noteAccountInfoSent('o-1', CUST);
    expect(store.getOnchainOrder('o-1')!.accountSentAt).toBe(first);
  });

  /**
   * 리뷰 #8 C1 — 전에는 이 알림을 **아무나** 보낼 수 있었다. 제3자가 가짜 계좌를
   * 후원자에게 보내며 이걸로 시계까지 시작시키면, 진짜 고객의 계좌 폼은 사라지고
   * 후원자는 공격자 계좌로 원화를 보냈다.
   */
  it('고객이 아닌 쪽이 보낸 계좌 알림은 무시한다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: nowSec() - 60 }));
    await svc.noteAccountInfoSent('o-1', 'attacker-pubkey');
    expect(store.getOnchainOrder('o-1')!.accountSentAt).toBeUndefined();
  });

  it('계좌 공개 마감(15분)이 지나면 받지 않는다', async () => {
    store.upsertOnchainOrder(fundedOrder({ state: 'presigned', presignedAt: nowSec() - 16 * 60 }));
    await svc.noteAccountInfoSent('o-1', CUST);
    expect(store.getOnchainOrder('o-1')!.accountSentAt).toBeUndefined();
    expect(rejections()[0]).toMatch(/마감/);
  });
});

// ── ⑨ 고객이 의뢰를 접는다 ──────────────────────────────────

describe('의뢰 내리기', () => {
  const cancel = (pubkey = CUST) => ({ orderId: 'o-1', pubkey });

  beforeEach(() => {
    store.upsertOnchainOrder(order({ customerDepositHash: 'hash-c' }));
    ln.lookupHoldInvoice.mockResolvedValue('accepted');
  });

  it('listed에서 접으면 취소되고 보증금이 환불된다', async () => {
    await svc.handleOnchainCancelRequest(cancel());
    expect(store.getOnchainOrder('o-1')?.state).toBe('cancelled');
    // 후원자가 없었으니 몰수가 아니라 **환불**이다 (§4.1b)
    expect(ln.cancelInvoice).toHaveBeenCalled();
    expect(ln.settleInvoice).not.toHaveBeenCalled();
  });

  /**
   * 후원자가 붙은 뒤에는 상대가 이미 돈을 걸었다. 일방 취소를 열면
   * 라이트닝에서 닫아둔 선취적 취소(T-003)가 여기서 부활한다.
   */
  it.each(['bonded', 'funded', 'presigned', 'remitted'] as const)(
    '%s에서는 접을 수 없다',
    async state => {
      store.upsertOnchainOrder(fundedOrder({ state, updatedAt: 99, remittedAt: 1 }));
      await svc.handleOnchainCancelRequest(cancel());
      expect(store.getOnchainOrder('o-1')?.state).toBe(state);
    },
  );

  it('의뢰자가 아니면 거부한다', async () => {
    await svc.handleOnchainCancelRequest(cancel('stranger'));
    expect(store.getOnchainOrder('o-1')?.state).toBe('listed');
  });

  /** 취소된 뒤 결제해 "냈는데 늦었다"를 겪지 않게, 열린 인보이스를 먼저 치운다. */
  it('결제 안 된 후원자 인보이스를 치운다', async () => {
    deposits.putOnchainDeposit({
      orderId: 'o-1', type: 'sponsor', sponsorPubkey: SPON, customerPubkey: CUST,
      depositPaymentHash: 'h-s', depositBolt11: 'lnbc', amountSat: 15_000, createdAt: 1,
      sponsorXonly: XS, payoutAddress: PAYOUT, feerateSatPerVb: 2,
    });

    await svc.handleOnchainCancelRequest(cancel());
    expect(deposits.getOnchainDepositsFor('o-1')).toHaveLength(0);
  });
});
