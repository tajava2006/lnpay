/**
 * 온체인 트랙 e2e — 데몬 위에서
 *
 * 프론트 어드민 시절의 e2e 시나리오를 데몬 하네스로 옮겼다. 릴레이는 지난 `expiration`을 거절하고, 체인은
 * 소모된 UTXO를 목록에서 빼고 소모 증인을 돌려준다. 서명은 진짜다 — 고객·후원자 키로 PSBT에 서명하면 데몬이
 * 검증해 어드민 서명(시드 파생 키)을 얹어 완성한다.
 *
 * "브로드캐스트 전 발행이 실패하면"(O-019)은 데몬에서 **구조적으로 없어졌다** — outbox와 `settling`을
 * 한 트랜잭션에 쓰고, 뿌리는 건 그 뒤의 효과다. 그 자리에 "브로드캐스트가 실패해도 장부는 settling이고 효과가
 * 다시 뿌린다"를 둔다.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ACTIONS, REQUEST_ACTIONS, SAJWO_REQUEST_KIND } from '@sajwo-tracker/shared/core';
import {
  ACCOUNT_WINDOW_SEC, COSIGN_WINDOW_SEC, FUNDING_WINDOW_SEC, PRESIGN_WINDOW_SEC,
  buildSettlementTx, finalizeSettlement, fromPsbtBase64, fromRawHex, outputAddressOf, parseOnchainOrder,
  settlementFeeSat, settlementPathForKind, signSettlement,
} from '@sajwo-tracker/shared/onchain';
import { openAlerts } from '../admin/alerts';
import { TEST_TAGS, adminCommand, eventsTo, openResult, type TestKey } from './fakes';
import { tagOf } from './ln-fakes';
import {
  AMOUNT, FUND_TXID, PAYOUT, REFUND, SK_C, SK_S, claimOc, confirmSettlementOc, cosignOc, createOcHarness,
  descriptorOf, fundOc, lastSignRequest, ocMessagesTo, openOc, presignOc, remitOc, sendAccountOc, toRemittedOc,
  type OcHarness,
} from './oc-fakes';

async function command(h: OcHarness, cmd: string, args: Record<string, unknown>, operator: TestKey = h.operator) {
  const event = adminCommand(operator, h.app.pubkey, TEST_TAGS.admin, { cmd, args }, h.sec());
  await h.send(event, 6);
  const result = eventsTo(h.relay, operator.pubkey, ADMIN_ACTIONS.RESULT).find(e => e.tags.some(t => t[0] === 'e' && t[1] === event.id));
  if (!result) throw new Error('결과가 안 왔다');
  return openResult(result, operator, h.app.pubkey) as { ok: boolean; error?: string; result?: { version?: number } };
}

const target = (h: OcHarness, orderId: string) => ({ track: 'onchain', orderId, version: h.row(orderId)!.version });
const state = (h: OcHarness, orderId: string) => h.row(orderId)?.order.state;
const holdState = (h: OcHarness, hash: string | undefined) => (hash ? h.node.stateOf(hash) : undefined);

/** 이 오더의 가장 최근 공개 이벤트 (온체인 코덱으로 읽는다) */
function lastPublic(h: OcHarness, orderId: string) {
  const e = h.relay.published
    .filter(ev => ev.kind === SAJWO_REQUEST_KIND && ev.tags.some(t => t[0] === 'd' && t[1] === orderId))
    .sort((a, b) => a.created_at - b.created_at).at(-1);
  return e ? parseOnchainOrder(e, TEST_TAGS.onchain) : null;
}

