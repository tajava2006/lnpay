/**
 * 온체인 요청 검증 — 누가, 언제, 무엇을 (프론트 시절 `onchain-service` 테스트를 데몬으로)
 *
 * kind 1111은 누구나 서명해 쏠 수 있다. 여기 줄들이 남의 의뢰를 가로채거나, 마감 뒤에 끼어들거나, 이상한
 * 주소·수수료로 고객 BTC를 묶는 요청을 막는다. 거절은 **유저에게 도달해야 한다**(onchain-rejected).
 */
import { describe, expect, it } from 'vitest';
import { REQUEST_ACTIONS, nip44Encrypt } from '@sajwo-tracker/shared/core';
import {
  PRESIGN_WINDOW_SEC, buildSettlementTx, deriveSingleKeyAddress, signSettlement, toPsbtBase64, xonlyFromPrivkey,
} from '@sajwo-tracker/shared/onchain';
import { openAlerts } from '../admin/alerts';
import { loadSettings, saveSettings } from '../admin/settings';
import { newKey } from './fakes';
import { tagOf } from './ln-fakes';
import {
  AMOUNT, FUND_TXID, PAYOUT, REFUND, SK_C, SK_S, XC, XS, claimOc, cosignOc, createOcHarness, descriptorOf, fundOc,
  ocMessagesTo, ocRequest, openOc, presignOc, rejectionsTo, remitOc, sendAccountOc, type OcHarness,
} from './oc-fakes';

async function request(h: OcHarness, orderId: string, opts: {
  amountSat?: number; listingSec?: number; reserveKrw?: number; payload?: unknown; from?: ReturnType<typeof newKey>;
} = {}) {
  const from = opts.from ?? h.customer;
  const extra: string[][] = [['amount-sat', String(opts.amountSat ?? AMOUNT)], ['customer-xonly', XC]];
  if (opts.reserveKrw !== undefined) extra.push(['reserve-krw', String(opts.reserveKrw)]);
  await h.send(ocRequest(from, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_ORDER_REQUEST, h.sec(), extra,
    nip44Encrypt(JSON.stringify(opts.payload ?? { refundAddress: REFUND }), from.secretKey, h.app.pubkey),
    h.sec() + (opts.listingSec ?? 86_400)));
}

async function claimWith(h: OcHarness, orderId: string, payload: unknown, sponsor = h.sponsor) {
  await h.send(ocRequest(sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_CLAIM, h.sec(), [['sponsor-xonly', XS]],
    nip44Encrypt(JSON.stringify(payload), sponsor.secretKey, h.app.pubkey)));
}

const bondInvoices = (h: OcHarness, orderId: string) => h.ln.holds.of(orderId);

