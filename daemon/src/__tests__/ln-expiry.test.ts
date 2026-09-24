/**
 * P3 라이트닝 — 기한·만기·닫기 사유 (PLAN-DAEMON §7 L-2·L-3·L-6, §14 D4)
 *
 * 기한 = 쿠팡 가상계좌 기한. 그 뒤로는 원화가 갈 수 없으므로 `remitted` 전이면 닫는다. 닫는 사유가
 * 곧 에스크로·보증금 처리다(`CLOSE_RULES`).
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ACTIONS, REQUEST_ACTIONS } from '@sajwo-tracker/shared/core';
import { openAlerts } from '../admin/alerts';
import { beginClose } from '../ln/flow';
import { DEADLINE_GRACE_SEC, ESCROW_END_BLOCKS, SAFETY_SETTLE_BLOCKS } from '../ln/timing';
import { TEST_TAGS, adminCommand, eventsTo, openResult } from './fakes';
import { createLnHarness, latestOrderEvent, tagOf, type LnHarness } from './ln-fakes';
import {
  DAY, HOUR, cancel, claim, confirmPaid, messagesTo, openOrder, payEscrow, remit, sendAccount, setDeposits,
  submitInvoice, toRemitted,
} from './ln-helpers';

/** 뜬 지 2분이 지나야 기한으로 닫는다 — 테스트는 처음부터 워밍업을 넘겨 둔다 */
async function warmHarness(): Promise<LnHarness> {
  const h = await createLnHarness();
  h.advance(5 * 60);
  return h;
}

function payDepositOf(h: LnHarness, who: 'customer' | 'sponsor'): void {
  const key = who === 'customer' ? h.customer : h.sponsor;
  const required = messagesTo(h, key.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED).at(-1);
  h.node.pay(tagOf(required, 'bolt11')!);
}

function escrowExpiryHeight(h: LnHarness, orderId: string): number {
  return h.ln.db.get<{ h: number }>(
    'SELECT htlc_expiry_height AS h FROM ln_invoices WHERE payment_hash = ?', h.order(orderId)!.escrow_hash!,
  )!.h;
}