describe('① 정상 완료', () => {
  it('등록 → 클레임 → 펀딩 → 사전서명 → 계좌 → 송금 → 릴리스', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    expect(state(h, orderId)).toBe('listed');
    expect(lastPublic(h, orderId)?.state).toBe('listed');

    await claimOc(h, orderId);
    const bonded = h.row(orderId)!.order;
    expect(bonded.state).toBe('bonded');
    expect(bonded.escrowAddress).toBe(descriptorOf(h, orderId).address);
    // 어드민 키는 시드 파생 — 공개 이벤트에 x-only가 실린다(고객·후원자 앱이 주소를 스스로 검증한다)
    expect(lastPublic(h, orderId)?.adminXonly).toBe(bonded.adminXonly);

    await fundOc(h, orderId);
    const funded = h.row(orderId)!.order;
    expect(funded.state).toBe('funded');
    expect(funded.priceKrw).toBe(Math.round((AMOUNT / 1e8) * 150_000_000));
    expect(funded.payoutSat).toBe(AMOUNT - funded.releaseFeeSat!);
    // 마감은 데몬이 찍어 공개한다 — 앱은 이 값을 보여준다(2026-09-25)
    expect(funded.presignDeadline).toBe(funded.fundedAt! + PRESIGN_WINDOW_SEC);
    expect(lastPublic(h, orderId)?.presignDeadline).toBe(funded.presignDeadline);

    await presignOc(h, orderId);
    expect(state(h, orderId)).toBe('presigned');
    expect(lastSignRequest(h, h.customer)?.purpose).toBe('release');
    const presigned = h.row(orderId)!.order;
    expect(presigned.accountDeadline).toBe(presigned.presignedAt! + ACCOUNT_WINDOW_SEC);
    expect(lastPublic(h, orderId)?.accountDeadline).toBe(presigned.accountDeadline);

    await sendAccountOc(h, orderId);
    expect(h.row(orderId)!.order.accountSentAt).toBeDefined();
    await remitOc(h, orderId);
    expect(state(h, orderId)).toBe('remitted');
    expect(h.chain.broadcasted).toHaveLength(0); // O-007: 송금 주장만으로는 아무것도 안 나간다
    const remitted = h.row(orderId)!.order;
    expect(remitted.cosignDeadline).toBe(remitted.remittedAt! + COSIGN_WINDOW_SEC);

    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    expect(state(h, orderId)).toBe('settling');
    expect(h.chain.broadcasted).toHaveLength(1);
    const spender = fromRawHex(h.chain.broadcasted[0]!);
    expect(outputAddressOf(spender, descriptorOf(h, orderId))).toBe(PAYOUT);
    // 고객 서명이 온 순간 릴리스는 되돌릴 수 없다 — 컨펌을 기다리지 않고 양쪽 보증금을 돌려준다(2026-09-25)
    const settling = h.row(orderId)!.order;
    expect(holdState(h, settling.customerDepositHash)).toBe('cancelled');
    expect(holdState(h, settling.sponsorDepositHash)).toBe('cancelled');

    await confirmSettlementOc(h, orderId);
    const released = h.row(orderId)!.order;
    expect(released.state).toBe('released');
    expect(holdState(h, released.customerDepositHash)).toBe('cancelled');
    expect(holdState(h, released.sponsorDepositHash)).toBe('cancelled');
    expect(lastPublic(h, orderId)?.state).toBe('released');
  });
});

describe('② 후원자 이탈 (사전서명 마감 초과)', () => {
  it('환불이 결정되고, 몰수는 그때 집행되고, 고객이 서명하면 환불 주소로 간다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);

    h.advance(PRESIGN_WINDOW_SEC + 1);
    await h.run();
    const refunding = h.row(orderId)!.order;
    expect(refunding.state).toBe('refunding');
    expect(refunding.settlementKind).toBe('refund:sponsor-timeout');
    // **결정 시점에** 후원자 보증금 몰수 (T-123 — 서명을 기다리지 않는다)
    expect(holdState(h, refunding.sponsorDepositHash)).toBe('settled');

    // 고객에게 간 PSBT는 **서명 없는** 것이고, 받는 곳은 고객이 낸 환불 주소다
    const sent = lastSignRequest(h, h.customer)!;
    expect(sent.purpose).toBe('refund');
    expect(fromPsbtBase64(sent.psbt).getInput(0).tapScriptSig ?? []).toHaveLength(0);
    expect(outputAddressOf(fromPsbtBase64(sent.psbt), descriptorOf(h, orderId))).toBe(REFUND);

    // 다음 틱에 **다시 결정하지 않는다**
    await h.run();
    expect(h.row(orderId)!.order.decidedAt).toBe(refunding.decidedAt);

    await cosignOc(h, orderId, h.customer, SK_C, 'refund');
    expect(state(h, orderId)).toBe('settling');
    await confirmSettlementOc(h, orderId);
    expect(state(h, orderId)).toBe('refunded');
    expect(outputAddressOf(fromRawHex(h.chain.broadcasted[0]!), descriptorOf(h, orderId))).toBe(REFUND);
    expect(holdState(h, refunding.customerDepositHash)).toBe('cancelled');
  });
});

