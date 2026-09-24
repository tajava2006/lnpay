/**
 * 라이트닝 e2e 공용 동작 — 유저가 하는 일을 한 줄씩
 */
import { randomBytes } from 'node:crypto';
import { REQUEST_ACTIONS } from '@sajwo-tracker/shared/core';
import { saveSettings, loadSettings } from '../admin/settings';
import { lnRequest, makeInvoice, type LnHarness } from './ln-fakes';
import type { TestKey } from './fakes';

export const HOUR = 60 * 60;
export const DAY = 24 * HOUR;

let seq = 0;

/** 의뢰를 올린다 (기본: 10만 원, 기한 2일 뒤) */
export async function openOrder(
  h: LnHarness, opts: { orderId?: string; price?: number; deadlineIn?: number; customer?: TestKey } = {},
): Promise<string> {
  const orderId = opts.orderId ?? `ord${(seq++).toString(36)}x${randomBytes(2).toString('hex')}`;
  await h.send(lnRequest(opts.customer ?? h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.ORDER_REQUEST, h.sec(), [
    ['price', String(opts.price ?? 100_000), 'KRW'],
    ['deadline', String(h.sec() + (opts.deadlineIn ?? 2 * DAY))],
  ]));
  return orderId;
}

export async function claim(h: LnHarness, orderId: string, sponsor = h.sponsor): Promise<void> {
  await h.send(lnRequest(sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.CLAIM, h.sec()));
}

/** 고객이 에스크로 인보이스를 낸다 */
export async function payEscrow(h: LnHarness, orderId: string): Promise<void> {
  const bolt11 = h.order(orderId)?.escrow_bolt11;
  if (!bolt11) throw new Error('에스크로 인보이스가 아직 없다');
  h.node.pay(bolt11);
  await h.run();
}

/** 후원자가 지급받을 인보이스를 낸다 (기본: 정확한 금액, 7시간) */
export async function submitInvoice(
  h: LnHarness, orderId: string, opts: { amountSat?: number; expirySec?: number; from?: TestKey } = {},
): Promise<string> {
  const payout = h.order(orderId)?.payout_sat ?? 0;
  const { bolt11 } = makeInvoice({ amountSat: opts.amountSat ?? payout, timestamp: h.sec(), expirySec: opts.expirySec ?? 7 * HOUR });
  await h.send(lnRequest(opts.from ?? h.sponsor, h.app.pubkey, orderId, REQUEST_ACTIONS.SPONSOR_INVOICE, h.sec(), [['bolt11', bolt11]]));
  return bolt11;
}

export async function sendAccount(h: LnHarness, orderId: string, commitment = randomBytes(32).toString('hex')): Promise<void> {
  await h.send(lnRequest(h.customer, h.app.pubkey, orderId, REQUEST_ACTIONS.ACCOUNT_INFO, h.sec(), [
    ['p', h.sponsor.pubkey], ['commitment', commitment],
  ], 'ciphertext'));
}

export async function remit(h: LnHarness, orderId: string, from = h.sponsor, createdAt = h.sec()): Promise<void> {
  await h.send(lnRequest(from, h.app.pubkey, orderId, REQUEST_ACTIONS.REMIT_REQUEST, createdAt));
}

export async function confirmPaid(h: LnHarness, orderId: string, from = h.customer): Promise<void> {
  await h.send(lnRequest(from, h.app.pubkey, orderId, REQUEST_ACTIONS.PAYMENT_CONFIRM, h.sec()));
}

export async function cancel(h: LnHarness, orderId: string, from = h.customer): Promise<void> {
  await h.send(lnRequest(from, h.app.pubkey, orderId, REQUEST_ACTIONS.CANCEL_REQUEST, h.sec()));
}

/** 의뢰 → 클레임 → 승인 → 에스크로 → 인보이스 → 계좌 → 송금 완료 */
export async function toRemitted(h: LnHarness, opts: { deadlineIn?: number } = {}): Promise<string> {
  const orderId = await openOrder(h, opts);
  await claim(h, orderId);
  await payEscrow(h, orderId);
  await submitInvoice(h, orderId);
  await sendAccount(h, orderId);
  await remit(h, orderId);
  return orderId;
}

export function setDeposits(h: LnHarness, customerPct: number, sponsorPct: number): void {
  const s = loadSettings(h.ln.db);
  saveSettings(h.ln.db, { ...s, ln: { ...s.ln, customerDepositPct: customerPct, sponsorDepositPct: sponsorPct } });
}

export function setAutoApprove(h: LnHarness, on: boolean): void {
  const s = loadSettings(h.ln.db);
  saveSettings(h.ln.db, { ...s, ln: { ...s.ln, autoApprove: on } });
}

/** 이 사람에게 간 이 action의 APP 메시지 */
export function messagesTo(h: LnHarness, pubkey: string, action: string) {
  return h.relay.published.filter(e =>
    e.pubkey === h.app.pubkey
    && e.tags.some(t => t[0] === 'p' && t[1] === pubkey)
    && e.tags.some(t => t[0] === 'action' && t[1] === action));
}
