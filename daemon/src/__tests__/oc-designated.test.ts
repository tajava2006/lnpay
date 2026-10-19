/**
 * 온체인 지정 거래 — 상대를 pubkey로 묶은, 보증금 없는 1:1 거래 (docs/ONCHAIN-TRACK.md §10)
 *
 * LN 지갑이 없는 사람(온체인으로 가끔 DCA만 하는 층)의 첫 경로다 — **LN 인보이스가 하나도 안 나와야 한다.**
 * 지켜야 할 것: ① 지정된 후원자만 맡는다 ② 보증금 후보·인보이스가 없다 ③ 공개 오더로 나가지 않는다
 * ④ **펀딩 컨펌에서 멈추지 않는다**(O-015는 보증금 생존을 묻는데, 지정 거래엔 보증금이 없다 — 안 건너뛰면 영원히 hold)
 * ⑤ 몰수할 게 없으니 몰수 경보도 없다.
 */
import { unwrapEvent } from 'nostr-tools/nip17';
import { describe, expect, it } from 'vitest';
import {
  DESIGNATED_ORDER_KIND, MAX_OPEN_DESIGNATED_PER_CUSTOMER, ORDER_KIND, REQUEST_ACTIONS, designatedOrderD, nip44Encrypt,
  openDesignatedOrder,
} from '@sajwo-tracker/shared/core';
import { FUNDING_WINDOW_SEC, PRESIGN_WINDOW_SEC, parseOnchainOrder, TYPICAL_SETTLEMENT_VSIZE } from '@sajwo-tracker/shared/onchain';
import { openAlerts } from '../admin/alerts';
import { listOc } from '../onchain/bonds';
import { OC_ORDER_PUBLISH_EFFECT, candidatesOf } from '../onchain/store';
import { PUSH_EFFECT } from '../push/send';
import { TEST_TAGS, newKey, type TestKey } from './fakes';
import {
  AMOUNT, REFUND, SK_C, XC, claimOc, confirmSettlementOc, cosignOc, createOcHarness, fundOc, ocMessagesTo, ocRequest,
  openOc, presignOc, rejectionsTo, remitOc, sendAccountOc, type OcHarness,
} from './oc-fakes';

let seq = 0;

/** 고객이 지정 의뢰를 올린다 (기본: 50만 sats, 상대 = h.sponsor, 만료 3일) */
async function openDesignatedOc(
  h: OcHarness, opts: { amountSat?: number; sponsor?: string; customer?: TestKey } = {},
): Promise<string> {
  const orderId = `dz${(seq++).toString(36)}xx`;
  const customer = opts.customer ?? h.customer;
  const payload = {
    amountSat: opts.amountSat ?? AMOUNT, customerXonly: XC, refundAddress: REFUND,
    designatedSponsor: opts.sponsor ?? h.sponsor.pubkey,
  };
  await h.send(ocRequest(customer, h.app.pubkey, orderId, REQUEST_ACTIONS.ONCHAIN_DESIGNATED_ORDER_REQUEST, h.sec(), [],
    nip44Encrypt(JSON.stringify(payload), customer.secretKey, h.app.pubkey), h.sec() + 3 * 86_400));
  return orderId;
}

function snapshotFor(h: OcHarness, orderId: string, who: TestKey) {
  const event = h.relay.published
    .filter(e => e.kind === DESIGNATED_ORDER_KIND && e.tags.some(t => t[0] === 'd' && t[1] === designatedOrderD(orderId, who.pubkey)))
    .sort((a, b) => a.created_at - b.created_at)
    .at(-1);
  if (!event) return undefined;
  const opened = openDesignatedOrder(event, who.secretKey, h.app.pubkey);
  return opened ? parseOnchainOrder(opened, TEST_TAGS.onchain) : null;
}

const publicOrders = (h: OcHarness, orderId: string) =>
  h.relay.published.filter(e => e.kind === ORDER_KIND && e.tags.some(t => t[0] === 'd' && t[1] === orderId));