describe('③ 분쟁 (후원자 승)', () => {
  it('24시간 무응답 → 강제 분쟁(운영자 호출) → 판정 → 후원자가 서명해 집행', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedOc(h);

    // 고객이 24시간 동안 아무것도 안 한다 → **동의를 묻지 않고** 분쟁으로 (O-010)
    h.advance(COSIGN_WINDOW_SEC + 1);
    await h.run();
    expect(state(h, orderId)).toBe('disputed');
    expect(openAlerts(h.ln).some(a => a.orderId === orderId && /판정이 필요/.test(a.message))).toBe(true);

    // 판정 — 유일하게 사람이 하는 자리. 몰수는 **지금** 집행된다
    const r = await command(h, 'oc.rule', { target: target(h, orderId), winner: 'sponsor' });
    expect(r.ok).toBe(true);
    const ruled = h.row(orderId)!.order;
    expect(ruled.settlementKind).toBe('sponsor_win');
    expect(holdState(h, ruled.customerDepositHash)).toBe('settled');
    expect(lastSignRequest(h, h.sponsor)?.purpose).toBe('dispute-sponsor');

    await cosignOc(h, orderId, h.sponsor, SK_S, 'dispute-sponsor');
    expect(state(h, orderId)).toBe('settling');
    await confirmSettlementOc(h, orderId);
    expect(state(h, orderId)).toBe('sponsor_wins');
    expect(outputAddressOf(fromRawHex(h.chain.broadcasted[0]!), descriptorOf(h, orderId))).toBe(PAYOUT);
  });

  /** 판정 경로도 후원자가 정한 수수료율 아래로 내리지 않는다 (2026-09-25 signet: 5 sat/vB로 냈는데 1로 나갔다) */
  it('후원자승 종결 수수료는 max(후원자가 정한 수수료율, 지금 시세)', async () => {
    async function ruledFee(sponsorRate: number, market: number): Promise<{ got: number; want: number }> {
      const h = await createOcHarness();
      const orderId = await openOc(h);
      await claimOc(h, orderId, { feerate: sponsorRate });
      await fundOc(h, orderId);
      await presignOc(h, orderId);
      await sendAccountOc(h, orderId);
      await remitOc(h, orderId);
      h.chain.fees = { ...h.chain.fees, halfHour: market };
      h.advance(COSIGN_WINDOW_SEC + 1); // 수수료 캐시도 새 시세를 받는다
      await h.run();
      expect(state(h, orderId)).toBe('disputed');
      expect((await command(h, 'oc.rule', { target: target(h, orderId), winner: 'sponsor' })).ok).toBe(true);
      const want = settlementFeeSat(
        settlementPathForKind('sponsor_win'), descriptorOf(h, orderId), PAYOUT, Math.max(sponsorRate, market),
      );
      return { got: h.row(orderId)!.order.settlementFeeSat!, want };
    }
    const low = await ruledFee(5, 1); // 시세가 더 낮으면 후원자가 정한 5
    expect(low.got).toBe(low.want);
    const high = await ruledFee(2, 3); // 시세가 더 높으면 시세
    expect(high.got).toBe(high.want);
    expect(low.got).toBeGreaterThan(high.got);
  });

  it('낡은 버전의 판정은 거절된다 — 다른 기기에서 이미 판정했다', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedOc(h);
    h.advance(COSIGN_WINDOW_SEC + 1);
    await h.run();
    const stale = target(h, orderId);
    expect((await command(h, 'oc.rule', { target: stale, winner: 'customer' })).ok).toBe(true);
    expect(await command(h, 'oc.rule', { target: stale, winner: 'sponsor' })).toMatchObject({ ok: false, error: 'stale-version' });
    expect(h.row(orderId)!.order.settlementKind).toBe('customer_win');
  });
});

