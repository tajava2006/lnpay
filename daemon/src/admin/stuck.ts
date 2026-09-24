/**
 * 오래 실패하는 효과 — 사람을 부른다 (PLAN-DAEMON §7 L-4)
 *
 * 효과 대기열은 돈이 걸린 일을 끝까지 다시 한다(지급·settle·브로드캐스트). 그런데 조용히 계속 실패하면
 * 아무도 모른다 — 이만큼 실패하면 효과마다 **한 번** 경보를 올린다. 트랙은 효과 이름에서, 오더는
 * payload에서 읽는다(홀드 인보이스 효과는 인보이스 행에서).
 */
import type { TrackName } from '@sajwo-tracker/shared/core';
import { raiseAlert } from './alerts';
import type { AdminContext } from './context';

/** 이만큼 실패하면 부른다 */
export const STUCK_EFFECT_ATTEMPTS = 6;

/** 알림·상태 발행처럼 실패해도 거래가 멈추지 않는 효과는 뺀다 */
const WATCHED = ['ln.%', 'oc.%', 'hold.%'];

export function raiseStuckEffects(ctx: AdminContext): void {
  const stuck = ctx.db.all<{ id: number; kind: string; attempts: number; last_error: string | null; payload: string }>(
    `SELECT id, kind, attempts, last_error, payload FROM effects
     WHERE status = 'pending' AND attempts >= ? AND (${WATCHED.map(() => 'kind LIKE ?').join(' OR ')})`,
    STUCK_EFFECT_ATTEMPTS, ...WATCHED,
  );
  for (const e of stuck) {
    const where = locate(ctx, e.kind, e.payload);
    raiseAlert(ctx, {
      dedup: `effect:${e.id}:stuck`, level: 'anomaly',
      ...(where.track ? { track: where.track } : {}), ...(where.orderId ? { orderId: where.orderId } : {}),
      message: `${e.kind}이(가) ${e.attempts}번 실패했다: ${e.last_error ?? '?'}`,
    });
  }
}

function locate(ctx: AdminContext, kind: string, payload: string): { track?: TrackName; orderId?: string } {
  let p: { orderId?: unknown; paymentHash?: unknown } = {};
  try {
    p = JSON.parse(payload) as typeof p;
  } catch {
    return {};
  }
  if (typeof p.paymentHash === 'string') {
    const row = ctx.db.get<{ order_id: string; purpose: string }>(
      'SELECT order_id, purpose FROM ln_invoices WHERE payment_hash = ?', p.paymentHash,
    );
    return row ? { track: row.purpose.startsWith('oc-') ? 'onchain' : 'ln', orderId: row.order_id } : {};
  }
  const track: TrackName | undefined = kind.startsWith('ln.') ? 'ln' : kind.startsWith('oc.') ? 'onchain' : undefined;
  return { ...(track ? { track } : {}), ...(typeof p.orderId === 'string' ? { orderId: p.orderId } : {}) };
}