const forfeitAlerts = (h: OcHarness, orderId: string) =>
  openAlerts(h.ln).filter(a => a.orderId === orderId && /몰수/.test(a.message));

const state = (h: OcHarness, orderId: string) => h.row(orderId)?.order.state;

/** 지정 의뢰 → 지정 클레임 → 펀딩 → 사전서명 → 계좌 → 송금 완료 */
async function toRemittedDesignated(h: OcHarness): Promise<string> {
  const orderId = await openDesignatedOc(h);
  await claimOc(h, orderId);
  await fundOc(h, orderId);
  await presignOc(h, orderId);
  await sendAccountOc(h, orderId);
  await remitOc(h, orderId);
  return orderId;
}

describe('지정 의뢰 — 만들기', () => {
  it('보증금 인보이스 없이 바로 listed — 공개 오더로는 안 나가고 고객 · 지정 후원자 · 운영자에게만', async () => {
    const h = await createOcHarness();
    const orderId = await openDesignatedOc(h);
    const o = h.row(orderId)!.order;
    expect(o.state).toBe('listed');
    expect(o.designatedSponsor).toBe(h.sponsor.pubkey);
    expect(o.customerDepositHash).toBeUndefined();
    expect(h.row(orderId)!.meta.refundAddress).toBe(REFUND);
    expect(candidatesOf(h.oc, orderId)).toHaveLength(0);
    expect(ocMessagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)).toHaveLength(0);
    expect(h.node.holds.size).toBe(0);

    expect(publicOrders(h, orderId)).toHaveLength(0);
    for (const who of [h.customer, h.sponsor, h.operator]) {
      expect(snapshotFor(h, orderId, who), who.pubkey).toMatchObject({
        orderId, state: 'listed', amountSat: AMOUNT, designatedSponsor: h.sponsor.pubkey,
      });
    }
    expect(snapshotFor(h, orderId, newKey())).toBeUndefined();

    const dms = h.relay.published.filter(e => e.kind === 1059).map(e => unwrapEvent(e, h.operator.secretKey).content);
    expect(dms).toContain(`[페어바이] 새 지정 거래 — 온체인 ${AMOUNT.toLocaleString('ko-KR')} sats (${orderId})`);
    // 지정 후원자에게 알림 — 오더북에 안 뜨니 이게 유일한 신호다
    expect(h.ln.db.get('SELECT key FROM notices WHERE key = ?', `oc:${orderId}:designated`)).toBeDefined();
  });

  it('최소 거래액은 종결 수수료 × 20 — 공개 의뢰 최소액보다 훨씬 낮다', async () => {
    const h = await createOcHarness();
    // 가짜 체인의 30분 수수료는 2 sat/vB
    const min = Math.ceil(TYPICAL_SETTLEMENT_VSIZE * 2) * 20;
    const below = await openDesignatedOc(h, { amountSat: min - 1 });
    expect(h.row(below)).toBeUndefined();
    expect(rejectionsTo(h, h.customer.pubkey).at(-1)).toMatch(/지정 거래 최소액은 6,760 sats/);
    const at = await openDesignatedOc(h, { amountSat: min });
    expect(state(h, at)).toBe('listed');
    // 같은 금액의 공개 의뢰는 보증금 근거의 최소액(≈ ×133)에 걸린다
    const pub = await openOc(h, { amountSat: min });
    expect(h.row(pub)).toBeUndefined();
  });

  it('자기 자신 지정 · 망가진 내용은 받지 않는다', async () => {
    const h = await createOcHarness();
    const self = await openDesignatedOc(h, { sponsor: h.customer.pubkey });
    expect(h.row(self)).toBeUndefined();
    expect(rejectionsTo(h, h.customer.pubkey).at(-1)).toMatch(/자기 자신/);

    const ev = ocRequest(h.customer, h.app.pubkey, 'brokenx1', REQUEST_ACTIONS.ONCHAIN_DESIGNATED_ORDER_REQUEST, h.sec(), [],
      'garbage', h.sec() + 86_400);
    await h.send(ev);
    // 못 여는 것은 두 트랙 다 `undecryptable`, 열었는데 모양이 틀리면 `bad-payload`(`decryptRequest`)
    expect(h.ln.db.get<{ outcome: string }>('SELECT outcome FROM inbox WHERE id = ?', ev.id)!.outcome).toBe('ignored:undecryptable');
  });
});

