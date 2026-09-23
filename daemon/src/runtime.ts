/**
 * 데몬 런타임 — 부품을 잇고 한 줄로 돌린다 (PLAN-DAEMON §4.1)
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
import { Ingress } from './nostr/ingress';
import { createPublishExecutor, PUBLISH_EFFECT } from './nostr/publisher';
import type { RelayTransport } from './nostr/transport';
import { createAdminHandler, createBaseCommands, type CommandRegistry } from './admin/commands';
import { createChatForwarder } from './admin/chat';
import type { AdminContext } from './admin/context';
import { STATE_EFFECT, STATE_INTERVAL_MS, createStateExecutor, requestStatePublish } from './admin/state';
import type { DaemonMode, DaemonTags } from './config';
import { EMPTY_DIRECTORY, type OrderDirectory } from './orders/directory';
import type { AppKey } from './secrets';

export const DAEMON_VERSION = '0.2.0';

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
  /** 트랙 모듈이 채운다(P3·P4). 없으면 아무 오더도 모른다 */
  directory?: OrderDirectory;
  /** 있으면 틱마다 하트비트 파일을 쓴다 (docker healthcheck) */
  dataDir?: string;
}

export class Daemon {
  readonly effects: Effects;
  readonly ingress: Ingress;
  readonly dispatcher: Dispatcher;
  readonly admin: AdminContext;
  readonly commands: CommandRegistry;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = true;
  private lastStateRequestMs = -Infinity;

  constructor(private readonly deps: DaemonDeps) {
    const { db, nowMs, log } = deps;
    this.effects = new Effects(db, nowMs, log);

    this.admin = {
      db, effects: this.effects, appKey: deps.appKey, operators: deps.operators, tags: deps.tags,
      mode: deps.mode, relays: deps.relays, directory: deps.directory ?? EMPTY_DIRECTORY,
      version: DAEMON_VERSION, startedAt: Math.floor(nowMs() / 1000), nowMs, log,
    };

    this.effects.register(PUBLISH_EFFECT, createPublishExecutor(deps.transport, nowMs));
    this.effects.register(STATE_EFFECT, createStateExecutor(this.admin, deps.transport));

    this.commands = createBaseCommands();
    const adminHandler = createAdminHandler(this.admin, this.commands);
    const chatForwarder = createChatForwarder(this.admin);

    const route: Router = event => {
      // 우리가 낸 것(어드민이 보낸 분쟁 메시지 등)도 `p=APP`이라 되돌아온다 — 처리할 게 없다
      if (event.pubkey === deps.appKey.pubkey) return null;
      const t = tagValue(event, 't');
      const action = tagValue(event, 'action');
      if (t === deps.tags.admin && action === ADMIN_ACTIONS.COMMAND) return adminHandler;
      if ((t === deps.tags.ln || t === deps.tags.onchain) && action === REQUEST_ACTIONS.DISPUTE_MESSAGE) {
        return chatForwarder;
      }
      return null; // 라이트닝(P3)·온체인(P4) 핸들러가 여기 붙는다
    };
    this.dispatcher = new Dispatcher(db, route, nowMs, deps.holdMs, log);

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
      this.dispatcher.runPending();
      this.heartbeat();
      await this.effects.runDue();
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
