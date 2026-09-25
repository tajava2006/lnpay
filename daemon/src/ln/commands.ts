/**
 * 라이트닝 운영자 명령
 *
 * 오더를 바꾸는 명령은 전부 `target = { track: 'ln', orderId, version }`을 싣고, 버전이 지금과 다르면
 * 거절한다(DM-006) — 다른 기기에서 이미 끝낸 판정을 낡은 화면에서 또 누르는 걸 막는다.
 *
 * 판단이 필요한 건 분쟁 판정(`ln.rule`)뿐이다. 나머지는 자동 경로가 막혔을 때의 예외용이다.
 */
import type { AdminCommandResult } from '@sajwo-tracker/shared/core';
import type { CommandRegistry } from '../admin/commands';
import { checkTarget } from '../orders/directory';
import type { LnContext } from './context';
import { approve, beginClose, requestPayout, revertClaim } from './flow';
import { sendRevealRequest } from './messages';
import { getOrder, requestDetail, type LnOrderRow } from './store';

type LnCommand = (order: LnOrderRow, args: Record<string, unknown>) => { error?: string; result?: unknown };

export function registerLnCommands(registry: CommandRegistry, ctx: LnContext): void {
  const register = (cmd: string, run: LnCommand) => {
    registry.register(cmd, (_admin, args): AdminCommandResult => {
      const target = checkTarget(ctx.directory, args.target);
      if (!target.ok) return { ok: false, cmd, error: target.error };
      if (target.target.track !== 'ln') return { ok: false, cmd, error: 'bad-target' };
      const order = getOrder(ctx, target.target.orderId);
      if (!order) return { ok: false, cmd, error: 'unknown-order' };
      const out = run(order, args);
      if (out.error) return { ok: false, cmd, error: out.error };
      const after = getOrder(ctx, order.order_id)!;
      ctx.log.info('운영자 명령', { cmd, orderId: order.order_id });
      return { ok: true, cmd, result: { orderId: order.order_id, version: after.version, ...(out.result ? { detail: out.result } : {}) } };
    });
  };

  /** 자동 승인이 꺼져 있거나 막혔을 때 */
  register('ln.approve', order => {
    const error = approve(ctx, order);
    return error ? { error } : {};
  });

  /** 클레임을 풀어 다른 후원자가 잡게 (보증금은 돌려준다) */
  register('ln.revert-claim', order => {
    if (order.state !== 'claimed') return { error: 'bad-state' };
    if (order.pending_close) return { error: 'closing' };
    revertClaim(ctx, order);
    return {};
  });

  /** 분쟁 판정 — 송금 완료 뒤에만 */
  register('ln.rule', (order, args) => {
    if (args.winner !== 'sponsor' && args.winner !== 'customer') return { error: 'bad-args' };
    if (order.state !== 'remitted') return { error: 'bad-state' };
    return beginClose(ctx, order, args.winner === 'sponsor' ? 'sponsor_wins' : 'customer_wins')
      ? {} : { error: 'closing' };
  });

  /**
   * 방치된 거래를 끊는다(에스크로 환불, 보증금은 양쪽 다 돌려준다 — 몰수는 판정의 몫).
   * 기한 만료가 자동으로 닫으므로 기한 전에 끊어야 할 때만 쓴다.
   */
  register('ln.force-close', order => {
    if (order.state !== 'escrowed' && order.state !== 'invoiced') return { error: 'bad-state' };
    return beginClose(ctx, order, 'admin_closed') ? {} : { error: 'closing' };
  });

  /** 지급을 지금 다시 (백오프를 기다리지 않고) */
  register('ln.retry-payout', order => {
    if (order.state !== 'paid' && order.state !== 'sponsor_wins') return { error: 'bad-state' };
    if (order.disbursed) return { error: 'already-disbursed' };
    requestPayout(ctx, order.order_id);
    return {};
  });

  /** 후원자에게 계좌 공개를 요청 — 커밋먼트 대조용 */
  register('ln.reveal-request', order => {
    if (!order.sponsor) return { error: 'no-sponsor' };
    if (!order.account_commitment) return { error: 'no-account' };
    sendRevealRequest(ctx, order.order_id, order.sponsor);
    return {};
  });

  /** 상세를 다시 내 달라 (새 기기에서 연 오래된 오더) — 버전 확인이 필요 없다 */
  registry.register('ln.detail', (_admin, args): AdminCommandResult => {
    const orderId = args.orderId;
    if (typeof orderId !== 'string' || !getOrder(ctx, orderId)) return { ok: false, cmd: 'ln.detail', error: 'unknown-order' };
    requestDetail(ctx, orderId);
    return { ok: true, cmd: 'ln.detail', result: { orderId } };
  });
}