describe('지정 의뢰 — 맡기', () => {
  it('지정되지 않은 사람의 클레임은 거절한다', async () => {
    const h = await createOcHarness();
    const orderId = await openDesignatedOc(h);
    const troll = newKey();
    await claimOc(h, orderId, { sponsor: troll });
    expect(state(h, orderId)).toBe('listed');
    expect(rejectionsTo(h, troll.pubkey).at(-1)).toMatch(/지정된 상대만/);
    expect(h.node.holds.size).toBe(0);
  });

  it('지정 후원자 → 보증금 없이 bonded → 펀딩 컨펌에서 멈추지 않고 funded → 릴리스까지, LN 인보이스 0개', async () => {
    const h = await createOcHarness();
    const orderId = await openDesignatedOc(h);
    await claimOc(h, orderId);
    const bonded = h.row(orderId)!.order;
    expect(bonded.state).toBe('bonded');
    expect(bonded.escrowAddress).toBeDefined();
    expect(bonded.sponsorDepositHash).toBeUndefined();
    expect(ocMessagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)).toHaveLength(0);
    expect(snapshotFor(h, orderId, h.sponsor)?.escrowAddress).toBe(bonded.escrowAddress);

    // ⚠️ O-015 — 지정 거래엔 보증금이 없다. 건너뛰지 않으면 여기서 영원히 hold
    await fundOc(h, orderId);
    expect(state(h, orderId)).toBe('funded');

    await presignOc(h, orderId);
    await sendAccountOc(h, orderId);
    await remitOc(h, orderId);
    expect(state(h, orderId)).toBe('remitted');
    await cosignOc(h, orderId, h.customer, SK_C, 'release');
    await confirmSettlementOc(h, orderId);
    expect(state(h, orderId)).toBe('released');
    expect(snapshotFor(h, orderId, h.customer)?.state).toBe('released');

    expect(h.node.holds.size).toBe(0);
    expect(publicOrders(h, orderId)).toHaveLength(0);
    expect(forfeitAlerts(h, orderId)).toHaveLength(0);
  });

  it('후원자 이탈(사전서명 마감) → 환불, 몰수할 게 없으니 몰수 경보도 없다', async () => {
    const h = await createOcHarness();
    const orderId = await openDesignatedOc(h);
    await claimOc(h, orderId);
    await fundOc(h, orderId);
    h.advance(PRESIGN_WINDOW_SEC + 1);
    await h.run();
    const o = h.row(orderId)!.order;
    expect(o.state).toBe('refunding');
    expect(o.settlementKind).toBe('refund:sponsor-timeout');
    await cosignOc(h, orderId, h.customer, SK_C, 'refund');
    await confirmSettlementOc(h, orderId);
    expect(state(h, orderId)).toBe('refunded');
    expect(forfeitAlerts(h, orderId)).toHaveLength(0);
  });

  it('펀딩 마감 초과 → 취소, 몰수 경보 없음', async () => {
    const h = await createOcHarness();
    const orderId = await openDesignatedOc(h);
    await claimOc(h, orderId);
    h.advance(FUNDING_WINDOW_SEC + 1);
    await h.run();
    expect(state(h, orderId)).toBe('cancelled');
    expect(forfeitAlerts(h, orderId)).toHaveLength(0);
  });

  it('고객은 맡기 전에 취소할 수 있다', async () => {
    const h = await createOcHarness();
    const orderId = await openDesignatedOc(h);
    await h.send(ocRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.CANCEL_REQUEST, h.sec()));
    expect(state(h, orderId)).toBe('cancelled');
    expect(snapshotFor(h, orderId, h.sponsor)?.state).toBe('cancelled');
  });

  it('송금 주장까지 간 지정 거래도 공개 거래와 같은 길로 끝난다', async () => {
    const h = await createOcHarness();
    const orderId = await toRemittedDesignated(h);
    expect(state(h, orderId)).toBe('remitted');
    expect(publicOrders(h, orderId)).toHaveLength(0);
  });
});

