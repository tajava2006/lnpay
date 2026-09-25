/**
 * P3 라이트닝 — 정상 흐름과 돈이 움직이는 순서
 *
 * 가짜 노드는 LND처럼 굴고(기한 지난 인보이스 취소, HTLC 만기 전 자동 취소), 인보이스는 진짜로
 * 서명된 bolt11이다. 시계와 블록 높이는 테스트가 돌린다.
 */
import { describe, expect, it } from 'vitest';
import { REQUEST_ACTIONS } from '@sajwo-tracker/shared/core';
import { computeEscrowSat, computePayoutSat } from '@sajwo-tracker/shared/ln';
import { BTC_KRW, createLnHarness, latestOrderEvent, tagOf } from './ln-fakes';
import {
  DAY, HOUR, claim, confirmPaid, messagesTo, openOrder, payEscrow, remit, sendAccount, setAutoApprove, setDeposits,
  submitInvoice, toRemitted,
} from './ln-helpers';

describe('정상 흐름 — 보증금 없이', () => {
  it('의뢰부터 지급까지 한 바퀴', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h, { price: 100_000, deadlineIn: 2 * DAY });

    // 의뢰: 기한은 deadline 태그, 보존은 expiration (requested는 기한에 사라진다)
    let ev = latestOrderEvent(h.relay.published, orderId)!;
    expect(ev.pubkey).toBe(h.app.pubkey);
    expect(tagOf(ev, 'state')).toBe('requested');
    expect(tagOf(ev, 'deadline')).toBe(String(h.order(orderId)!.deadline));
    expect(tagOf(ev, 'expiration')).toBe(tagOf(ev, 'deadline'));

    // 클레임 → 자동 승인 → 에스크로 인보이스
    await claim(h, orderId);
    const payout = computePayoutSat(100_000, BTC_KRW)!;
    let o = h.order(orderId)!;
    expect(o.state).toBe('verified');
    expect(o.sponsor).toBe(h.sponsor.pubkey);
    expect(o.payout_sat).toBe(payout);
    ev = latestOrderEvent(h.relay.published, orderId)!;
    expect(tagOf(ev, 'bolt11')).toBe(o.escrow_bolt11);
    expect(tagOf(ev, 'payout')).toBe(String(payout));
    // 진행 중 보존은 기한 + 30일 — 기한 직후의 요청·판정이 릴레이에서 거절되지 않게
    expect(Number(tagOf(ev, 'expiration'))).toBeGreaterThan(o.deadline + 29 * DAY);
    expect(h.node.holds.get(o.escrow_hash!)?.amountSat).toBe(computeEscrowSat(payout));

    await payEscrow(h, orderId);
    expect(h.order(orderId)!.state).toBe('escrowed');

    const sponsorBolt11 = await submitInvoice(h, orderId);
    expect(h.order(orderId)!.state).toBe('invoiced');
    expect(tagOf(latestOrderEvent(h.relay.published, orderId), 'sponsor-invoice')).toBe(sponsorBolt11);

    await sendAccount(h, orderId);
    await remit(h, orderId);
    expect(h.order(orderId)!.state).toBe('remitted');

    await confirmPaid(h, orderId, h.customer);
    o = h.order(orderId)!;
    expect(o.state).toBe('paid');
    expect(o.close_reason).toBe('paid');
    expect(h.node.stateOf(o.escrow_hash!)).toBe('settled');
    expect(o.disbursed).toBe(1);
    expect(h.node.payments.size).toBe(1);

    ev = latestOrderEvent(h.relay.published, orderId)!;
    expect(tagOf(ev, 'state')).toBe('paid');
    expect(tagOf(ev, 'status')).toBe('sold');
    expect(tagOf(ev, 'disbursed')).toBe('true');
    expect(tagOf(ev, 'close-reason')).toBe('paid');
  });

  /** DM-003 · L-4 — 예전엔 paid를 먼저 발행하고 settle이 실패하면 재시도가 없었다 */
  it('settle이 성공하기 전에는 paid가 아니다 — 실패하면 다시 해서 끝낸다', async () => {
    const h = await createLnHarness();
    const orderId = await toRemitted(h);
    h.node.failNext.settleInvoice = 2;

    await confirmPaid(h, orderId);
    expect(h.order(orderId)!.state).toBe('remitted');
    expect(h.order(orderId)!.pending_close).toBe('paid');
    expect(tagOf(latestOrderEvent(h.relay.published, orderId), 'state')).toBe('remitted');

    h.advance(60);
    await h.run(6);
    const o = h.order(orderId)!;
    expect(o.state).toBe('paid');
    expect(h.node.stateOf(o.escrow_hash!)).toBe('settled');
    expect(o.disbursed).toBe(1);
  });

  /** 크래시 재시작과 같은 모양 — 노드는 settle했는데 응답이 유실됐다 */
  it('settle 응답이 유실돼도 다시 조회해서 paid로 수렴한다 (두 번 settle하지 않는다)', async () => {
    const h = await createLnHarness();
    const orderId = await toRemitted(h);
    h.node.throwAfter.settleInvoice = 1;

    await confirmPaid(h, orderId);
    h.advance(60);
    await h.run(6);
    expect(h.order(orderId)!.state).toBe('paid');
    expect(h.node.calls.filter(c => c === 'settleInvoice')).toHaveLength(1);
  });

  it('지급 응답이 유실돼도 두 번 보내지 않는다 — 먼저 추적한다', async () => {
    const h = await createLnHarness();
    const orderId = await toRemitted(h);
    h.node.throwAfter.payInvoice = 1;

    await confirmPaid(h, orderId);
    h.advance(60);
    await h.run(6);
    expect(h.order(orderId)!.disbursed).toBe(1);
    expect([...h.node.payments.values()][0]!.attempts).toBe(1);
  });

  it('invoiced에서 바로 입금 확인도 된다 (후원자가 송금 완료를 안 눌렀어도)', async () => {
    const h = await createLnHarness();
    const orderId = await openOrder(h);
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    await confirmPaid(h, orderId);
    expect(h.order(orderId)!.state).toBe('paid');
  });
});