describe('의뢰 등록', () => {
  it('보증금 인보이스를 내고, 결제되면 listed — 환불 주소는 비공개로 남는다', async () => {
    const h = await createOcHarness();
    await request(h, 'ocreq1');
    expect(h.row('ocreq1')).toBeUndefined();
    const required = ocMessagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED);
    expect(required).toHaveLength(1);
    h.node.pay(tagOf(required[0], 'bolt11')!);
    await h.run();
    const row = h.row('ocreq1')!;
    expect(row.order.state).toBe('listed');
    expect(row.meta.refundAddress).toBe(REFUND);
    expect(JSON.stringify(h.relay.published.filter(e => e.kind === 30402))).not.toContain(REFUND);
  });

  it('새 의뢰를 끄면 받지 않는다 (진행 중인 거래는 그대로)', async () => {
    const h = await createOcHarness();
    const s = loadSettings(h.ln.db);
    saveSettings(h.ln.db, { ...s, onchain: { acceptNewOrders: false } });
    await request(h, 'ocoff1');
    expect(bondInvoices(h, 'ocoff1')).toHaveLength(0);
    expect(rejectionsTo(h, h.customer.pubkey)).toEqual(['지금은 온체인 의뢰를 받지 않습니다']);
  });

  it('의뢰 만료가 7일을 넘으면 · 최소 거래액 미만이면 · 수수료를 모르면 거절한다', async () => {
    const h = await createOcHarness();
    await request(h, 'ocfar1', { listingSec: 8 * 86_400 });
    await request(h, 'ocsmall', { amountSat: 1_000 });
    h.ln.db.run(`DELETE FROM kv WHERE key = 'oc.fees'`);
    h.chain.feesKnown = false;
    await request(h, 'ocnofee');
    const reasons = rejectionsTo(h, h.customer.pubkey);
    expect(reasons[0]).toMatch(/7일/);
    expect(reasons[1]).toMatch(/최소 거래액/);
    expect(reasons[2]).toMatch(/수수료를 조회하지 못했/);
    expect(h.ln.holds.of('ocfar1').length + h.ln.holds.of('ocsmall').length + h.ln.holds.of('ocnofee').length).toBe(0);
  });

  it('환불 주소가 없거나 다른 네트워크 것이면 거절한다', async () => {
    const h = await createOcHarness();
    await request(h, 'ocnoref', { payload: {} });
    await request(h, 'ocmain1', { payload: { refundAddress: deriveSingleKeyAddress(xonlyFromPrivkey(SK_C), 'mainnet') } });
    const reasons = rejectionsTo(h, h.customer.pubkey);
    expect(reasons[0]).toMatch(/환불 받을 주소가 없습니다/);
    expect(reasons[1]).toMatch(/환불 주소를 쓸 수 없습니다/);
  });

  /** 최저가를 시세 바로 아래에 걸면 컨펌 대기 중의 공짜 옵션이 된다 */
  it('최저가가 시세에 붙어 있으면 거절한다 · 시세를 모르면 최저가 의뢰를 받지 않는다', async () => {
    const h = await createOcHarness();
    const market = Math.round((AMOUNT / 1e8) * 150_000_000);
    await request(h, 'ocres1', { reserveKrw: market });
    h.price.value = null;
    await request(h, 'ocres2', { reserveKrw: Math.round(market * 0.5) });
    await request(h, 'ocres3');
    expect(rejectionsTo(h, h.customer.pubkey)).toHaveLength(2);
    expect(bondInvoices(h, 'ocres3')).toHaveLength(1);
  });

  it('같은 의뢰가 두 번 와도 인보이스는 하나다', async () => {
    const h = await createOcHarness();
    await request(h, 'ocdup1');
    await request(h, 'ocdup1');
    expect(bondInvoices(h, 'ocdup1')).toHaveLength(1);
  });

  it('보증금을 내기 전에 접으면 인보이스를 치운다', async () => {
    const h = await createOcHarness();
    await request(h, 'occan1');
    const bolt11 = tagOf(ocMessagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!;
    await h.send(ocRequest(h.customer, h.app.pubkey, 'occan1', REQUEST_ACTIONS.CANCEL_REQUEST, h.sec()));
    expect(h.node.stateOf(bolt11)).toBe('cancelled');
  });
});

describe('클레임', () => {
  it('후원자 보증금은 3% (하한이 이기면 하한) — 여러 후원자가 동시에 받을 수 있다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId, { pay: false });
    await claimOc(h, orderId, { sponsor: newKey(), pay: false });
    const sponsorBonds = bondInvoices(h, orderId).filter(i => i.purpose === 'oc-sponsor-bond');
    expect(sponsorBonds).toHaveLength(2);
    expect(sponsorBonds[0]!.amount_sat).toBe(Math.max(Math.ceil(AMOUNT * 0.03), Math.ceil(169 * 2 * 4)));
  });

  it('자기 의뢰 · 이미 가져간 의뢰 · 이상한 페이로드는 거절한다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId, { sponsor: h.customer, pay: false });
    expect(rejectionsTo(h, h.customer.pubkey).at(-1)).toMatch(/자기 의뢰/);

    const odd = newKey();
    await claimWith(h, orderId, { payoutAddress: 42 }, odd);
    expect(rejectionsTo(h, odd.pubkey).at(-1)).toMatch(/받을 주소·수수료율을 읽지 못했/);

    await claimOc(h, orderId);
    const late = newKey();
    await claimOc(h, orderId, { sponsor: late, pay: false });
    expect(rejectionsTo(h, late.pubkey).at(-1)).toMatch(/이미 다른 분이 맡았거나/);
  });

  it('다른 네트워크 주소 · 터무니없는 feerate는 인보이스를 내주지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    const a = newKey();
    const b = newKey();
    await claimOc(h, orderId, { sponsor: a, pay: false, payout: deriveSingleKeyAddress(xonlyFromPrivkey(SK_C), 'mainnet') });
    await claimOc(h, orderId, { sponsor: b, pay: false, feerate: 10_000 });
    expect(rejectionsTo(h, a.pubkey).at(-1)).toMatch(/받을 주소를 쓸 수 없습니다/);
    expect(rejectionsTo(h, b.pubkey)).toHaveLength(1);
    expect(bondInvoices(h, orderId).filter(i => i.purpose === 'oc-sponsor-bond')).toHaveLength(0);
  });

  it('같은 후원자가 두 번 눌러도 하나 · 대기 후보가 다섯이면 더 안 내준다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId, { pay: false });
    await claimOc(h, orderId, { pay: false });
    for (let i = 0; i < 4; i++) await claimOc(h, orderId, { sponsor: newKey(), pay: false });
    const sixth = newKey();
    await claimOc(h, orderId, { sponsor: sixth, pay: false });
    expect(bondInvoices(h, orderId).filter(i => i.purpose === 'oc-sponsor-bond')).toHaveLength(5);
    expect(rejectionsTo(h, sixth.pubkey).at(-1)).toMatch(/여럿입니다/);
  });
});

