/**
 * 온체인 운영자 명령 (PLAN-DAEMON §5.5)
 *
 * 사람이 판단하는 건 셋뿐이다 — **분쟁 판정, 계좌 이의 판정, 구조.** 나머지는 워처가 자동으로 한다.
 * 오더를 바꾸는 명령은 `target = { track: 'onchain', orderId, version }`을 싣고, 버전이 다르면 거절한다(DM-006).
 */
import type { AdminCommandResult } from '@sajwo-tracker/shared/core';
import type { CommandRegistry } from '../admin/commands';
import { checkTarget } from '../orders/directory';
import type { OcContext } from './context';
import { decideSettlement, requestRescue, requestSettlementSignature, resendRelease, resolveAccountDispute } from './flow';
import { getOc, requestOcDetail, type OcRow } from './store';

type OcCommand = (row: OcRow, args: Record<string, unknown>) => { error?: string };

export function registerOcCommands(registry: CommandRegistry, ctx: OcContext): void {
  const register = (cmd: string, run: OcCommand) => {
    registry.register(cmd, (_admin, args): AdminCommandResult => {
      const target = checkTarget(ctx.directory, args.target);
      if (!target.ok) return { ok: false, cmd, error: target.error };
      if (target.target.track !== 'onchain') return { ok: false, cmd, error: 'bad-target' };
      const row = getOc(ctx, target.target.orderId);
      if (!row) return { ok: false, cmd, error: 'unknown-order' };
      const out = run(row, args);
      if (out.error) return { ok: false, cmd, error: out.error };
      ctx.log.info('운영자 명령', { cmd, orderId: row.order.orderId });
      return { ok: true, cmd, result: { orderId: row.order.orderId, version: getOc(ctx, row.order.orderId)!.version } };
    });
  };

  /** 분쟁 판정 — `disputed`에서만. 결정은 되돌리지 않는다(판정 버튼이 확인을 받는 이유) */
  register('oc.rule', (row, args) => {
    if (args.winner !== 'sponsor' && args.winner !== 'customer') return { error: 'bad-args' };
    const r = decideSettlement(ctx, row.order.orderId, args.winner === 'sponsor' ? 'sponsor_win' : 'customer_win');
    return r.ok ? {} : { error: r.error };
  });

  /** 계좌 이의 판정 (§5.2b) — 계좌가 정말 나빴다(고객 몰수) / 이의에 근거가 없다(후원자 몰수) */
  register('oc.account-dispute', (row, args) => {
    if (args.verdict !== 'account-bad' && args.verdict !== 'sponsor-fault') return { error: 'bad-args' };
    const error = resolveAccountDispute(ctx, row.order.orderId, args.verdict);
    return error ? { error } : {};
  });

  /** 서명 요청을 지금 다시 — 릴리스(사전서명)든 결정된 종결이든 */
  register('oc.resend', row => {
    const { order } = row;
    if (order.state === 'presigned' || order.state === 'remitted') {
      return resendRelease(ctx, row) ? {} : { error: 'no-presig' };
    }
    if (order.state === 'refunding' || (order.state === 'disputed' && order.settlementKind)) {
      return requestSettlementSignature(ctx, order.orderId) ? {} : { error: 'no-material' };
    }
    return { error: 'bad-state' };
  });

  /** 약정 밖의 자금 하나를 고객에게 돌려주는 서명을 요청한다 — 워처가 본 목록에 있는 것만 */
  register('oc.rescue', (row, args) => {
    const { txid, vout } = args;
    const utxo = (row.meta.strays ?? []).find(u => u.txid === txid && u.vout === vout);
    if (!utxo) return { error: 'unknown-utxo' };
    const error = requestRescue(ctx, row.order.orderId, utxo);
    return error ? { error } : {};
  });

  /** 상세를 다시 내 달라 — 버전 확인이 필요 없다 */
  registry.register('oc.detail', (_admin, args): AdminCommandResult => {
    const orderId = args.orderId;
    if (typeof orderId !== 'string' || !getOc(ctx, orderId)) return { ok: false, cmd: 'oc.detail', error: 'unknown-order' };
    requestOcDetail(ctx, orderId);
    return { ok: true, cmd: 'oc.detail', result: { orderId } };
  });
}