describe('보증금', () => {
  it('고객 보증금 → 오더 생성 → 에스크로 뒤에도 붙잡고 → 정상 완료 때 환불', async () => {
    const h = await createLnHarness();
    setDeposits(h, 2, 0);
    const orderId = await openOrder(h, { price: 100_000 });

    // 보증금을 내기 전엔 오더가 없다
    expect(h.order(orderId)).toBeUndefined();
    expect(latestOrderEvent(h.relay.published, orderId)).toBeUndefined();
    const required = messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED);
    expect(required).toHaveLength(1);
    const depositBolt11 = tagOf(required[0], 'bolt11')!;
    // 보증금 = 의뢰 금액의 2%
    const dep = h.ln.holds.of(orderId)[0]!;
    expect(dep.amount_sat).toBe(Math.round((100_000 / BTC_KRW) * 1e8 * 0.02));

    h.node.pay(depositBolt11);
    await h.run();
    expect(h.order(orderId)?.state).toBe('requested');
    expect(tagOf(latestOrderEvent(h.relay.published, orderId), 'customer-deposit-payment-hash')).toBe(dep.payment_hash);
    expect(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_ACCEPTED)).toHaveLength(1);

    await claim(h, orderId);
    await payEscrow(h, orderId);
    expect(h.order(orderId)!.state).toBe('escrowed');
    // 에스크로 뒤에도 고객이 할 일(계좌 전달)이 남는다 — 아직 돌려주지 않는다(2026-09-25)
    expect(h.node.stateOf(dep.payment_hash)).toBe('accepted');
    expect(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_CANCELLED)).toHaveLength(0);

    await submitInvoice(h, orderId);
    await sendAccount(h, orderId);
    await confirmPaid(h, orderId);
    expect(h.order(orderId)!.state).toBe('paid');
    expect(h.node.stateOf(dep.payment_hash)).toBe('cancelled');
    expect(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_CANCELLED)).toHaveLength(1);
  });

  /** 에스크로까지 걸고 계좌를 안 보내면 후원자 시간만 버린다 — 본자금은 돌려주고 보증금은 몰수 (2026-09-25) */
  it('계좌를 기한까지 안 보내면 expired:no-account — 고객 보증금 몰수, 에스크로·후원자 보증금은 환불', async () => {
    const h = await createLnHarness();
    setDeposits(h, 2, 3);
    const orderId = await openOrder(h, { deadlineIn: 2 * DAY });
    h.node.pay(tagOf(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!);
    await h.run();
    await claim(h, orderId);
    h.node.pay(tagOf(messagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!);
    await h.run();
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    const o = h.order(orderId)!;
    expect(o.state).toBe('invoiced');
    // 고객 보증금 HTLC가 닫힐 때까지 살아야 몰수할 수 있다 — 가짜 노드는 결제된 HTLC를 만료시키지 않으므로
    // CLTV를 직접 본다: 후원자 보증금만큼(기한 + 유예 + 에스크로 여유 + 하루) 산다
    const customerDep = h.ln.holds.get(o.customer_deposit_hash!)!;
    const sponsorDep = h.ln.holds.get(o.sponsor_deposit_hash!)!;
    expect(customerDep.cltv_blocks * 600).toBeGreaterThanOrEqual(2 * DAY + 49 * HOUR);
    expect(customerDep.cltv_blocks).toBeGreaterThanOrEqual(sponsorDep.cltv_blocks - 6); // 만든 시각 차이만큼만

    h.advance(2 * DAY + 2 * HOUR); // 기한 + 유예가 지났다, 계좌는 끝내 안 왔다
    await h.run(6);
    const closed = h.order(orderId)!;
    expect(closed).toMatchObject({ state: 'expired', close_reason: 'expired:no-account' });
    expect(h.node.stateOf(o.customer_deposit_hash!)).toBe('settled');
    expect(h.node.stateOf(o.sponsor_deposit_hash!)).toBe('cancelled');
    expect(h.node.stateOf(o.escrow_hash!)).toBe('cancelled');
  });

  it('계좌가 나갔으면 누구 탓인지 모른다 — expired:no-remit, 보증금 전부 환불', async () => {
    const h = await createLnHarness();
    setDeposits(h, 2, 0);
    const orderId = await openOrder(h, { deadlineIn: 2 * DAY });
    h.node.pay(tagOf(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!);
    await h.run();
    await claim(h, orderId);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    await sendAccount(h, orderId);
    const o = h.order(orderId)!;

    h.advance(2 * DAY + 2 * HOUR);
    await h.run(6);
    expect(h.order(orderId)).toMatchObject({ state: 'expired', close_reason: 'expired:no-remit' });
    expect(h.node.stateOf(o.customer_deposit_hash!)).toBe('cancelled');
  });

  it('고객 보증금을 한 시간 안에 안 내면 의뢰가 사라진다', async () => {
    const h = await createLnHarness();
    setDeposits(h, 2, 0);
    const orderId = await openOrder(h);
    h.advance(HOUR + 120);
    await h.run();
    expect(h.order(orderId)).toBeUndefined();
    expect(h.ln.db.get('SELECT 1 FROM ln_drafts WHERE order_id = ?', orderId)).toBeUndefined();
    expect(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_CANCELLED)).toHaveLength(1);
  });

  it('후원자 보증금을 내야 승인된다 · 정상 완료면 돌려준다', async () => {
    const h = await createLnHarness();
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h);
    await claim(h, orderId);
    expect(h.order(orderId)!.state).toBe('claimed');
    const required = messagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED);
    expect(required).toHaveLength(1);
    // 공개 오더가 "보증금 대기"를 싣는다 — 양쪽 화면이 아직 "후원자 찾는 중"으로 그린다
    expect(tagOf(latestOrderEvent(h.relay.published, orderId), 'sponsor-deposit')).toBe('pending');

    h.node.pay(tagOf(required[0], 'bolt11')!);
    await h.run();
    const o = h.order(orderId)!;
    expect(o.state).toBe('verified');
    expect(o.sponsor_deposit_hash).toBeTruthy();
    expect(tagOf(latestOrderEvent(h.relay.published, orderId), 'sponsor-deposit')).toBeUndefined();

    await payEscrow(h, orderId);
    await submitInvoice(h, orderId);
    await confirmPaid(h, orderId);
    expect(h.order(orderId)!.state).toBe('paid');
    expect(h.node.stateOf(o.sponsor_deposit_hash!)).toBe('cancelled');
    expect(messagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_CANCELLED)).toHaveLength(1);
  });

  it('보증금이 들어오면 승인 전이라도 "대기"가 풀린다 · 보증금이 없으면 처음부터 없다', async () => {
    const h = await createLnHarness();
    setAutoApprove(h, false);
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h);
    await claim(h, orderId);
    h.node.pay(tagOf(messagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!);
    await h.run();
    const ev = latestOrderEvent(h.relay.published, orderId);
    expect(tagOf(ev, 'state')).toBe('claimed');
    expect(tagOf(ev, 'sponsor-deposit')).toBeUndefined();
    expect(tagOf(ev, 'sponsor-deposit-payment-hash')).toBe(h.order(orderId)!.sponsor_deposit_hash);

    setDeposits(h, 0, 0);
    const plain = await openOrder(h);
    await claim(h, plain);
    expect(tagOf(latestOrderEvent(h.relay.published, plain), 'state')).toBe('claimed');
    expect(tagOf(latestOrderEvent(h.relay.published, plain), 'sponsor-deposit')).toBeUndefined();
  });

  it('클레임이 풀리면 "대기"도 사라진다', async () => {
    const h = await createLnHarness();
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h);
    await claim(h, orderId);
    h.advance(15 * 60 + 90);
    await h.run();
    const ev = latestOrderEvent(h.relay.published, orderId);
    expect(tagOf(ev, 'state')).toBe('requested');
    expect(tagOf(ev, 'sponsor-deposit')).toBeUndefined();
  });

  /** T-005 — 보증금 없이 클레임만 걸어 두는 공짜 점유 */
  it('후원자 보증금을 15분 안에 안 내면 클레임이 풀리고 다른 후원자가 잡을 수 있다', async () => {
    const h = await createLnHarness();
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h);
    await claim(h, orderId);
    h.advance(15 * 60 + 90);
    await h.run();
    const o = h.order(orderId)!;
    expect(o.state).toBe('requested');
    expect(o.sponsor).toBeNull();
    expect(messagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_CANCELLED)).toHaveLength(1);

    const other = (await import('./fakes')).newKey();
    await claim(h, orderId, other);
    expect(h.order(orderId)!.sponsor).toBe(other.pubkey);
  });

  /** 노드가 만료 인보이스를 제때 안 치워도(버전 차이·조회 실패) 데몬 시계가 푼다 */
  it('노드가 미결제 보증금을 스스로 취소하지 않아도 시계가 클레임을 풀고 인보이스를 치운다', async () => {
    const h = await createLnHarness();
    h.node.autoExpire = false;
    setDeposits(h, 0, 3);
    const orderId = await openOrder(h);
    await claim(h, orderId);
    const bolt11 = tagOf(messagesTo(h, h.sponsor.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!;
    h.advance(15 * 60 + 90);
    await h.run();
    expect(h.order(orderId)!.state).toBe('requested');
    expect(h.node.stateOf(bolt11)).toBe('cancelled');
  });
});

