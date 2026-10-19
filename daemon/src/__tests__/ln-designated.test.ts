/**
 * 라이트닝 지정 거래 — 상대를 pubkey로 묶은, 보증금 없는 1:1 거래 (docs/LN-TRACK.md §7)
 *
 * 지켜야 할 것: ① 지정된 후원자만 맡는다 ② 보증금이 없다(운영 설정과 무관) ③ **공개 오더로 나가지 않는다** —
 * 고객 · 지정 후원자 · 운영자에게만 암호문 스냅샷으로 간다 ④ 나머지 흐름은 공개 거래와 같다.
 */
import { describe, expect, it } from 'vitest';
import { unwrapEvent } from 'nostr-tools/nip17';
import {
  DESIGNATED_ORDER_KIND, MAX_OPEN_DESIGNATED_PER_CUSTOMER, ORDER_KIND, REQUEST_ACTIONS, designatedOrderD, nip44Encrypt,
  openDesignatedOrder,
} from '@sajwo-tracker/shared/core';
import { openAlerts } from '../admin/alerts';
import { LN_ORDER_PUBLISH_EFFECT, insertOrder } from '../ln/store';
import { DESIGNATED_QUIET_SEC, operatorsChanged } from '../orders/designated';
import { parseLnOrderEvent } from '@sajwo-tracker/shared/ln';
import { newKey, type TestKey } from './fakes';
import { createLnHarness, lnRequest, type LnHarness } from './ln-fakes';
import {
  DAY, claim, confirmPaid, payEscrow, remit, sendAccount, setAutoApprove, setDeposits, submitInvoice,
} from './ln-helpers';

let seq = 0;

/** 고객이 지정 의뢰를 올린다 (기본: 10만 원, 기한 2일 뒤, 상대 = h.sponsor) */
async function openDesignated(
  h: LnHarness,
  opts: { price?: number; deadlineIn?: number; sponsor?: string; customer?: TestKey } = {},
): Promise<string> {
  const orderId = `dsg${(seq++).toString(36)}x${Date.now().toString(36).slice(-4)}`;
  const customer = opts.customer ?? h.customer;
  const payload = {
    price: opts.price ?? 100_000,
    deadline: h.sec() + (opts.deadlineIn ?? 2 * DAY),
    designatedSponsor: opts.sponsor ?? h.sponsor.pubkey,
  };
  await h.send(lnRequest(customer, h.app.pubkey, orderId, REQUEST_ACTIONS.DESIGNATED_ORDER_REQUEST, h.sec(), [],
    nip44Encrypt(JSON.stringify(payload), customer.secretKey, h.app.pubkey)));
  return orderId;
}

/** 이 수신자에게 간 가장 최근 스냅샷을 열어 오더로 */
function snapshotFor(h: LnHarness, orderId: string, who: TestKey) {
  const event = h.relay.published
    .filter(e => e.kind === DESIGNATED_ORDER_KIND && e.tags.some(t => t[0] === 'd' && t[1] === designatedOrderD(orderId, who.pubkey)))
    .sort((a, b) => a.created_at - b.created_at)
    .at(-1);
  if (!event) return undefined;
  const opened = openDesignatedOrder(event, who.secretKey, h.app.pubkey);
  return opened ? parseLnOrderEvent(opened, h.app.pubkey) : null;
}

const publicOrders = (h: LnHarness, orderId: string) =>
  h.relay.published.filter(e => e.kind === ORDER_KIND && e.tags.some(t => t[0] === 'd' && t[1] === orderId));

const outcomeOf = (h: LnHarness, id: string) =>
  h.ln.db.get<{ outcome: string }>('SELECT outcome FROM inbox WHERE id = ?', id)?.outcome;