describe('쿠팡 기한 (L-2) — 사유가 곧 처리', () => {
  it('후원자가 안 붙은 채 기한 → expired, 고객 보증금 환불', async () => {
    const h = await warmHarness();
    setDeposits(h, 2, 0);
    const orderId = await openOrder(h, { deadlineIn: 3 * HOUR });
    payDepositOf(h, 'customer');
    await h.run();
    const dep = h.order(orderId)!.customer_deposit_hash!;

    h.advance(3 * HOUR + 60);
    await h.run();
    const o = h.order(orderId)!;
    expect(o.state).toBe('expired');
    expect(o.close_reason).toBe('expired:no-sponsor');
    expect(h.node.stateOf(dep)).toBe('cancelled');
    const ev = latestOrderEvent(h.relay.published, orderId)!;
    expect(tagOf(ev, 'state')).toBe('expired');
    // 종결은 일주일 더 보존 — 기한이 지났어도 릴레이가 받는다
    expect(Number(tagOf(ev, 'expiration'))).toBeGreaterThan(h.sec() + 6 * DAY);
  });

  it('승인 뒤 에스크로를 안 내면 → cancelled, 고객 보증금 몰수 · 후원자 보증금 환불', async () => {
    const h = await warmHarness();
    setDeposits(h, 2, 3);
    const orderId = await openOrder(h, { deadlineIn: 2 * DAY });
    payDepositOf(h, 'customer');
    await h.run();
    await claim(h, orderId);
    payDepositOf(h, 'sponsor');
    await h.run();
    const o = h.order(orderId)!;
    expect(o.state).toBe('verified');

    h.advance(24 * HOUR + 120); // 결제 창 24시간
    await h.run(6);
    const closed = h.order(orderId)!;
    expect(closed.state).toBe('cancelled');
    expect(closed.close_reason).toBe('cancel:unpaid-escrow');
    expect(h.node.stateOf(o.customer_deposit_hash!)).toBe('settled');
    expect(h.node.stateOf(o.sponsor_deposit_hash!)).toBe('cancelled');
    expect(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_SETTLED)).toHaveLength(1);
  });

  it('에스크로 뒤 인보이스를 끝내 안 내면(escrowed) → 유예 뒤 expired, 에스크로 환불 · 후원자 보증금 몰수 (D4)', async () => {
    const h = await warmHarness();
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h, { deadlineIn: 6 * HOUR });
    await claim(h, orderId);
    payDepositOf(h, 'sponsor');
    await h.run();
    await payEscrow(h, orderId);
    const o = h.order(orderId)!;
    expect(o.state).toBe('escrowed');

    // 기한은 지났지만 유예 안 — 아직 안 닫는다
    h.advance(6 * HOUR + 60);
    await h.run();
    expect(h.order(orderId)!.state).toBe('escrowed');

    h.advance(DEADLINE_GRACE_SEC);
    await h.run(6);
    const closed = h.order(orderId)!;
    expect(closed.state).toBe('expired');
    expect(closed.close_reason).toBe('expired:no-invoice');
    expect(h.node.stateOf(o.escrow_hash!)).toBe('cancelled'); // 고객 환불
    expect(h.node.stateOf(o.sponsor_deposit_hash!)).toBe('settled'); // 몰수
  });

  it('계좌까지 나간 뒤(invoiced) 기한 → expired:no-remit, 양쪽 다 돌려준다 (D4)', async () => {
    const h = await warmHarness();
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h, { deadlineIn: 6 * HOUR });
    await claim(h, orderId);
    payDepositOf(h, 'sponsor');
    await h.run();
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    await sendAccount(h, orderId);
    const o = h.order(orderId)!;

    h.advance(6 * HOUR + DEADLINE_GRACE_SEC + 60);
    await h.run(6);
    expect(h.order(orderId)!.close_reason).toBe('expired:no-remit');
    expect(h.node.stateOf(o.escrow_hash!)).toBe('cancelled');
    expect(h.node.stateOf(o.sponsor_deposit_hash!)).toBe('cancelled');
  });

  /** 기한 직전에 송금하고 버튼이 늦는 경우 */
  it('유예 안에 누른 송금 완료는 받는다 — 그 뒤로는 기한이 닫지 않는다', async () => {
    const h = await warmHarness();
    const orderId = await openOrder(h, { deadlineIn: 6 * HOUR });
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    await sendAccount(h, orderId);

    h.advance(6 * HOUR + 30 * 60);
    await remit(h, orderId);
    expect(h.order(orderId)!.state).toBe('remitted');

    h.advance(DAY);
    await h.run();
    expect(h.order(orderId)!.state).toBe('remitted'); // 분쟁 판정으로만 끝난다
    expect(openAlerts(h.ln).some(a => a.orderId === orderId && /고객 확인이 오래 없다/.test(a.message))).toBe(true);
  });

  it('유예가 지난 뒤 만든 송금 완료는 받지 않는다', async () => {
    const h = await warmHarness();
    const orderId = await openOrder(h, { deadlineIn: 6 * HOUR });
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    const deadline = h.order(orderId)!.deadline;
    // 데몬이 잠깐 늦어 아직 안 닫았는데, 요청은 유예 뒤에 만들어졌다
    await remit(h, orderId, h.sponsor, deadline + DEADLINE_GRACE_SEC + 10);
    expect(h.order(orderId)!.state).toBe('invoiced');
  });

  /** 꺼져 있던 동안 쌓인 요청(기한 안에 누른 송금 완료)을 먼저 받는다 */
  it('재시작 직후에는 기한으로 닫지 않는다 (워밍업)', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h, { deadlineIn: 3 * HOUR });
    h.advance(4 * HOUR);
    await h.daemon.stop();
    const again = h.start(h.ln.db); // 같은 DB로 다시 — 뜬 시각이 지금이 된다
    await h.settle(again);
    expect(h.order(orderId)!.state).toBe('requested');
    h.advance(3 * 60);
    await h.settle(again);
    await h.settle(again);
    expect(h.order(orderId)!.state).toBe('expired');
  });
});