describe('④ 고객이 마감까지 펀딩을 컨펌 못 시킴', () => {
  it('취소되고 고객 보증금이 몰수된다 (후원자는 환불)', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    h.advance(FUNDING_WINDOW_SEC + 1);
    await h.run();
    const o = h.row(orderId)!.order;
    expect(o.state).toBe('cancelled');
    expect(holdState(h, o.customerDepositHash)).toBe('settled');
    expect(holdState(h, o.sponsorDepositHash)).toBe('cancelled');
  });

  /** ⚠️ 컨펌된 자금이 있으면 **마감이 지나도** 취소하지 않는다 (O-014) */
  it('마감이 지나도 컨펌된 펀딩이 있으면 취소하지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId, 1); // 50만 sats는 2컨펌이 필요하다
    h.advance(FUNDING_WINDOW_SEC + 1);
    await h.run();
    expect(state(h, orderId)).toBe('bonded');
  });
});

describe('O-017 — 환불이 결정되면 거래는 앞으로 가지 않는다', () => {
  it('늦은 사전서명·계좌·송금 주장이 전부 거절되고, 고객은 환불로만 나간다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    h.advance(PRESIGN_WINDOW_SEC + 1);
    await h.run();
    expect(state(h, orderId)).toBe('refunding');

    h.advance(300);
    await presignOc(h, orderId);
    await sendAccountOc(h, orderId);
    await remitOc(h, orderId);
    const o = h.row(orderId)!.order;
    expect(o.state).toBe('refunding');
    expect(o.accountSentAt).toBeUndefined();
    expect(ocMessagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.ONCHAIN_REJECTED).length).toBeGreaterThanOrEqual(2);
    // 고객이 쥔 것은 **서명 없는** PSBT뿐 — 혼자서는 아무 tx도 완성할 수 없다
    expect(fromPsbtBase64(lastSignRequest(h, h.customer)!.psbt).getInput(0).tapScriptSig ?? []).toHaveLength(0);
  });

  it('계좌 공개 마감이 지나면 늦은 계좌는 받지 않고 고객 몰수로 접는다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    h.advance(ACCOUNT_WINDOW_SEC + 1);
    await sendAccountOc(h, orderId); // 늦었다 (같은 틱에 워처가 결정한다)
    const o = h.row(orderId)!.order;
    expect(o.accountSentAt).toBeUndefined();
    expect(o.settlementKind).toBe('refund:customer-late');
    expect(holdState(h, o.customerDepositHash)).toBe('settled');
  });

  it('remitted에서 환불 서명은 받지 않는다 — 원화와 BTC를 다 가져가는 경로', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedOc(h);
    // 고객이 수정한 앱으로 릴리스 요청의 PSBT에 서명해 "refund"라고 보낸다
    await cosignOc(h, orderId, h.customer, SK_C, 'refund');
    expect(state(h, orderId)).toBe('remitted');
    expect(h.chain.broadcasted).toHaveLength(0);
  });
});

describe('DM-009 — 의뢰 만료를 넘긴 거래도 끝까지 간다 (NIP-40)', () => {
  /** 1시간짜리 의뢰가 50분에 클레임되고 70분에 컨펌됐다 — 진행 중 발행이 릴레이에서 거절되면 거래가 멈춘다 */
  it('막바지 클레임 → 의뢰 만료 뒤 펀딩 → 릴리스까지', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h, { listingSec: 3600 });
    h.advance(3000);
    await claimOc(h, orderId);
    expect(state(h, orderId)).toBe('bonded');
    h.advance(1200); // 의뢰 만료는 지났다
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    await sendAccountOc(h, orderId);
    await remitOc(h, orderId);
    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    await confirmSettlementOc(h, orderId);
    expect(state(h, orderId)).toBe('released');
    expect(lastPublic(h, orderId)?.state).toBe('released');
  });
});