describe('지정 의뢰 — 만들기', () => {
  it('고객 보증금이 켜져 있어도 초안 없이 바로 오더가 된다', async () => {
    const h = await createLnHarness();
    setDeposits(h, 5, 5);
    const orderId = await openDesignated(h);
    const o = h.order(orderId)!;
    expect(o.state).toBe('requested');
    expect(o.designated_sponsor).toBe(h.sponsor.pubkey);
    expect(o.customer_deposit_hash).toBeNull();
    expect(h.ln.db.all('SELECT * FROM ln_drafts')).toHaveLength(0);
    expect(h.node.holds.size).toBe(0);
  });

  it('공개 오더로는 하나도 안 나가고, 고객 · 지정 후원자 · 운영자에게 스냅샷이 하나씩 간다', async () => {
    const h = await createLnHarness({ operators: 2 });
    const orderId = await openDesignated(h, { price: 32_900 });
    expect(publicOrders(h, orderId)).toHaveLength(0);

    for (const who of [h.customer, h.sponsor, ...h.operators]) {
      const order = snapshotFor(h, orderId, who);
      expect(order, who.pubkey).toMatchObject({
        orderId, state: 'requested', price: 32_900, designatedSponsor: h.sponsor.pubkey, customerPubkey: h.customer.pubkey,
      });
    }
    // 수신자가 아닌 사람 — 자기 d가 없고, 남의 스냅샷은 못 연다
    const stranger = newKey();
    expect(snapshotFor(h, orderId, stranger)).toBeUndefined();
    const others = h.relay.published.filter(e => e.kind === DESIGNATED_ORDER_KIND);
    expect(others.every(e => openDesignatedOrder(e, stranger.secretKey, h.app.pubkey) === null)).toBe(true);
    // 바깥에 금액이 보이지 않는다
    expect(others.every(e => !JSON.stringify(e).includes('32900'))).toBe(true);
  });

  it('운영자 DM은 "새 지정 거래"', async () => {
    const h = await createLnHarness();
    const orderId = await openDesignated(h, { price: 32_900 });
    const dms = h.relay.published
      .filter(e => e.kind === 1059)
      .map(e => unwrapEvent(e, h.operator.secretKey).content);
    expect(dms).toContain(`[페어바이] 새 지정 거래 — 라이트닝 32,900원 (${orderId})`);
  });

  it('자기 자신 지정 · 망가진 내용 · 범위 밖 조건은 받지 않는다', async () => {
    const h = await createLnHarness();
    const send = async (content: string, orderId: string) => {
      const ev = lnRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.DESIGNATED_ORDER_REQUEST, h.sec(), [], content);
      await h.send(ev);
      return outcomeOf(h, ev.id);
    };
    const enc = (v: unknown) => nip44Encrypt(JSON.stringify(v), h.customer.secretKey, h.app.pubkey);
    const deadline = h.sec() + 2 * DAY;
    expect(await send(enc({ price: 1000, deadline, designatedSponsor: h.customer.pubkey }), 'selfx1'))
      .toBe('ignored:self-designated');
    expect(await send('garbage', 'brokn1')).toBe('ignored:undecryptable');
    expect(await send(enc({ price: 1000, deadline }), 'nospn1')).toBe('ignored:bad-payload');
    expect(await send(enc({ price: -1, deadline, designatedSponsor: h.sponsor.pubkey }), 'badpr1'))
      .toBe('ignored:bad-price');
    expect(await send(enc({ price: 1000, deadline: h.sec() + 60, designatedSponsor: h.sponsor.pubkey }), 'close1'))
      .toBe('ignored:deadline-too-close');
    expect(h.ln.db.all('SELECT * FROM ln_orders')).toHaveLength(0);
  });
});

