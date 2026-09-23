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
import type { Db } from './db';
import { Dispatcher, tagValue, type Router } from './dispatch';
import { Effects } from './effects';
import type { Logger } from './log';
import { Ingress } from './nostr/ingress';
import { createPublishExecutor, PUBLISH_EFFECT } from './nostr/publisher';
import type { RelayTransport } from './nostr/transport';
import { ADMIN_COMMAND, createAdminHandler } from './admin/commands';
import type { DaemonTags } from './config';
import type { AppKey } from './secrets';

export const DAEMON_VERSION = '0.1.0';

export interface DaemonDeps {
  db: Db;
  transport: RelayTransport;
  appKey: AppKey;
  seed: Uint8Array;
  tags: DaemonTags;
  operators: string[];
  epoch: number;
  lookbackSec: number;
  resubscribeSec: number;
  tickMs: number;
  holdMs: number;
  nowMs: () => number;
  log: Logger;
  /** 있으면 틱마다 하트비트 파일을 쓴다 (docker healthcheck) */
  dataDir?: string;
}

export class Daemon {
  readonly effects: Effects;
  readonly ingress: Ingress;
  readonly dispatcher: Dispatcher;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = true;

  constructor(private readonly deps: DaemonDeps) {
    const { db, nowMs, log } = deps;
    this.effects = new Effects(db, nowMs, log);
    this.effects.register(PUBLISH_EFFECT, createPublishExecutor(deps.transport, nowMs));

    const admin = createAdminHandler({
      db, effects: this.effects, appKey: deps.appKey, operators: new Set(deps.operators),
      adminTag: deps.tags.admin, nowMs, version: DAEMON_VERSION,
    });
    const route: Router = event => {
      const t = tagValue(event, 't');
      const action = tagValue(event, 'action');
      if (t === deps.tags.admin && action === ADMIN_COMMAND) return admin;
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
      await this.effects.runDue();
      this.heartbeat();
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

  private heartbeat(): void {
    const now = this.deps.nowMs();
    this.deps.db.kvSet('heartbeat', String(now));
    if (this.deps.dataDir) writeFileSync(join(this.deps.dataDir, 'heartbeat'), String(now));
  }
}
