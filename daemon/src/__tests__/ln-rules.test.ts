/**
 * P3 라이트닝 — 보낸 사람·입력 검증, 지급 재시도(L-5), 운영자 명령(DM-006), 운영자 상세
 *
 * kind 1111은 누구나 서명해 쏠 수 있다. 여기 테스트들이 "남의 오더를 건드리는" 요청을 막는 줄이다.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTIONS, ADMIN_STATE_KIND, REQUEST_ACTIONS, adminOrderDTag, nip44Decrypt, nip44Encrypt, orderRef,
  type AdminChatCopy, type AdminLnOrderDetail,
} from '@sajwo-tracker/shared/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { openAlerts } from '../admin/alerts';
import { STUCK_EFFECT_ATTEMPTS } from '../ln/timing';
import { TEST_TAGS, adminCommand, eventsTo, newKey, openResult, type TestKey } from './fakes';
import { createLnHarness, lnRequest, makeInvoice, tagOf, type LnHarness } from './ln-fakes';
import {
  DAY, HOUR, cancel, claim, confirmPaid, messagesTo, openOrder, payEscrow, remit, sendAccount,
  setAutoApprove, submitInvoice, toRemitted,
} from './ln-helpers';

async function command(h: LnHarness, cmd: string, args: Record<string, unknown>, operator: TestKey = h.operator) {
  const event = adminCommand(operator, h.app.pubkey, TEST_TAGS.admin, { cmd, args }, h.sec());
  await h.send(event, 6);
  const result = eventsTo(h.relay, operator.pubkey, ADMIN_ACTIONS.RESULT).find(e => e.tags.some(t => t[0] === 'e' && t[1] === event.id));
  if (!result) throw new Error('결과가 안 왔다');
  return openResult(result, operator, h.app.pubkey) as { ok: boolean; result?: { version?: number }; error?: string };
}

const target = (h: LnHarness, orderId: string, version = h.order(orderId)!.version) => ({ track: 'ln', orderId, version });

function rejections(h: LnHarness, sponsor: TestKey) {
  return messagesTo(h, sponsor.pubkey, REQUEST_ACTIONS.CLAIM_PRICE_ERROR).map(e => ({
    reason: tagOf(e, 'reason'), expected: Number(tagOf(e, 'expected-sats')),
  }));
}

describe('의뢰 검증', () => {
  it('기한이 너무 가깝거나 멀거나, 금액·번호가 이상하면 받지 않는다', async () => {
    const h = await createLnHarness();
    await openOrder(h, { orderId: 'close1', deadlineIn: 30 * 60 });
    await openOrder(h, { orderId: 'far001', deadlineIn: 8 * DAY }); // CLTV가 결제자 상한을 넘는다
    await openOrder(h, { orderId: 'bad/id', deadlineIn: DAY });
    await openOrder(h, { orderId: 'zero01', price: 0 });
    for (const id of ['close1', 'far001', 'bad/id', 'zero01']) expect(h.order(id)).toBeUndefined();
    const outcomes = h.ln.db.all<{ outcome: string }>('SELECT outcome FROM inbox ORDER BY created_at').map(r => r.outcome);
    expect(outcomes).toEqual([
      'ignored:deadline-too-close', 'ignored:deadline-too-far', 'ignored:bad-order-id', 'ignored:bad-price',
    ]);
  });

  it('같은 번호는 먼저 온 것만 — 남의 번호를 선점해도 두 번째는 무시', async () => {
    const h = await createLnHarness();
    await openOrder(h, { orderId: 'dup001' });
    await openOrder(h, { orderId: 'dup001', customer: newKey(), price: 5 });
    expect(h.order('dup001')!.customer).toBe(h.customer.pubkey);
    expect(h.order('dup001')!.price).toBe(100_000);
  });

  /** 옛 유저 앱은 expiration = 쿠팡 기한이었다(DM-009) */
  it('deadline 태그가 없으면 expiration을 기한으로 읽는다', async () => {
    const h = await createLnHarness();
    const deadline = h.sec() + DAY;
    await h.send(finalizeEvent({
      kind: 1111, created_at: h.sec(),
      tags: [['a', orderRef(h.app.pubkey, 'old001')], ['action', 'order-request'], ['price', '50000', 'KRW'],
        ['t', TEST_TAGS.ln], ['p', h.app.pubkey], ['expiration', String(deadline)]],
      content: '',
    }, h.customer.secretKey));
    expect(h.order('old001')!.deadline).toBe(deadline);
  });
});

