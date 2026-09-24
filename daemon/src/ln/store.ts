/**
 * 라이트닝 트랙 저장소 — `ln_orders`·`ln_drafts`·`ln_invoices` (마이그레이션 v3)
 *
 * **오더를 바꾸는 길은 `updateOrder` 하나다.** 거기서 버전을 올리고(DM-006) 공개 발행·운영자 상세를
 * 같이 쌓는다 — 발행은 행의 투영이라, 바꾸고 발행을 빠뜨리는 일이 구조적으로 안 생긴다.
 */
import type { OrderState } from '@sajwo-tracker/shared/core';
import type { PreimagePurpose } from '../derive';
import { nowSec } from '../admin/context';
import type { LnContext } from './context';

export interface LnOrderRow {
  order_id: string;
  state: OrderState;
  customer: string;
  sponsor: string | null;
  price: number;
  deadline: number;
  payout_sat: number | null;
  escrow_hash: string | null;
  escrow_bolt11: string | null;
  escrow_settled: number;
  sponsor_invoice: string | null;
  disbursed: number;
  payout_error: string | null;
  customer_deposit_hash: string | null;
  sponsor_deposit_hash: string | null;
  pending_close: string | null;
  close_reason: string | null;
  claimed_at: number | null;
  account_sent_at: number | null;
  account_commitment: string | null;
  remitted_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
  published_at: number;
}

/** `updateOrder`가 바꿀 수 있는 칸 — 키·버전·시각은 저장소가 관리한다 */
export type LnOrderPatch = Partial<Omit<LnOrderRow, 'order_id' | 'customer' | 'price' | 'deadline'
  | 'created_at' | 'updated_at' | 'version' | 'published_at'>>;

export interface LnDraftRow {
  order_id: string;
  customer: string;
  price: number;
  deadline: number;
  created_at: number;
}

export type LnInvoicePurpose = Extract<PreimagePurpose, 'ln-escrow' | 'ln-customer-deposit' | 'ln-sponsor-deposit'>;
export type LnInvoiceStatus = 'creating' | 'open' | 'accepted' | 'settled' | 'cancelled';

export interface LnInvoiceRow {
  payment_hash: string;
  purpose: LnInvoicePurpose;
  order_id: string;
  /** 내는 사람 */
  party: string;
  attempt: number;
  amount_sat: number;
  /** 만들어지기 전엔 빈 문자열 */
  bolt11: string;
  pay_by: number;
  cltv_blocks: number;
  status: LnInvoiceStatus;
  htlc_expiry_height: number | null;
  created_at: number;
  updated_at: number;
}

/** 아직 끝나지 않은 인보이스 — 노드에 물어봐야 하는 것 */
export const LIVE_INVOICE_STATUSES: readonly LnInvoiceStatus[] = ['creating', 'open', 'accepted'];

// ── 오더 ────────────────────────────────────────────────────

export function getOrder(ctx: Pick<LnContext, 'db'>, orderId: string): LnOrderRow | undefined {
  return ctx.db.get<LnOrderRow>('SELECT * FROM ln_orders WHERE order_id = ?', orderId);
}

export function ordersInStates(ctx: Pick<LnContext, 'db'>, states: readonly OrderState[]): LnOrderRow[] {
  if (states.length === 0) return [];
  return ctx.db.all<LnOrderRow>(
    `SELECT * FROM ln_orders WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`,
    ...states,
  );
}

export function insertOrder(
  ctx: LnContext,
  o: { orderId: string; customer: string; price: number; deadline: number; customerDepositHash?: string },
): void {
  const now = nowSec(ctx);
  ctx.db.run(
    `INSERT INTO ln_orders (order_id, state, customer, price, deadline, customer_deposit_hash, created_at, updated_at)
     VALUES (?, 'requested', ?, ?, ?, ?, ?, ?)`,
    o.orderId, o.customer, o.price, o.deadline, o.customerDepositHash ?? null, now, now,
  );
  requestProjection(ctx, o.orderId);
}

/**
 * 오더를 바꾼다 — 버전을 올리고, 공개 발행과 운영자 상세를 쌓는다.
 * **부르는 쪽의 트랜잭션 안에서** 부른다.
 */
export function updateOrder(ctx: LnContext, orderId: string, patch: LnOrderPatch): LnOrderRow {
  const keys = Object.keys(patch) as Array<keyof LnOrderPatch>;
  const sets = keys.map(k => `${k} = ?`);
  const values = keys.map(k => patch[k] ?? null);
  const r = ctx.db.run(
    `UPDATE ln_orders SET ${[...sets, 'version = version + 1', 'updated_at = ?'].join(', ')} WHERE order_id = ?`,
    ...values, nowSec(ctx), orderId,
  );
  if (r.changes === 0) throw new Error(`모르는 오더: ${orderId}`);
  requestProjection(ctx, orderId);
  return getOrder(ctx, orderId)!;
}