describe('사전서명', () => {
  it('후원자가 아닌 쪽 · 다른 금액으로 서명한 PSBT · 마감 뒤는 받지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);

    await presignOc(h, orderId, h.row(orderId)!.order.releaseFeeSat! + 1); // 수수료가 다르다 = 다른 tx
    expect(h.row(orderId)!.order.state).toBe('funded');
    expect(rejectionsTo(h, h.sponsor.pubkey).at(-1)).toMatch(/사전서명이 맞지 않습니다/);

    // 제3자가 **유효한** 사전서명(후원자 키로 서명된 것)을 들고 와도 — 보낸 사람이 후원자가 아니면 안 된다
    h.advance(PRESIGN_WINDOW_SEC - 60);
    const stranger = newKey();
    const o = h.row(orderId)!.order;
    const tx = buildSettlementTx({
      descriptor: descriptorOf(h, orderId), input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: o.amountSat },
      path: 'release', destination: PAYOUT, feeSat: o.releaseFeeSat!,
    });
    signSettlement(tx, SK_S);
    await h.send(ocRequest(stranger, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_PRESIG, h.sec(), [],
      nip44Encrypt(JSON.stringify({ psbt: toPsbtBase64(tx) }), stranger.secretKey, h.app.pubkey)));
    expect(h.row(orderId)!.order.state).toBe('funded');

    await presignOc(h, orderId);
    expect(h.row(orderId)!.order.state).toBe('presigned');
  });

  /** 워처 틱 사이에 들어온 늦은 사전서명을 받아주면 환불로 넘어갈 거래가 다시 굴러간다 */
  it('마감(T0+15분)이 지난 사전서명은 핸들러가 직접 거절한다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    h.advance(PRESIGN_WINDOW_SEC + 10); // 워처가 아직 안 돌았다
    await presignOc(h, orderId);
    expect(rejectionsTo(h, h.sponsor.pubkey).at(-1)).toMatch(/마감/);
    expect(h.row(orderId)!.order.state).toBe('refunding');
  });
});

describe('최종 서명', () => {
  it('고객이 아닌 쪽의 릴리스 서명 · 서명이 빠진 PSBT는 받지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    await sendAccountOc(h, orderId);
    await remitOc(h, orderId);

    // 후원자가 자기 키로 "고객 서명"을 흉내 낸다
    const req = (await import('./oc-fakes')).lastSignRequest(h, h.customer)!;
    await h.send(ocRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_COSIGN, h.sec(), [['purpose', 'release']],
      nip44Encrypt(JSON.stringify({ psbt: req.psbt }), h.sponsor.secretKey, h.app.pubkey)));
    // 고객이 서명 없이 그대로 돌려보낸다 — 거절이 **고객에게** 간다(운영자 경보가 아니다)
    await h.send(ocRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_COSIGN, h.sec(), [['purpose', 'release']],
      nip44Encrypt(JSON.stringify({ psbt: req.psbt }), h.customer.secretKey, h.app.pubkey)));
    expect(h.row(orderId)!.order.state).toBe('remitted');
    expect(h.chain.broadcasted).toHaveLength(0);
    expect(rejectionsTo(h, h.customer.pubkey).at(-1)).toMatch(/서명이 맞지 않습니다/);
    expect(openAlerts(h.ln).some(a => a.level === 'anomaly')).toBe(false);

    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    expect(h.row(orderId)!.order.state).toBe('settling');

    // 같은 서명이 또 와도(재전송) 다시 뿌리지 않는다 — 결정된 종결은 한 번이다
    const settlingAt = h.row(orderId)!.order.settlingAt;
    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    expect(h.chain.broadcasted).toHaveLength(1);
    expect(h.row(orderId)!.order.settlingAt).toBe(settlingAt);
  });
});