describe('보낸 사람 확인', () => {
  it('자기 주문 자기 클레임은 안 된다', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId, h.customer);
    expect(h.order(orderId)!.state).toBe('requested');
  });

  it('동시에 둘이 클레임하면 먼저 만든 쪽 — 뒤의 것은 무시', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    const late = newKey();
    h.relay.inject(lnRequest(late, h.app.pubkey, orderId, REQUEST_ACTIONS.CLAIM, h.sec() + 1));
    h.relay.inject(lnRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.CLAIM, h.sec()));
    await h.run();
    expect(h.order(orderId)!.sponsor).toBe(h.sponsor.pubkey);
  });

  it('후원자가 아니면 인보이스·송금 완료를, 고객이 아니면 입금 확인·취소·계좌를 못 한다', async () => {
    const h = await createLnHarness();
    const stranger = newKey();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);

    await submitInvoice(h, orderId, { from: stranger });
    await submitInvoice(h, orderId, { from: h.customer });
    expect(h.order(orderId)!.state).toBe('escrowed');

    await submitInvoice(h, orderId);
    await h.send(lnRequest(stranger, h.app.pubkey, orderId, REQUEST_ACTIONS.ACCOUNT_INFO, h.sec(), [['commitment', 'ab'.repeat(32)]]));
    expect(h.order(orderId)!.account_commitment).toBeNull();

    await remit(h, orderId, h.customer);
    await remit(h, orderId, stranger);
    expect(h.order(orderId)!.state).toBe('invoiced');

    await confirmPaid(h, orderId, h.sponsor);
    await confirmPaid(h, orderId, stranger);
    await cancel(h, orderId, stranger);
    expect(h.order(orderId)!.state).toBe('invoiced');
    expect(h.node.stateOf(h.order(orderId)!.escrow_hash!)).toBe('accepted');
  });

  /** I-009 — 계좌 관문은 invoiced부터 */
  it('invoiced 전에 온 계좌는 받지 않는다', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await sendAccount(h, orderId);
    expect(h.order(orderId)!.account_commitment).toBeNull();
  });
});

describe('후원자 인보이스 검증 (I-011)', () => {
  it('금액이 틀리면·짧으면·못 읽으면 거절 사유와 기대 금액을 돌려준다', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    const payout = h.order(orderId)!.payout_sat!;

    await submitInvoice(h, orderId, { amountSat: payout + 1 });
    await submitInvoice(h, orderId, { expirySec: HOUR });
    await h.send(lnRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.SPONSOR_INVOICE, h.sec(), [['bolt11', 'lnbc1garbage']]));
    expect(h.order(orderId)!.state).toBe('escrowed');
    expect(rejections(h, h.sponsor)).toEqual([
      { reason: 'AMOUNT_MISMATCH', expected: payout },
      { reason: 'EXPIRES_TOO_SOON', expected: payout },
      { reason: 'DECODE_FAILED', expected: payout },
    ]);
  });

  /** 우리 돈으로 우리 홀드를 채우는 경로 */
  it('우리 에스크로 인보이스를 지급처로 내밀면 무시한다', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    const ours = h.order(orderId)!.escrow_bolt11!;
    const ev = lnRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.SPONSOR_INVOICE, h.sec(), [['bolt11', ours]]);
    await h.send(ev);
    expect(h.order(orderId)!.state).toBe('escrowed');
    // 금액 불일치보다 먼저 걸러야 한다 — 금액이 맞는 우리 인보이스(보증금 등)도 있을 수 있다
    expect(h.ln.db.get<{ outcome: string }>('SELECT outcome FROM inbox WHERE id = ?', ev.id)!.outcome).toBe('ignored:our-invoice');
  });

  it('닿지 않는 인보이스는 받되 경고한다 (프로빙은 막지 않는다)', async () => {
    const h = await createLnHarness();
    h.node.probeResult = 'unreachable';
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    expect(h.order(orderId)!.state).toBe('invoiced');
    expect(rejections(h, h.sponsor).map(r => r.reason)).toEqual(['LIQUIDITY_WARNING']);
  });

  it('invoiced에서 다시 내면 교체된다 — 상태는 그대로', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    const second = await submitInvoice(h, orderId);
    expect(h.order(orderId)!.sponsor_invoice).toBe(second);
    expect(h.order(orderId)!.state).toBe('invoiced');
  });
});