describe('유저 알림 (웹 푸시)', () => {
  it('구독하면 그 기기에만 확인을 보내고, 전이마다 한 번씩 알린다', async () => {
    const h = await createLnHarness();
    const { nip44Encrypt } = await import('@sajwo-tracker/shared/core');
    const { lnRequest } = await import('./ln-fakes');
    const sub = { endpoint: 'https://push.example/abc', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
    const register = lnRequest(h.customer, h.app.pubkey, null, REQUEST_ACTIONS.PUSH_SUBSCRIPTION, h.sec(), [],
      nip44Encrypt(JSON.stringify(sub), h.customer.secretKey, h.app.pubkey));
    await h.send(register);
    expect(h.push.sent).toHaveLength(1); // 등록 확인

    // 같은 등록이 다시 와도(다른 이벤트) 새 기기가 아니다
    await h.send(lnRequest(h.customer, h.app.pubkey, null, REQUEST_ACTIONS.PUSH_SUBSCRIPTION, h.sec() + 1, [],
      nip44Encrypt(JSON.stringify(sub), h.customer.secretKey, h.app.pubkey)));
    expect(h.push.sent).toHaveLength(1);

    const orderId = await openOrder(h);
    await claim(h, orderId);
    expect(h.push.sent).toHaveLength(2); // verified — 결제하세요
    await h.run(4);
    expect(h.push.sent).toHaveLength(2); // 다시 돌아도 또 울리지 않는다

    // 클레임이 풀렸다 다시 승인되면 새 에스크로다 — "결제하세요"는 다시 가야 한다
    const { revertClaim } = await import('../ln/flow');
    h.ln.db.tx(() => revertClaim(h.ln, h.order(orderId)!));
    await h.run();
    await claim(h, orderId);
    expect(h.push.sent).toHaveLength(3);

    // 410이면 죽은 구독 — 다음부터 안 보낸다
    h.push.status.set(sub.endpoint, 410);
    await payEscrow(h, orderId);
    await submitInvoice(h, orderId); // invoiced — 계좌를 보내세요 (410으로 실패)
    const sentBefore = h.push.sent.length;
    await sendAccount(h, orderId);
    await remit(h, orderId); // remitted — 고객에게 알림을 보내야 하지만 구독이 죽었다
    expect(h.push.sent.length).toBe(sentBefore);
  });

  /** 2026-09-24 mainnet 드릴 — 클레임 뒤 보증금 인보이스가 나왔는데 알림이 없었다(상태 전이가 아니라서) */
  it('보증금을 내야 할 때도 알린다 — 인보이스마다 한 번', async () => {
    const h = await createLnHarness();
    const { nip44Encrypt } = await import('@sajwo-tracker/shared/core');
    const { lnRequest } = await import('./ln-fakes');
    const subscribe = async (who: typeof h.sponsor, endpoint: string) => {
      const sub = { endpoint, p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
      await h.send(lnRequest(who, h.app.pubkey, null, REQUEST_ACTIONS.PUSH_SUBSCRIPTION, h.sec(), [],
        nip44Encrypt(JSON.stringify(sub), who.secretKey, h.app.pubkey)));
    };
    await subscribe(h.customer, 'https://push.example/customer');
    await subscribe(h.sponsor, 'https://push.example/sponsor');
    const to = (endpoint: string) => h.push.sent.filter(s => s.url === endpoint).length;
    expect(to('https://push.example/customer')).toBe(1); // 등록 확인
    expect(to('https://push.example/sponsor')).toBe(1);

    setDeposits(h, 2, 3);
    const orderId = await openOrder(h);
    expect(to('https://push.example/customer')).toBe(2); // 고객 보증금
    h.node.pay(tagOf(messagesTo(h, h.customer.pubkey, REQUEST_ACTIONS.DEPOSIT_REQUIRED)[0], 'bolt11')!);
    await h.run();

    await claim(h, orderId);
    expect(to('https://push.example/sponsor')).toBe(2); // 후원자 보증금
    await h.run(4);
    expect(to('https://push.example/sponsor')).toBe(2); // 다시 돌아도 한 번
  });
});