describe('송금 주장 · 계좌 · 분쟁 — 보낸 사람과 마감', () => {
  it('계좌 전에 송금 주장은 거절 · 제3자 계좌는 무시 · 고객 계좌가 오면 후원자 마감이 그때부터', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);

    await remitOc(h, orderId);
    expect(rejectionsTo(h, h.sponsor.pubkey).at(-1)).toMatch(/계좌가 아직/);

    await sendAccountOc(h, orderId, newKey());
    expect(h.row(orderId)!.order.accountSentAt).toBeUndefined();

    h.advance(10 * 60);
    await sendAccountOc(h, orderId);
    const o = h.row(orderId)!.order;
    expect(o.krwDeadline).toBe(o.accountSentAt! + 30 * 60);

    // 두 번 보내도 시각이 안 밀린다
    h.advance(60);
    await sendAccountOc(h, orderId);
    expect(h.row(orderId)!.order.accountSentAt).toBe(o.accountSentAt);

    h.advance(31 * 60);
    await remitOc(h, orderId);
    expect(h.row(orderId)!.order.state).not.toBe('remitted');
  });

  it('제3자는 분쟁을 걸 수 없고, 의뢰자가 아니면 의뢰를 내릴 수 없다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    const stranger = newKey();
    await h.send(ocRequest(stranger, h.app.pubkey, orderId, REQUEST_ACTIONS.CANCEL_REQUEST, h.sec()));
    expect(h.row(orderId)!.order.state).toBe('listed');
    await claimOc(h, orderId);
    await h.send(ocRequest(stranger, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_DISPUTE, h.sec()));
    expect(h.row(orderId)!.order.state).toBe('bonded');
    // 후원자가 붙은 뒤에는 고객도 일방으로 못 접는다
    await h.send(ocRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.CANCEL_REQUEST, h.sec()));
    expect(h.row(orderId)!.order.state).toBe('bonded');
    expect(rejectionsTo(h, h.customer.pubkey).at(-1)).toMatch(/후원자가 이미 붙어/);
  });

  it('listed에서 접으면 취소되고 보증금이 환불되고, 결제 안 된 후원자 인보이스도 치운다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId, { pay: false });
    const sponsorBolt11 = tagOf(ocMessagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!;
    await h.send(ocRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.CANCEL_REQUEST, h.sec()));
    const o = h.row(orderId)!.order;
    expect(o.state).toBe('cancelled');
    expect(h.node.stateOf(o.customerDepositHash!)).toBe('cancelled');
    expect(h.node.stateOf(sponsorBolt11)).toBe('cancelled');
  });

  it('송금 주장 뒤 분쟁은 당사자만 연다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    await sendAccountOc(h, orderId);
    await remitOc(h, orderId);
    await h.send(ocRequest(newKey(), h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_DISPUTE, h.sec()));
    expect(h.row(orderId)!.order.state).toBe('remitted');
    await h.send(ocRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_DISPUTE, h.sec()));
    expect(h.row(orderId)!.order.state).toBe('disputed');
  });

  it('계좌 이의는 계좌를 받은 뒤 송금 마감 전에만', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    await h.send(ocRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_DISPUTE, h.sec(), [['stage', 'account-unusable']]));
    expect(h.row(orderId)!.order.accountDisputedAt).toBeUndefined();
    expect(rejectionsTo(h, h.sponsor.pubkey).at(-1)).toMatch(/계좌를 받은 뒤/);
  });

  it('refunding에서 고객이 릴리스 서명을 보내도 받지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    h.advance(PRESIGN_WINDOW_SEC + 1);
    await h.run();
    expect(h.row(orderId)!.order.state).toBe('refunding');
    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    expect(h.row(orderId)!.order.state).toBe('refunding');
  });
});
