/**
 * 데몬 런타임 — 부품을 잇고 한 줄로 돌린다
 *
 * ```
 * 수신(ingress) → inbox → [틱] 디스패치 → 효과 실행 → 하트비트
 * ```
 *
 * 틱은 정해진 간격으로 돌고, 새 이벤트가 들어오면 `holdMs` 뒤로 **앞당긴다** — 운영자 명령에 15초씩
 * 기다리지 않게. 틱은 겹치지 않는다(한 번에 하나).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_ACTIONS, REQUEST_ACTIONS } from '@sajwo-tracker/shared/core';
import type { Db } from './db';
import { Dispatcher, tagValue, type Router } from './dispatch';
import { Effects } from './effects';
import type { Logger } from './log';
import { Ingress, resolveEpoch } from './nostr/ingress';
import { assertDataDirFits } from './guards';
import { createPublishExecutor, PUBLISH_EFFECT } from './nostr/publisher';
import type { RelayTransport } from './nostr/transport';
import { createAdminHandler, createBaseCommands, type CommandRegistry } from './admin/commands';
import { createChatForwarder } from './admin/chat';
import type { AdminContext } from './admin/context';
import { STATE_EFFECT, STATE_INTERVAL_MS, createStateExecutor, requestStatePublish } from './admin/state';
import type { DaemonMode, DaemonTags } from './config';
import { composeDirectories, type OrderDirectory } from './orders/directory';
import { raiseStuckEffects } from './admin/stuck';
import { Backups } from './backup';
import { Holds } from './hold';
import { createLnDirectory, installLnTrack, type LnDeps, type LnTrack } from './ln';
import { createOcDirectory, installOcTrack, type OcDeps, type OcTrack } from './onchain';
import { PUSH_EFFECT, createPushExecutor } from './push/send';
import type { AppKey } from './secrets';

export const DAEMON_VERSION = '0.3.0';

export interface DaemonDeps {
  db: Db;
  transport: RelayTransport;
  appKey: AppKey;
  seed: Uint8Array;
  mode: DaemonMode;
  tags: DaemonTags;
  relays: string[];
  operators: string[];
  epoch: number;
  lookbackSec: number;
  resubscribeSec: number;
  tickMs: number;
  holdMs: number;
  nowMs: () => number;
  log: Logger;
  /** 라이트닝 트랙 (노드·시세·푸시). 없으면 라이트닝 요청을 받지 않는다 — 테스트가 명령 채널만 볼 때 */
  ln?: LnDeps;
  /** 온체인 트랙 (체인·네트워크). 보증금이 LN이라 `ln`이 있어야 한다. 없으면 온체인 요청을 받지 않는다 */
  onchain?: OcDeps;
  /** 테스트가 오더를 심는 목록. 트랙 목록 앞에 붙는다 */
  directory?: OrderDirectory;
  /** 유저 앱 주소 (`DaemonConfig.appUrl`) */
  appUrl?: string;
  /** 있으면 틱마다 하트비트 파일을 쓴다 (docker healthcheck) */
  dataDir?: string;
}

export class Daemon {
  readonly effects: Effects;
  readonly ingress: Ingress;
  readonly dispatcher: Dispatcher;
  readonly admin: AdminContext;
  readonly commands: CommandRegistry;
  readonly ln: LnTrack | null;
  readonly onchain: OcTrack | null;
  readonly holds: Holds | null;
  private readonly backups: Backups | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = true;
  private lastStateRequestMs = -Infinity;