describe('브로드캐스트 (O-005)', () => {
  it('뿌리기가 실패해도 장부는 settling이고, 효과가 같은 바이트로 다시 뿌린다', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedOc(h);
    h.chain.failBroadcast = 2;
    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    expect(state(h, orderId)).toBe('settling');
    expect(h.chain.broadcasted).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
      h.advance(30);
      await h.run(1);
    }
    expect(h.chain.broadcasted).toHaveLength(1);
    await confirmSettlementOc(h, orderId);
    expect(state(h, orderId)).toBe('released');
  });

  it('종결 tx가 멤풀에서 사라지면 다시 뿌린다', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedOc(h);
    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    const first = h.chain.broadcasted[0]!;
    h.chain.evict(fromRawHex(first).id);
    await h.run();
    expect(h.chain.broadcasted).toEqual([first, first]);
    expect(state(h, orderId)).toBe('settling');
  });
});

describe('체인이 장부보다 먼저 말한다', () => {
  it('어드민이 사라진 사이 고객이 타임락으로 뺐으면 swept로 적는다 (O-006)', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    const tx = buildSettlementTx({
      descriptor: descriptorOf(h, orderId), input: { outpoint: { txid: FUND_TXID, vout: 0 }, valueSat: AMOUNT },
      path: 'timelock', destination: REFUND, feeSat: 300,
    });
    signSettlement(tx, SK_C);
    finalizeSettlement(tx, 'timelock');
    h.chain.inject(tx, 1);
    await h.run();
    expect(state(h, orderId)).toBe('swept');
  });

  it('고객·후원자가 합의해 직접 뿌린 릴리스는 release로 적는다', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedOc(h);
    // 고객은 presigned부터 후원자 사전서명을 들고 있다 — 스스로 완성해 뿌릴 수 있다
    const tx = fromPsbtBase64(lastSignRequest(h, h.customer)!.psbt);
    signSettlement(tx, SK_C);
    finalizeSettlement(tx, 'release');
    h.chain.inject(tx, 0);
    await h.run();
    expect(h.row(orderId)!.order).toMatchObject({ state: 'settling', settlementKind: 'release' });
    h.chain.confirm(tx.id, 3);
    await h.run();
    expect(state(h, orderId)).toBe('released');
  });
});

describe('약정 밖의 자금 — 구조', () => {
  it('취소된 주문 주소에 늦게 들어온 자금을 보고, 운영자가 구조하면 고객 환불 주소로 간다', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    h.advance(FUNDING_WINDOW_SEC + 1);
    await h.run();
    expect(state(h, orderId)).toBe('cancelled');

    // 취소 직후 컨펌됐다
    h.chain.fund(h.row(orderId)!.order.escrowAddress!, { txid: FUND_TXID, vout: 0, valueSat: AMOUNT, confirmations: 1 });
    h.advance(11 * 60); // 끝난 주문은 10분마다 본다
    await h.run();
    expect(h.row(orderId)!.meta.strays).toEqual([{ txid: FUND_TXID, vout: 0, valueSat: AMOUNT }]);
    expect(openAlerts(h.ln).some(a => a.orderId === orderId && /약정 밖의 자금/.test(a.message))).toBe(true);

    expect((await command(h, 'oc.rescue', { target: target(h, orderId), txid: FUND_TXID, vout: 0 })).ok).toBe(true);
    expect(lastSignRequest(h, h.customer)?.purpose).toBe('rescue');
    await cosignOc(h, orderId, h.customer, SK_C, 'rescue');
    expect(h.chain.broadcasted).toHaveLength(1);
    expect(outputAddressOf(fromRawHex(h.chain.broadcasted[0]!), descriptorOf(h, orderId))).toBe(REFUND);
    expect(h.row(orderId)!.meta.rescues?.[`${FUND_TXID}:0`]?.broadcastTxid).toBeDefined();
  });

  it('진행 중인 거래의 에스크로는 구조할 수 없다 — 후원자가 송금한 뒤 돌리면 탈취다', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedOc(h);
    expect(await command(h, 'oc.rescue', { target: target(h, orderId), txid: FUND_TXID, vout: 0 }))
      .toMatchObject({ ok: false, error: 'unknown-utxo' });
    // 목록을 우회해 직접 불러도 막힌다
    const { requestRescue } = await import('../onchain/flow');
    const err = h.ln.db.tx(() => requestRescue(h.oc, orderId, { txid: FUND_TXID, vout: 0, valueSat: AMOUNT }));
    expect(err).toBe('live-escrow');
  });
});

