/**
 * 라이트닝 트랙 조립 — 효과 실행기·요청 핸들러·명령·워처를 데몬에 붙인다
 */
import type { AdminContext } from '../admin/context';
import type { CommandRegistry } from '../admin/commands';
import type { Db } from '../db';
import type { Handler } from '../dispatch';
import type { RelayTransport } from '../nostr/transport';
import type { OrderDirectory } from '../orders/directory';
import type { Holds } from '../hold';
import type { PushConfig } from '../push/send';
import { registerLnCommands } from './commands';
import type { LnContext } from './context';
import {
  createCloseExecutor, createDetailExecutor, createOrderPublishExecutor, createPayoutExecutor, createProbeExecutor,
} from './effects';
import {
  LN_CLOSE_EFFECT, LN_HOLD_PURPOSES, LN_PAYOUT_EFFECT, LN_PROBE_EFFECT, createLnHoldHooks,
} from './flow';
import { createLnHandlers, knownHeight } from './handlers';
import type { LnNode } from './lnd';
import { LN_DETAIL_EFFECT, LN_ORDER_PUBLISH_EFFECT } from './store';
import { LnWatcher } from './watcher';

export interface LnDeps {
  node: LnNode;
  /** 믿을 수 있는 시세 (없으면 null) */
  price: () => number | null;
  push: PushConfig | null;
}

export interface LnTrack {
  ctx: LnContext;
  watcher: LnWatcher;
  handlers: ReadonlyMap<string, Handler>;
}

/** `ln_orders`로 답하는 오더 목록 (명령 버전 확인·채팅 중계) */
export function createLnDirectory(db: Db): OrderDirectory {
  return {
    lookup(track, orderId) {
      if (track !== 'ln') return null;
      const row = db.get<{ version: number; customer: string; sponsor: string | null }>(
        'SELECT version, customer, sponsor FROM ln_orders WHERE order_id = ?', orderId,
      );
      if (!row) return null;
      return { version: row.version, customer: row.customer, ...(row.sponsor ? { sponsor: row.sponsor } : {}) };
    },
  };
}

export function installLnTrack(
  admin: AdminContext,
  registry: CommandRegistry,
  transport: RelayTransport,
  seed: Uint8Array,
  holds: Holds,
  deps: LnDeps,
): LnTrack {
  const ctx: LnContext = { ...admin, node: deps.node, seed, holds, price: deps.price, push: deps.push };
  const { effects } = ctx;

  holds.register(LN_HOLD_PURPOSES, createLnHoldHooks(ctx));
  effects.register(LN_CLOSE_EFFECT, createCloseExecutor(ctx));
  effects.register(LN_PAYOUT_EFFECT, createPayoutExecutor(ctx));
  effects.register(LN_PROBE_EFFECT, createProbeExecutor(ctx));
  effects.register(LN_ORDER_PUBLISH_EFFECT, createOrderPublishExecutor(ctx, transport));
  effects.register(LN_DETAIL_EFFECT, createDetailExecutor(ctx, transport, () => knownHeight(ctx)));

  registerLnCommands(registry, ctx);
  return { ctx, watcher: new LnWatcher(ctx), handlers: createLnHandlers(ctx) };
}

export type { LnNode } from './lnd';
export { createLndNode } from './lnd';
