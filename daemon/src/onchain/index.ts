/**
 * 온체인 트랙 조립 — 보증금 후속 처리·효과·요청 핸들러·명령·워처를 데몬에 붙인다
 *
 * 보증금이 LN 홀드 인보이스라 **라이트닝 노드가 있어야** 돈다(홀드 인보이스 기계를 같이 쓴다).
 */
import type { BtcNetworkName, ChainAdapter } from '@sajwo-tracker/shared/onchain';
import type { AdminContext } from '../admin/context';
import type { CommandRegistry } from '../admin/commands';
import type { Db } from '../db';
import type { Handler } from '../dispatch';
import type { Holds } from '../hold';
import type { RelayTransport } from '../nostr/transport';
import type { OrderDirectory } from '../orders/directory';
import type { PushConfig } from '../push/send';
import { OC_BOND_PURPOSES, createOcBondHooks } from './bonds';
import { registerOcCommands } from './commands';
import type { OcContext } from './context';
import { createBroadcastExecutor, createOcDetailExecutor, createOcPublishExecutor } from './effects';
import { OC_BROADCAST_EFFECT } from './flow';
import { createOcHandlers } from './handlers';
import { OC_DETAIL_EFFECT, OC_ORDER_PUBLISH_EFFECT } from './store';
import { OcWatcher } from './watcher';

export interface OcDeps {
  chain: ChainAdapter;
  network: BtcNetworkName;
  /** 워처 간격 (기본 30초). 테스트가 줄인다 */
  pollMs?: number;
}

export interface OcTrack {
  ctx: OcContext;
  watcher: OcWatcher;
  handlers: ReadonlyMap<string, Handler>;
}

/** `oc_orders`로 답하는 오더 목록 (명령 버전 확인·채팅 중계) */
export function createOcDirectory(db: Db): OrderDirectory {
  return {
    lookup(track, orderId) {
      if (track !== 'onchain') return null;
      const row = db.get<{ version: number; data: string }>('SELECT version, data FROM oc_orders WHERE order_id = ?', orderId);
      if (!row) return null;
      const data = JSON.parse(row.data) as { customerPubkey: string; sponsorPubkey?: string };
      return { version: row.version, customer: data.customerPubkey, ...(data.sponsorPubkey ? { sponsor: data.sponsorPubkey } : {}) };
    },
  };
}

export function installOcTrack(
  admin: AdminContext,
  registry: CommandRegistry,
  transport: RelayTransport,
  holds: Holds,
  shared: { seed: Uint8Array; price: () => number | null; push: PushConfig | null },
  deps: OcDeps,
): OcTrack {
  const ctx: OcContext = { ...admin, holds, chain: deps.chain, network: deps.network, ...shared };
  holds.register(OC_BOND_PURPOSES, createOcBondHooks(ctx));
  ctx.effects.register(OC_ORDER_PUBLISH_EFFECT, createOcPublishExecutor(ctx, transport));
  ctx.effects.register(OC_DETAIL_EFFECT, createOcDetailExecutor(ctx, transport));
  ctx.effects.register(OC_BROADCAST_EFFECT, createBroadcastExecutor(ctx));
  registerOcCommands(registry, ctx);
  return { ctx, watcher: new OcWatcher(ctx, deps.pollMs), handlers: createOcHandlers(ctx) };
}
