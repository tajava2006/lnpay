/**
 * 라이트닝 트랙 저장소 — `ln_orders`·`ln_drafts` (마이그레이션 v3). 인보이스는 `../hold`
 *
 * **오더를 바꾸는 길은 `updateOrder` 하나다.** 거기서 버전을 올리고(DM-006) 공개 발행·운영자 상세를
 * 같이 쌓는다 — 발행은 행의 투영이라, 바꾸고 발행을 빠뜨리는 일이 구조적으로 안 생긴다.
 */
import type { OrderState } from '@sajwo-tracker/shared/core';
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