/** 오더 행은 그대로인데 운영자 상세만 다시 낼 때 (인보이스 상태가 바뀜 등) */
export function requestDetail(ctx: LnContext, orderId: string): void {
  ctx.effects.enqueue(LN_DETAIL_EFFECT, { orderId }, { dedup: `ln.detail:${orderId}` });
}

function requestProjection(ctx: LnContext, orderId: string): void {
  ctx.effects.enqueue(LN_ORDER_PUBLISH_EFFECT, { orderId }, { dedup: `ln.order:${orderId}` });
  requestDetail(ctx, orderId);
}

export const LN_ORDER_PUBLISH_EFFECT = 'ln.order.publish';
export const LN_DETAIL_EFFECT = 'ln.detail';

// ── 대기 의뢰 (고객 보증금 결제 전) ─────────────────────────

export function getDraft(ctx: Pick<LnContext, 'db'>, orderId: string): LnDraftRow | undefined {
  return ctx.db.get<LnDraftRow>('SELECT * FROM ln_drafts WHERE order_id = ?', orderId);
}

export function allDrafts(ctx: Pick<LnContext, 'db'>): LnDraftRow[] {
  return ctx.db.all<LnDraftRow>('SELECT * FROM ln_drafts ORDER BY created_at');
}

export function deleteDraft(ctx: Pick<LnContext, 'db'>, orderId: string): void {
  ctx.db.run('DELETE FROM ln_drafts WHERE order_id = ?', orderId);
}

// ── 인보이스 ────────────────────────────────────────────────

export function getInvoice(ctx: Pick<LnContext, 'db'>, paymentHash: string): LnInvoiceRow | undefined {
  return ctx.db.get<LnInvoiceRow>('SELECT * FROM ln_invoices WHERE payment_hash = ?', paymentHash);
}

export function invoicesOf(ctx: Pick<LnContext, 'db'>, orderId: string): LnInvoiceRow[] {
  return ctx.db.all<LnInvoiceRow>('SELECT * FROM ln_invoices WHERE order_id = ? ORDER BY created_at, attempt', orderId);
}

export function liveInvoices(ctx: Pick<LnContext, 'db'>): LnInvoiceRow[] {
  return ctx.db.all<LnInvoiceRow>(
    `SELECT * FROM ln_invoices WHERE status IN ('open', 'accepted') ORDER BY created_at`,
  );
}

/** 이 목적·오더·사람으로 몇 번째 인보이스인가 (같은 해시로 두 번 못 만든다 — 새로 만들면 번호를 올린다) */
export function nextAttempt(ctx: Pick<LnContext, 'db'>, purpose: LnInvoicePurpose, orderId: string, party: string): number {
  const row = ctx.db.get<{ n: number | null }>(
    'SELECT MAX(attempt) AS n FROM ln_invoices WHERE purpose = ? AND order_id = ? AND party = ?',
    purpose, orderId, party,
  );
  return row?.n === null || row?.n === undefined ? 0 : Number(row.n) + 1;
}

/** 이 사람의 이 오더 인보이스 중 아직 살아 있는(또는 받은) 것 */
export function currentInvoice(
  ctx: Pick<LnContext, 'db'>, purpose: LnInvoicePurpose, orderId: string, party: string,
): LnInvoiceRow | undefined {
  return ctx.db.get<LnInvoiceRow>(
    `SELECT * FROM ln_invoices WHERE purpose = ? AND order_id = ? AND party = ?
     AND status IN ('creating', 'open', 'accepted', 'settled') ORDER BY attempt DESC LIMIT 1`,
    purpose, orderId, party,
  );
}

export function setInvoice(
  ctx: LnContext,
  paymentHash: string,
  patch: Partial<Pick<LnInvoiceRow, 'status' | 'bolt11' | 'htlc_expiry_height'>>,
): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  ctx.db.run(
    `UPDATE ln_invoices SET ${[...keys.map(k => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE payment_hash = ?`,
    ...keys.map(k => patch[k] ?? null), nowSec(ctx), paymentHash,
  );
  const inv = getInvoice(ctx, paymentHash);
  if (inv && getOrder(ctx, inv.order_id)) requestDetail(ctx, inv.order_id);
}

/** 어떤 오더든 우리가 낸 인보이스의 해시인가 — 우리 인보이스를 지급처로 받으면 안 된다 */
export function isOurPaymentHash(ctx: Pick<LnContext, 'db'>, paymentHash: string): boolean {
  return ctx.db.get('SELECT 1 FROM ln_invoices WHERE payment_hash = ?', paymentHash) !== undefined;
}
