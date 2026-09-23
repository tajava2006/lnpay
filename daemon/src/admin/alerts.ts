/**
 * 경보 — 사람이 봐야 하는 일 (PLAN-DAEMON §5.3·§11)
 *
 * 같은 사유(`dedup`)로는 **한 번만** 울린다. 워처가 매 틱 같은 이상을 보더라도 운영자 폰이 30초마다
 * 울리면 안 된다(프론트 시절 분쟁 임박 푸시가 그랬다). 그래서 부르는 쪽은 상황이 **바뀔 때** 다른
 * dedup을 쓴다 — 예: `ln:<오더>:settle-failing`.
 *
 * 경보는 운영자 상태에 실리고(어드민 화면), 새로 생기면 DM으로도 간다.
 */
import type { AdminAlert, TrackName } from '@sajwo-tracker/shared/core';
import { nowSec, type AdminContext } from './context';
import { notifyOperators } from './notify';
import { requestStatePublish } from './state';

export interface AlertInput {
  dedup: string;
  level: 'warn' | 'anomaly';
  track?: TrackName;
  orderId?: string;
  message: string;
}

/** 새 경보면 true (그때만 DM) */
export function raiseAlert(ctx: AdminContext, alert: AlertInput): boolean {
  const r = ctx.db.run(
    `INSERT OR IGNORE INTO alerts (dedup, level, track, order_id, message, raised_at) VALUES (?, ?, ?, ?, ?, ?)`,
    alert.dedup, alert.level, alert.track ?? null, alert.orderId ?? null, alert.message, nowSec(ctx),
  );
  if (r.changes === 0) return false;
  ctx.log.warn('경보', { ...alert });
  notifyOperators(ctx, alert.orderId ? `${alert.message} (${alert.orderId})` : alert.message);
  requestStatePublish(ctx);
  return true;
}

export function ackAlert(ctx: AdminContext, id: number): boolean {
  const r = ctx.db.run(`UPDATE alerts SET acked_at = ? WHERE id = ? AND acked_at IS NULL`, nowSec(ctx), id);
  if (r.changes > 0) requestStatePublish(ctx);
  return r.changes > 0;
}

export function openAlerts(ctx: Pick<AdminContext, 'db'>): AdminAlert[] {
  return ctx.db.all<{
    id: number; level: 'warn' | 'anomaly'; track: TrackName | null; order_id: string | null;
    message: string; raised_at: number;
  }>(`SELECT id, level, track, order_id, message, raised_at FROM alerts WHERE acked_at IS NULL ORDER BY id`)
    .map(r => ({
      id: r.id,
      level: r.level,
      ...(r.track ? { track: r.track } : {}),
      ...(r.order_id ? { orderId: r.order_id } : {}),
      message: r.message,
      raisedAt: r.raised_at,
    }));
}