describe('지정 의뢰 — 맡기', () => {
  it('지정되지 않은 사람의 클레임은 무시한다', async () => {
    const h = await createLnHarness();
    const orderId = await openDesignated(h);
    const troll = newKey();
    const ev = lnRequest(troll, h.app.pubkey, orderId, REQUEST_ACTIONS.CLAIM, h.sec());
    await h.send(ev);
    expect(outcomeOf(h, ev.id)).toBe('ignored:not-designated');
    expect(h.order(orderId)!.state).toBe('requested');
  });

  it('지정 후원자 클레임 — 자동 승인이 꺼져 있고 보증금이 켜져 있어도 바로 승인, 보증금 없음', async () => {
    const h = await createLnHarness();
    setDeposits(h, 5, 5);
    setAutoApprove(h, false);
    const orderId = await openDesignated(h);
    await claim(h, orderId);
    const o = h.order(orderId)!;
    expect(o.state).toBe('verified');
    expect(o.sponsor).toBe(h.sponsor.pubkey);
    expect(o.sponsor_deposit_hash).toBeNull();
    // 홀드는 에스크로 하나뿐
    expect([...h.node.holds.values()]).toHaveLength(1);
    const snap = snapshotFor(h, orderId, h.sponsor)!;
    expect(snap.state).toBe('verified');
    expect(snap.sponsorDepositPending).toBeUndefined();
  });

  it('정상 흐름으로 paid까지 — 그동안 공개 오더는 한 번도 안 나간다', async () => {
    const h = await createLnHarness();
    const orderId = await openDesignated(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    expect(h.order(orderId)!.state).toBe('escrowed');
    expect(snapshotFor(h, orderId, h.sponsor)!.invoiceDeadline).toBe(h.order(orderId)!.invoice_deadline);
    await submitInvoice(h, orderId);
    await sendAccount(h, orderId);
    await remit(h, orderId);
    await confirmPaid(h, orderId);
    const o = h.order(orderId)!;
    expect(o.state).toBe('paid');
    expect(o.disbursed).toBe(1);
    expect(snapshotFor(h, orderId, h.customer)!.state).toBe('paid');
    expect(snapshotFor(h, orderId, h.operator)!.state).toBe('paid');
    expect(publicOrders(h, orderId)).toHaveLength(0);
  });

  it('고객은 맡기 전에 취소할 수 있다', async () => {
    const h = await createLnHarness();
    const orderId = await openDesignated(h);
    await h.send(lnRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.CANCEL_REQUEST, h.sec()));
    expect(h.order(orderId)!.state).toBe('cancelled');
    expect(snapshotFor(h, orderId, h.sponsor)!.state).toBe('cancelled');
  });
});

describe('공개 거래는 그대로', () => {
  it('후원자 보증금이 켜져 있으면 공개 클레임은 여전히 보증금을 낸다', async () => {
    const h = await createLnHarness();
    setDeposits(h, 0, 5);
    const { openOrder } = await import('./ln-helpers');
    const orderId = await openOrder(h);
    await claim(h, orderId);
    const o = h.order(orderId)!;
    expect(o.state).toBe('claimed');
    expect(h.ln.holds.current('ln-sponsor-deposit', orderId, h.sponsor.pubkey)).toBeDefined();
    expect(publicOrders(h, orderId).length).toBeGreaterThan(0);
  });
});

describe('알림', () => {
  it('지정 의뢰가 생기면 지정 후원자에게 웹 푸시가 한 번 간다', async () => {
    const h = await createLnHarness();
    const sub = {
      endpoint: 'https://push.example/sponsor',
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    };
    await h.send(lnRequest(h.sponsor, h.app.pubkey, null, REQUEST_ACTIONS.PUSH_SUBSCRIPTION, h.sec(), [],
      nip44Encrypt(JSON.stringify(sub), h.sponsor.secretKey, h.app.pubkey)));
    expect(h.push.sent).toHaveLength(1); // 등록 확인
    await openDesignated(h);
    expect(h.push.sent).toHaveLength(2);
    await h.run(4);
    expect(h.push.sent).toHaveLength(2);
  });
});

/** 곡선 밖 x — 64자 hex지만 pubkey가 아니다. 무작위 64-hex의 절반쯤이 이렇다(txid·이벤트 id를 붙여넣은 경우) */
const OFF_CURVE = '11'.repeat(32);

const dmsTo = (h: LnHarness, pattern: RegExp) => h.relay.published
  .filter(e => e.kind === 1059)
  .map(e => unwrapEvent(e, h.operator.secretKey).content)
  .filter(text => pattern.test(text));