describe('지급 (L-5)', () => {
  it('지급 전에 인보이스가 만료되면 재제출을 요청하고, 재제출하면 지급된다', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId, { expirySec: 6 * HOUR + 60 });
    h.advance(7 * HOUR);
    await confirmPaid(h, orderId);

    let o = h.order(orderId)!;
    expect(o.state).toBe('paid');
    expect(o.disbursed).toBe(0);
    expect(o.payout_error).toBe('invoice-expired');
    expect(rejections(h, h.sponsor).map(r => r.reason)).toContain('EXPIRED_BEFORE_PAYOUT');
    expect(h.node.payments.size).toBe(0);

    // paid인데 아직 안 나갔으니 재제출을 받는다 — 짧은 인보이스여도 바로 쓰이니 괜찮다
    await submitInvoice(h, orderId, { expirySec: 30 * 60 });
    o = h.order(orderId)!;
    expect(o.disbursed).toBe(1);
    expect(o.payout_error).toBeNull();
  });

  it('지급 실패는 계속 다시 하고, 오래 실패하면 경보 — 운영자가 앞당길 수 있다', async () => {
    const h = await createLnHarness();
    h.node.payResult = () => ({ status: 'failed', failureReason: 'FAILURE_REASON_NO_ROUTE' });
    const orderId = await toRemitted(h);
    await confirmPaid(h, orderId);
    expect(h.order(orderId)!.payout_error).toBe('FAILURE_REASON_NO_ROUTE');

    for (let i = 0; i < STUCK_EFFECT_ATTEMPTS + 1; i++) {
      h.advance(11 * 60);
      await h.run(1);
    }
    expect(openAlerts(h.ln).some(a => a.orderId === orderId && /ln\.payout/.test(a.message))).toBe(true);

    // 경로가 생겼다 — 백오프를 기다리지 않고 지금
    h.node.payResult = () => ({ status: 'succeeded' });
    const r = await command(h, 'ln.retry-payout', { target: target(h, orderId) });
    expect(r.ok).toBe(true);
    expect(h.order(orderId)!.disbursed).toBe(1);
    // 성공한 뒤엔 다시 못 한다
    expect(await command(h, 'ln.retry-payout', { target: target(h, orderId) })).toMatchObject({ error: 'already-disbursed' });
  });

  it('지급이 이미 나간 뒤의 인보이스 재제출은 받지 않는다', async () => {
    const h = await createLnHarness();
    const orderId = await toRemitted(h);
    await confirmPaid(h, orderId);
    const before = h.order(orderId)!.sponsor_invoice;
    await submitInvoice(h, orderId);
    expect(h.order(orderId)!.sponsor_invoice).toBe(before);
  });
});