describe('계좌 이의 — 시계는 멈추지 않고, 사람이 과실을 가른다', () => {
  it('이의 → 마감 → 보증금 보류 → 판정(이의 근거 없음) → 후원자 몰수', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    await presignOc(h, orderId);
    await sendAccountOc(h, orderId);
    const { ocRequest } = await import('./oc-fakes');
    await h.send(ocRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_DISPUTE, h.sec(), [['stage', 'account-unusable']]));
    expect(h.row(orderId)!.order).toMatchObject({ state: 'presigned' });
    expect(h.row(orderId)!.order.accountDisputedAt).toBeDefined();

    h.advance(30 * 60 + 1);
    await h.run();
    const o = h.row(orderId)!.order;
    expect(o.settlementKind).toBe('refund:account-disputed');
    // 판정 전에는 누구 보증금도 건드리지 않는다
    expect(holdState(h, o.customerDepositHash)).toBe('accepted');
    expect(holdState(h, o.sponsorDepositHash)).toBe('accepted');

    expect((await command(h, 'oc.account-dispute', { target: target(h, orderId), verdict: 'sponsor-fault' })).ok).toBe(true);
    await h.run();
    expect(h.row(orderId)!.order.settlementKind).toBe('refund:sponsor-timeout');
    expect(holdState(h, o.sponsorDepositHash)).toBe('settled');
    expect(holdState(h, o.customerDepositHash)).toBe('cancelled');
  });
});

describe('유저 알림', () => {
  /** 프론트 시절엔 마감 2시간 전부터 30초마다 울려 고객에게 240번 갔다 */
  it('입금 확인 마감 임박 알림은 송금 주장 한 번에 한 번', async () => {
    const h = await createOcHarness();
    const { nip44Encrypt } = await import('@sajwo-tracker/shared/core');
    const { lnRequest } = await import('./ln-fakes');
    const sub = { endpoint: 'https://push.example/c', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
    await h.send(lnRequest(h.customer, h.app.pubkey, null, REQUEST_ACTIONS.PUSH_SUBSCRIPTION, h.sec(), [],
      nip44Encrypt(JSON.stringify(sub), h.customer.secretKey, h.app.pubkey)));
    await toRemittedOc(h);
    const before = h.push.sent.length;
    h.advance(COSIGN_WINDOW_SEC - 60 * 60); // 마감 1시간 전
    for (let i = 0; i < 5; i++) {
      h.advance(60);
      await h.run(1);
    }
    expect(h.push.sent.length - before).toBe(1);
  });
});

describe('보증금 알림', () => {
  it('클레임이 성립하면 후원자에게 accepted, 진 후보에게 cancelled', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    const { newKey } = await import('./fakes');
    const late = newKey();
    await claimOc(h, orderId, { sponsor: late, pay: false });
    await claimOc(h, orderId);
    expect(state(h, orderId)).toBe('bonded');
    expect(h.row(orderId)!.order.sponsorPubkey).toBe(h.sponsor.pubkey);
    expect(ocMessagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_ACCEPTED)).toHaveLength(1);
    const lateBolt11 = tagOf(ocMessagesTo(h, late.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!;
    expect(h.node.stateOf(lateBolt11)).toBe('cancelled');
  });
});