  constructor(private readonly deps: DaemonDeps) {
    const { db, nowMs, log } = deps;
    this.effects = new Effects(db, nowMs, log);

    if (deps.onchain && !deps.ln) throw new Error('온체인 트랙은 라이트닝 노드가 있어야 한다 (보증금이 홀드 인보이스다)');
    assertDataDirFits(db, { mode: deps.mode, onchainNetwork: deps.onchain?.network });
    const directory = composeDirectories([
      ...(deps.directory ? [deps.directory] : []),
      ...(deps.ln ? [createLnDirectory(db)] : []),
      ...(deps.onchain ? [createOcDirectory(db)] : []),
    ]);
    this.admin = {
      db, effects: this.effects, appKey: deps.appKey, operators: deps.operators, tags: deps.tags,
      mode: deps.mode, relays: deps.relays, directory,
      version: DAEMON_VERSION, startedAt: Math.floor(nowMs() / 1000), epoch: resolveEpoch(db, deps.epoch), nowMs, log,
      ...(deps.appUrl ? { appUrl: deps.appUrl } : {}),
    };

    this.effects.register(PUBLISH_EFFECT, createPublishExecutor(deps.transport, nowMs));
    this.effects.register(STATE_EFFECT, createStateExecutor(this.admin, deps.transport));

    this.commands = createBaseCommands();
    const adminHandler = createAdminHandler(this.admin, this.commands);
    const chatForwarder = createChatForwarder(this.admin);
    // 홀드 인보이스(라이트닝 에스크로·보증금, 온체인 보증금)는 LN 노드가 있어야 돈다
    this.holds = deps.ln ? new Holds({ ...this.admin, node: deps.ln.node, seed: deps.seed }) : null;
    this.holds?.install();
    if (deps.ln) this.effects.register(PUSH_EFFECT, createPushExecutor(db, deps.ln.push, nowMs, log));
    this.ln = deps.ln && this.holds
      ? installLnTrack(this.admin, this.commands, deps.transport, deps.seed, this.holds, deps.ln)
      : null;
    this.onchain = deps.onchain && deps.ln && this.holds
      ? installOcTrack(this.admin, this.commands, deps.transport, this.holds,
        { seed: deps.seed, price: deps.ln.price, push: deps.ln.push }, deps.onchain)
      : null;
    const lnHandlers = this.ln?.handlers;
    const ocHandlers = this.onchain?.handlers;

    const route: Router = event => {
      // 우리가 낸 것(어드민이 보낸 분쟁 메시지 등)도 `p=APP`이라 되돌아온다 — 처리할 게 없다
      if (event.pubkey === deps.appKey.pubkey) return null;
      const t = tagValue(event, 't');
      const action = tagValue(event, 'action');
      if (t === deps.tags.admin && action === ADMIN_ACTIONS.COMMAND) return adminHandler;
      if (action === ADMIN_ACTIONS.COMMAND) {
        // 어드민 앱을 다른 모드로 띄웠다(`pnpm dev:admin`은 -dev 태그) — 서로 못 보는데 아무 말이 없으면 한참 헤맨다
        log.warn('다른 모드의 운영자 명령 — 어드민 앱 빌드 모드와 LNPAY_MODE를 맞춰야 한다', {
          got: t ?? null, expected: deps.tags.admin, from: event.pubkey.slice(0, 8),
        });
        return null;
      }
      if ((t === deps.tags.ln || t === deps.tags.onchain) && action === REQUEST_ACTIONS.DISPUTE_MESSAGE) {
        return chatForwarder;
      }
      if (t === deps.tags.ln && action && lnHandlers) return lnHandlers.get(action) ?? null;
      if (t === deps.tags.onchain && action && ocHandlers) return ocHandlers.get(action) ?? null;
      return null;
    };
    this.dispatcher = new Dispatcher(db, route, nowMs, deps.holdMs, log);

    this.backups = deps.dataDir ? new Backups(db, join(deps.dataDir, 'backups'), nowMs, log) : null;

    this.ingress = new Ingress(db, deps.transport, {
      appPubkey: deps.appKey.pubkey,
      epoch: deps.epoch,
      lookbackSec: deps.lookbackSec,
      resubscribeSec: deps.resubscribeSec,
    }, nowMs, log, () => this.poke());
  }

  start(): void {
    this.stopped = false;
    this.ingress.start();
    this.schedule(0);
    this.deps.log.info('데몬 시작', { version: DAEMON_VERSION, since: this.ingress.since() });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ingress.stop();
    // 도는 중인 틱이 끝나길 기다린다 — 효과 실행 도중에 DB를 닫지 않게
    while (this.ticking) await new Promise(r => setTimeout(r, 20));
    this.deps.log.info('데몬 정지');
  }

  /** 한 바퀴. 테스트는 이걸 직접 부른다 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.onchain) await this.onchain.watcher.refreshFees();
      this.dispatcher.runPending();
      // 인보이스 관찰이 먼저 — 결제된 것이 시계 판단(미납 → 취소)보다 앞서야 한다
      if (this.holds) await this.holds.poll();
      if (this.ln) await this.ln.watcher.poll();
      if (this.onchain) await this.onchain.watcher.poll();
      this.deps.db.tx(() => raiseStuckEffects(this.admin));
      this.heartbeat();
      await this.effects.runDue();
      this.backups?.maybeRun();
    } catch (e) {
      this.deps.log.error('틱 실패', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.ticking = false;
    }
  }

  /** 새 이벤트가 왔다 — 묵힘 시간 뒤로 틱을 앞당긴다 */
  private poke(): void {
    if (!this.stopped) this.schedule(this.deps.holdMs + 50);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick();
      if (!this.stopped && !this.timer) this.schedule(this.deps.tickMs);
    }, delayMs);
  }

  /** 하트비트 — 파일(docker), 그리고 주기적으로 운영자 상태 발행 */
  private heartbeat(): void {
    const now = this.deps.nowMs();
    this.deps.db.kvSet('heartbeat', String(now));
    if (this.deps.dataDir) writeFileSync(join(this.deps.dataDir, 'heartbeat'), String(now));
    if (now - this.lastStateRequestMs >= STATE_INTERVAL_MS) {
      this.lastStateRequestMs = now;
      this.deps.db.tx(() => requestStatePublish(this.admin));
    }
  }
}