describe('운영자 명령 (DM-006)', () => {
  it('낡은 버전의 판정은 거절된다 — 다른 기기에서 이미 바뀌었다', async () => {
    const h = await createLnHarness({ operators: 2 });
    const orderId = await toRemitted(h);
    const stale = h.order(orderId)!.version;
    await sendAccount(h, orderId); // 계좌가 바뀌어 버전이 올랐다
    const [a, b] = h.operators as [TestKey, TestKey];

    expect(await command(h, 'ln.rule', { target: target(h, orderId, stale), winner: 'customer' }, a))
      .toMatchObject({ ok: false, error: 'stale-version' });
    expect(h.order(orderId)!.state).toBe('remitted');

    const ok = await command(h, 'ln.rule', { target: target(h, orderId), winner: 'customer' }, b);
    expect(ok.ok).toBe(true);
    expect(h.order(orderId)!.state).toBe('customer_wins');
    // 같은 판정을 다른 기기에서 다시 눌러도(그 버전으로) 두 번 집행되지 않는다
    expect(await command(h, 'ln.rule', { target: target(h, orderId, ok.result!.version), winner: 'customer' }, a))
      .toMatchObject({ ok: false });
  });

  it('고객 승 → 에스크로 환불 · 후원자 보증금 몰수', async () => {
    const h = await createLnHarness();
    const { setDeposits } = await import('./ln-helpers');
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h);
    await claim(h, orderId);
    h.node.pay(tagOf(messagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!);
    await h.run();
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    await sendAccount(h, orderId);
    await remit(h, orderId);
    const o = h.order(orderId)!;

    expect((await command(h, 'ln.rule', { target: target(h, orderId), winner: 'customer' })).ok).toBe(true);
    expect(h.node.stateOf(o.escrow_hash!)).toBe('cancelled');
    expect(h.node.stateOf(o.sponsor_deposit_hash!)).toBe('settled');
    expect(h.order(orderId)!.close_reason).toBe('customer_wins');
  });

  it('판정은 송금 완료 뒤에만, 강제 종결은 escrowed·invoiced에서만', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    expect(await command(h, 'ln.rule', { target: target(h, orderId), winner: 'sponsor' })).toMatchObject({ error: 'bad-state' });
    expect(await command(h, 'ln.force-close', { target: target(h, orderId) })).toMatchObject({ error: 'bad-state' });
    await payEscrow(h, orderId);
    expect((await command(h, 'ln.force-close', { target: target(h, orderId) })).ok).toBe(true);
    expect(h.order(orderId)!.state).toBe('admin_closed');
    expect(h.node.stateOf(h.order(orderId)!.escrow_hash!)).toBe('cancelled');
  });

  it('자동 승인을 끄면 명령으로 승인한다 · 클레임 되돌리기', async () => {
    const h = await createLnHarness();
    setAutoApprove(h, false);
    const orderId = await openOrder(h);
    await claim(h, orderId);
    expect(h.order(orderId)!.state).toBe('claimed');

    expect((await command(h, 'ln.revert-claim', { target: target(h, orderId) })).ok).toBe(true);
    expect(h.order(orderId)!.state).toBe('requested');
    expect(h.order(orderId)!.sponsor).toBeNull();

    await claim(h, orderId);
    expect((await command(h, 'ln.approve', { target: target(h, orderId) })).ok).toBe(true);
    expect(h.order(orderId)!.state).toBe('verified');
  });

  it('시세가 없으면 승인하지 않는다 — 금액이 틀리면 돈이 틀린다', async () => {
    const h = await createLnHarness();
    h.price.value = null;
    const orderId = await openOrder(h);
    await claim(h, orderId);
    expect(h.order(orderId)!.state).toBe('claimed');
    expect(await command(h, 'ln.approve', { target: target(h, orderId) })).toMatchObject({ error: 'no-price' });

    h.price.value = 140_000_000;
    await h.run();
    expect(h.order(orderId)!.state).toBe('verified');
  });

  it('비운영자 명령은 무시된다', async () => {
    const h = await createLnHarness();
    const orderId = await toRemitted(h);
    const intruder = newKey();
    h.relay.inject(adminCommand(intruder, h.app.pubkey, TEST_TAGS.admin, {
      cmd: 'ln.rule', args: { target: target(h, orderId), winner: 'customer' },
    }, h.sec()));
    await h.run();
    expect(h.order(orderId)!.state).toBe('remitted');
  });
});