describe('고객 취소', () => {
  it('후원자가 붙기 전 → 보증금 환불', async () => {
    const h = await warmHarness();
    setDeposits(h, 2, 0);
    const orderId = await openOrder(h);
    payDepositOf(h, 'customer');
    await h.run();
    const dep = h.order(orderId)!.customer_deposit_hash!;
    await cancel(h, orderId);
    expect(h.order(orderId)!.close_reason).toBe('cancel:customer');
    expect(h.node.stateOf(dep)).toBe('cancelled');
  });

  it('클레임 뒤 → 고객 보증금 몰수 (후원자 시간 낭비), 만들어 둔 에스크로도 치운다', async () => {
    const h = await warmHarness();
    setDeposits(h, 2, 0);
    const orderId = await openOrder(h);
    payDepositOf(h, 'customer');
    await h.run();
    await claim(h, orderId);
    const o = h.order(orderId)!;
    expect(o.state).toBe('verified');
    await cancel(h, orderId);
    expect(h.order(orderId)!.close_reason).toBe('cancel:customer-after-claim');
    expect(h.node.stateOf(o.customer_deposit_hash!)).toBe('settled');
    expect(h.node.stateOf(o.escrow_hash!)).toBe('cancelled');
  });

  it('에스크로 뒤에는 고객 혼자 못 접는다', async () => {
    const h = await warmHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await cancel(h, orderId);
    expect(h.order(orderId)!.state).toBe('escrowed');
  });

  it('보증금을 내기 전에 접으면 대기 의뢰와 인보이스가 사라진다', async () => {
    const h = await warmHarness();
    setDeposits(h, 2, 0);
    const orderId = await openOrder(h);
    const bolt11 = tagOf(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!;
    await cancel(h, orderId);
    expect(h.ln.db.get('SELECT 1 FROM ln_drafts WHERE order_id = ?', orderId)).toBeUndefined();
    expect(h.node.stateOf(bolt11)).toBe('cancelled');
  });
});

describe('에스크로 만기 (L-3) — 선제 settle과 판정', () => {
  it('remitted인데 HTLC 만기가 가까우면 먼저 받아 두고 사람을 부른다 → 후원자 승이면 지급', async () => {
    const h = await warmHarness();
    const orderId = await toRemitted(h);
    const expiry = escrowExpiryHeight(h, orderId);
    expect(expiry).toBeGreaterThan(h.node.height);

    h.node.height = expiry - SAFETY_SETTLE_BLOCKS;
    await h.run(4);
    const o = h.order(orderId)!;
    expect(o.state).toBe('remitted');
    expect(o.escrow_settled).toBe(1);
    expect(h.node.stateOf(o.escrow_hash!)).toBe('settled');
    expect(openAlerts(h.ln).some(a => /먼저 정산/.test(a.message))).toBe(true);

    const cmd = adminCommand(h.operator, h.app.pubkey, TEST_TAGS.admin, {
      cmd: 'ln.rule', args: { target: { track: 'ln', orderId, version: o.version }, winner: 'sponsor' },
    }, h.sec());
    await h.send(cmd, 6);
    const result = eventsTo(h.relay, h.operator.pubkey, ADMIN_ACTIONS.RESULT).find(e => e.tags.some(t => t[1] === cmd.id))!;
    expect(openResult(result, h.operator, h.app.pubkey)).toMatchObject({ ok: true });
    expect(h.order(orderId)!.state).toBe('sponsor_wins');
    expect(h.order(orderId)!.disbursed).toBe(1);
  });

  /** 정리 효과가 도는 중에 관찰이 먼저 결과를 보면, 우리가 한 settle을 남이 한 것으로 오인한다 */
  it('선제 settle 응답이 유실돼도 "데몬이 하지 않은 settle" 경보를 내지 않는다', async () => {
    const h = await warmHarness();
    const orderId = await toRemitted(h);
    h.node.throwAfter.settleInvoice = 1;
    h.node.height = escrowExpiryHeight(h, orderId) - SAFETY_SETTLE_BLOCKS;
    await h.run(2);
    h.advance(60);
    await h.run(4);
    expect(h.order(orderId)!.escrow_settled).toBe(1);
    expect(openAlerts(h.ln).some(a => /하지 않은 settle/.test(a.message))).toBe(false);
  });

  it('선제 settle 뒤 고객 승이면 자동 환불이 안 된다 — 경보로 알린다 (L-7)', async () => {
    const h = await warmHarness();
    const orderId = await toRemitted(h);
    h.node.height = escrowExpiryHeight(h, orderId) - SAFETY_SETTLE_BLOCKS;
    await h.run(4);

    h.ln.db.tx(() => beginClose(h.ln, h.order(orderId)!, 'customer_wins'));
    await h.run(4);
    expect(h.order(orderId)!.state).toBe('customer_wins');
    expect(openAlerts(h.ln).some(a => /손으로 환불/.test(a.message))).toBe(true);
    expect(h.order(orderId)!.disbursed).toBe(0);
  });

  it('escrowed에서 HTLC 만기가 기한보다 먼저 오면(블록이 빨랐다) 닫는다', async () => {
    const h = await warmHarness();
    const orderId = await openOrder(h, { deadlineIn: 2 * DAY });
    await claim(h, orderId);
    await payEscrow(h, orderId);
    const hash = h.order(orderId)!.escrow_hash!;
    h.node.height = escrowExpiryHeight(h, orderId) - ESCROW_END_BLOCKS;
    await h.run(6);
    expect(h.order(orderId)!.state).toBe('expired');
    expect(h.node.stateOf(hash)).toBe('cancelled');
  });

  /** 받지 않은 돈을 지급하는 경로를 만들지 않는다 */
  it('에스크로가 이미 취소됐는데 입금 확인이 오면 paid로 가지 않고 사람에게 넘긴다', async () => {
    const h = await warmHarness();
    const orderId = await toRemitted(h);
    const hash = h.order(orderId)!.escrow_hash!;
    h.node.holds.get(hash)!.state = 'cancelled'; // 노드 밖에서 취소됐다(수동 lncli 등)
    await confirmPaid(h, orderId);
    await h.run(4);
    const o = h.order(orderId)!;
    expect(o.state).not.toBe('paid');
    expect(o.pending_close).toBeNull();
    expect(o.disbursed).toBe(0);
    expect(h.node.payments.size).toBe(0);
    expect(openAlerts(h.ln).some(a => a.orderId === orderId && a.level === 'anomaly')).toBe(true);
  });
});