describe('공개 거래는 그대로', () => {
  it('펀딩 마감 초과면 고객 보증금 몰수 + 몰수 경보', async () => {
    const h = await createOcHarness();
    const orderId = await openOc(h);
    await claimOc(h, orderId);
    h.advance(FUNDING_WINDOW_SEC + 1);
    await h.run();
    expect(state(h, orderId)).toBe('cancelled');
    expect(forfeitAlerts(h, orderId)).toHaveLength(1);
  });
});

const OFF_CURVE = '11'.repeat(32);

/** 이 사람에게 쌓인 웹 푸시 본문 — 보내기 전 평문이 효과 대기열에 있다 */
const pushBodiesTo = (h: OcHarness, pubkey: string) =>
  h.ln.db.all<{ payload: string }>('SELECT payload FROM effects WHERE kind = ?', PUSH_EFFECT)
    .map(r => JSON.parse(r.payload) as { pubkey: string; message: { body: string } })
    .filter(p => p.pubkey === pubkey)
    .map(p => p.message.body);

describe('곡선 밖 pubkey (2026-10-18 리뷰)', () => {
  it('곡선 밖 키를 지정한 요청은 받지 않는다', async () => {
    const h = await createOcHarness();
    const orderId = await openDesignatedOc(h, { sponsor: OFF_CURVE });
    expect(h.row(orderId)).toBeUndefined();
  });

  it('봉하지 못하는 수신자가 있어도 발행이 재시도에 갇히지 않는다 — 그 사람만 빼고 경보', async () => {
    const h = await createOcHarness();
    h.ln.db.tx(() => listOc(h.oc, {
      orderId: 'legacyoc', customer: h.customer.pubkey, designatedSponsor: OFF_CURVE,
      info: { amountSat: AMOUNT, expiration: h.sec() + 86_400, customerXonly: XC, refundAddress: REFUND },
    }));
    await h.run(4);
    expect(h.ln.effects.pendingCount(OC_ORDER_PUBLISH_EFFECT)).toBe(0);
    expect(snapshotFor(h, 'legacyoc', h.customer)?.state).toBe('listed');
    expect(openAlerts(h.ln).filter(a => a.orderId === 'legacyoc' && /봉하지 못해/.test(a.message))).toHaveLength(1);
  });
});

describe('스팸 억제 · 문구 (RISKS R-16)', () => {
  it(`고객 키 하나가 수락 대기 지정 의뢰를 ${MAX_OPEN_DESIGNATED_PER_CUSTOMER}개까지 — 넘으면 이유와 함께 거절`, async () => {
    const h = await createOcHarness();
    for (let i = 0; i < MAX_OPEN_DESIGNATED_PER_CUSTOMER; i++) expect(state(h, await openDesignatedOc(h))).toBe('listed');
    const over = await openDesignatedOc(h);
    expect(h.row(over)).toBeUndefined();
    expect(rejectionsTo(h, h.customer.pubkey).at(-1)).toMatch(/수락을 기다리는 지정 거래가 이미/);
    expect(state(h, await openDesignatedOc(h, { customer: newKey() }))).toBe('listed');
  });

  it('맡겨진 뒤 고객에게 가는 "입금하세요" 알림이 몰수를 말하지 않는다 — 공개 거래는 그대로 말한다', async () => {
    const h = await createOcHarness();
    await claimOc(h, await openDesignatedOc(h));
    const designated = pushBodiesTo(h, h.customer.pubkey).filter(b => /사는 사람이 정해졌습니다/.test(b));
    expect(designated).toHaveLength(1);
    expect(designated[0]).not.toMatch(/보증금|몰수/);

    const pub = await createOcHarness();
    await claimOc(pub, await openOc(pub));
    expect(pushBodiesTo(pub, pub.customer.pubkey).filter(b => /사는 사람이 정해졌습니다/.test(b))[0]).toMatch(/몰수/);
  });
});