describe('운영자 상세 · 채팅', () => {
  it('운영자마다 상세가 가고, 버전·인보이스 상태·커밋먼트가 실린다', async () => {
    const h = await createLnHarness({ operators: 2 });
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    await sendAccount(h, orderId, 'cd'.repeat(32));

    for (const op of h.operators) {
      const d = adminOrderDTag(TEST_TAGS.admin, 'ln', orderId, op.pubkey);
      const ev = h.relay.published.filter(e => e.kind === ADMIN_STATE_KIND && e.tags.some(t => t[0] === 'd' && t[1] === d))
        .sort((a, b) => a.created_at - b.created_at).at(-1)!;
      const detail = JSON.parse(nip44Decrypt(ev.content, op.secretKey, h.app.pubkey)) as AdminLnOrderDetail;
      expect(detail).toMatchObject({
        orderId, state: 'invoiced', version: h.order(orderId)!.version, accountCommitment: 'cd'.repeat(32),
      });
      expect(detail.invoices).toEqual([expect.objectContaining({ purpose: 'escrow', status: 'accepted' })]);
    }
  });

  it('라이트닝 오더의 당사자 채팅이 운영자에게 중계된다 (오더 목록이 ln_orders를 본다)', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    const msg = finalizeEvent({
      kind: 1111, created_at: h.sec(),
      tags: [['a', orderRef(h.app.pubkey, orderId)], ['action', REQUEST_ACTIONS.DISPUTE_MESSAGE], ['t', TEST_TAGS.ln],
        ['p', h.app.pubkey], ['p', h.sponsor.pubkey]],
      content: nip44Encrypt(JSON.stringify({ type: 'text', content: '송금했어요' }), h.sponsor.secretKey, h.app.pubkey),
    }, h.sponsor.secretKey);
    await h.send(msg);
    const copies = eventsTo(h.relay, h.operator.pubkey, ADMIN_ACTIONS.CHAT)
      .map(e => JSON.parse(nip44Decrypt(e.content, h.operator.secretKey, h.app.pubkey)) as AdminChatCopy);
    expect(copies).toMatchObject([{ orderId, role: 'sponsor', payload: { content: '송금했어요' } }]);
  });
});

describe('릴레이가 실패해도', () => {
  it('오더 발행은 다시 해서 결국 최신 상태가 나간다', async () => {
    const h = await createLnHarness();
    h.relay.failWhen = e => e.kind === 30402;
    h.relay.failNext = 3;
    const orderId = await openOrder(h);
    await claim(h, orderId);
    for (let i = 0; i < 3; i++) { // 백오프 5·10·20초
      h.advance(60);
      await h.run(1);
    }
    const { latestOrderEvent } = await import('./ln-fakes');
    expect(tagOf(latestOrderEvent(h.relay.published, orderId), 'state')).toBe('verified');
  });

  it('같은 요청이 두 번 와도 한 번만 처리한다', async () => {
    const h = await createLnHarness();
    h.relay.duplicateDelivery = true;
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    const { bolt11 } = makeInvoice({ amountSat: h.order(orderId)!.payout_sat!, timestamp: h.sec(), expirySec: 7 * HOUR });
    const ev = lnRequest(h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.SPONSOR_INVOICE, h.sec(), [['bolt11', bolt11]]);
    await h.send(ev);
    await h.send(ev);
    expect(h.ln.db.all('SELECT id FROM inbox WHERE id = ?', ev.id)).toHaveLength(1);
    expect(h.order(orderId)!.state).toBe('invoiced');
  });
});