describe('곡선 밖 pubkey (2026-10-18 리뷰)', () => {
  it('곡선 밖 키를 지정한 요청은 받지 않는다 — 행이 안 생긴다', async () => {
    const h = await createLnHarness();
    const ev = lnRequest(h.customer, h.app.pubkey, 'offcrv1', REQUEST_ACTIONS.DESIGNATED_ORDER_REQUEST, h.sec(), [],
      nip44Encrypt(JSON.stringify({ price: 1000, deadline: h.sec() + 2 * DAY, designatedSponsor: OFF_CURVE }),
        h.customer.secretKey, h.app.pubkey));
    await h.send(ev);
    expect(outcomeOf(h, ev.id)).toBe('ignored:bad-payload');
    expect(h.order('offcrv1')).toBeUndefined();
  });

  it('봉하지 못하는 수신자가 있어도 발행이 재시도에 갇히지 않는다 — 그 사람만 빼고 경보', async () => {
    const h = await createLnHarness();
    // 검사가 조여지기 전에 들어온 행을 흉내 낸다
    h.ln.db.tx(() => insertOrder(h.ln, {
      orderId: 'legacy1', customer: h.customer.pubkey, price: 1000, deadline: h.sec() + 2 * DAY, designatedSponsor: OFF_CURVE,
    }));
    await h.run(4);
    expect(h.ln.effects.pendingCount(LN_ORDER_PUBLISH_EFFECT)).toBe(0);
    expect(snapshotFor(h, 'legacy1', h.customer)?.state).toBe('requested');
    expect(snapshotFor(h, 'legacy1', h.operator)?.state).toBe('requested');
    expect(openAlerts(h.ln).filter(a => a.orderId === 'legacy1' && /봉하지 못해/.test(a.message))).toHaveLength(1);
  });
});

describe('스팸 억제 — 보증금이 없어 공짜다 (RISKS R-16)', () => {
  it(`고객 키 하나가 수락 대기 지정 의뢰를 ${MAX_OPEN_DESIGNATED_PER_CUSTOMER}개까지 — 수락되거나 내리면 다시 된다`, async () => {
    const h = await createLnHarness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_DESIGNATED_PER_CUSTOMER; i++) ids.push(await openDesignated(h));
    expect(ids.every(id => h.order(id)?.state === 'requested')).toBe(true);
    const over = await openDesignated(h);
    expect(h.order(over)).toBeUndefined();
    expect(h.ln.db.all<{ outcome: string }>('SELECT outcome FROM inbox ORDER BY created_at').at(-1)!.outcome)
      .toBe('ignored:too-many-designated');

    await claim(h, ids[0]!); // 수락되면 더 이상 "대기"가 아니다
    expect(h.order(await openDesignated(h))?.state).toBe('requested');
    // 다른 고객 키는 따로 센다
    expect(h.order(await openDesignated(h, { customer: newKey() }))?.state).toBe('requested');
  });

  it('지정 대상에게 가는 도착 푸시와 운영자 DM은 조용한 창에 한 번 — 놓친 건 목록에 있다', async () => {
    const h = await createLnHarness();
    const sub = {
      endpoint: 'https://push.example/sponsor',
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    };
    await h.send(lnRequest(h.sponsor, h.app.pubkey, null, REQUEST_ACTIONS.PUSH_SUBSCRIPTION, h.sec(), [],
      nip44Encrypt(JSON.stringify(sub), h.sponsor.secretKey, h.app.pubkey)));
    const before = h.push.sent.length;
    // 키를 바꿔 가며 쏟아부어도
    for (let i = 0; i < 3; i++) await openDesignated(h, { customer: newKey() });
    expect(h.push.sent.length - before).toBe(1);
    expect(dmsTo(h, /새 지정 거래/)).toHaveLength(1);

    h.advance(DESIGNATED_QUIET_SEC);
    await openDesignated(h, { customer: newKey() });
    expect(h.push.sent.length - before).toBe(2);
    expect(dmsTo(h, /새 지정 거래/)).toHaveLength(2);
  });
});

describe('운영자가 바뀌면 (2026-10-18 리뷰)', () => {
  /** 스냅샷은 발행할 때의 운영자에게만 간다 — 부팅 때 목록이 바뀌었으면 트랙이 지정 거래 스냅샷을 다시 낸다 */
  it('부팅 때 운영자 목록이 지난번과 다르면 한 번만 참', async () => {
    const h = await createLnHarness();
    expect(operatorsChanged(h.ln, 'ln')).toBe(false); // 이번 부팅에 이미 적었다
    const more = { db: h.ln.db, operators: [...h.ln.operators, newKey().pubkey] };
    expect(operatorsChanged(more, 'ln')).toBe(true);
    expect(operatorsChanged(more, 'ln')).toBe(false);
    expect(operatorsChanged({ db: h.ln.db, operators: [...more.operators].reverse() }, 'ln')).toBe(false); // 순서는 무관
  });
});
