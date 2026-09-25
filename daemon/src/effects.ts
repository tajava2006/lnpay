/**
 * 외부 효과 대기열 (DM-002 · 003)
 *
 * 돈이 움직이거나 밖으로 나가는 일(LN settle/cancel/pay, 브로드캐스트, 발행, 푸시)은 전부
 * **의도 → 실행 → 기록** 3단으로 간다:
 *
 * ```
 * 핸들러 트랜잭션:  상태 전이 + enqueue(의도)        ← 함께 커밋되거나 함께 사라진다
 * 워커:             run(payload)                    ← 트랜잭션 밖, 네트워크
 * 기록 트랜잭션:    done 표시 + onDone(후속 전이)   ← 효과 결과를 전제한 전이는 여기서만
 * ```
 *
 * 실행 도중·기록 직전에 죽으면 재시작 뒤 **다시 실행한다.** 그래서 모든 실행기는 멱등이어야 한다
 * (settle 전에 조회, 같은 서명 이벤트를 재발행 등).
 */
import type { Db } from './db';
import type { Logger } from './log';

export type EffectOutcome =
  | { status: 'done'; result?: unknown }
  | { status: 'retry'; error: string; delayMs?: number }
  | { status: 'dead'; error: string };

export interface EffectExecutor<P> {
  run(payload: P): Promise<EffectOutcome>;
  /**
   * 성공을 기록하는 **같은 트랜잭션** 안에서 부른다 — 효과의 결과를 전제한 후속 전이는 여기서 한다
   * (DM-003: settle 성공 → `paid`). 던지면 성공 기록도 되돌아가고 효과는 다시 돈다.
   */
  onDone?(payload: P, result: unknown): void;
  /** 포기했을 때 (경보 자리) — 역시 기록 트랜잭션 안 */
  onDead?(payload: P, error: string): void;
  /** 재시도로 미룰 때 — 실패 사유를 남길 자리(지급 오류 등). 재시도 기록과 같은 트랜잭션 */
  onRetry?(payload: P, error: string): void;
  /** 이만큼 실패하면 포기한다. 기본은 포기하지 않는다 — 돈이 걸린 효과는 대개 끝까지 가야 한다 */
  maxAttempts?: number;
}

interface EffectRow {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
}

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 10 * 60_000;

/** 5초에서 시작해 두 배씩, 10분에서 멈춘다 */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
}

export class Effects {
  private readonly executors = new Map<string, EffectExecutor<unknown>>();
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  register<P>(kind: string, executor: EffectExecutor<P>): void {
    if (this.executors.has(kind)) throw new Error(`효과 실행기 중복 등록: ${kind}`);
    this.executors.set(kind, executor as EffectExecutor<unknown>);
  }

  /**
   * 의도를 쌓는다. **부르는 쪽의 트랜잭션 안에서** 부른다 — 상태 전이와 함께 커밋돼야 한다.
   *
   * `dedup`이 같은 대기 중 효과가 있으면 쌓지 않고 false를 돌려준다. 오더 발행처럼 "최신 상태로
   * 한 번 내면 되는" 일을 합칠 때 쓴다.
   */
  enqueue<P>(kind: string, payload: P, opts: { dedup?: string; delayMs?: number } = {}): boolean {
    if (!this.executors.has(kind)) throw new Error(`모르는 효과: ${kind}`);
    const now = this.now();
    const r = this.db.run(
      `INSERT OR IGNORE INTO effects (kind, dedup, payload, next_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      kind, opts.dedup ?? null, JSON.stringify(payload), now + (opts.delayMs ?? 0), now,
    );
    return r.changes > 0;
  }

  /** 때가 된 효과를 순서대로 실행한다. 이미 도는 중이면 건너뛴다(재진입 없음) */
  async runDue(limit = 50): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.db.all<EffectRow>(
        `SELECT id, kind, payload, attempts FROM effects
         WHERE status = 'pending' AND next_at <= ? ORDER BY next_at, id LIMIT ?`,
        this.now(), limit,
      );
      for (const row of due) await this.runOne(row);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  /** 기다리는 효과를 지금 당장 돌게 앞당긴다 (운영자의 "다시 시도"). 있었으면 true */
  expedite(dedup: string): boolean {
    return this.db.run(
      `UPDATE effects SET next_at = ? WHERE dedup = ? AND status = 'pending'`, this.now(), dedup,
    ).changes > 0;
  }

  pendingCount(kind?: string): number {
    const row = kind
      ? this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM effects WHERE status = 'pending' AND kind = ?`, kind)
      : this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM effects WHERE status = 'pending'`);
    return Number(row?.n ?? 0);
  }

  private async runOne(row: EffectRow): Promise<void> {
    const executor = this.executors.get(row.kind);
    if (!executor) {
      this.finish(row.id, 'dead', `모르는 효과: ${row.kind}`);
      return;
    }
    const payload: unknown = JSON.parse(row.payload);

    let outcome: EffectOutcome;
    try {
      outcome = await executor.run(payload);
    } catch (e) {
      outcome = { status: 'retry', error: e instanceof Error ? e.message : String(e) };
    }

    if (outcome.status === 'done') {
      try {
        this.db.tx(() => {
          this.finish(row.id, 'done', null);
          executor.onDone?.(payload, outcome.result);
        });
      } catch (e) {
        // 후속 전이가 실패했다 — 성공 기록까지 되돌렸으니 효과를 다시 돌린다(멱등)
        this.retry(row, executor, `onDone 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (outcome.status === 'dead') {
      this.kill(row, executor, payload, outcome.error);
      return;
    }

    this.retry(row, executor, outcome.error, outcome.delayMs);
  }

  private retry(row: EffectRow, executor: EffectExecutor<unknown>, error: string, delayMs?: number): void {
    const attempts = row.attempts + 1;
    if (executor.maxAttempts !== undefined && attempts >= executor.maxAttempts) {
      this.kill({ ...row, attempts }, executor, JSON.parse(row.payload), `${attempts}회 실패: ${error}`);
      return;
    }
    this.db.tx(() => {
      this.db.run(
        `UPDATE effects SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?`,
        attempts, this.now() + (delayMs ?? backoffMs(attempts)), error, row.id,
      );
      executor.onRetry?.(JSON.parse(row.payload), error);
    });
    this.log.warn('효과 재시도 예정', { id: row.id, kind: row.kind, attempts, error });
  }

  private kill(row: EffectRow, executor: EffectExecutor<unknown>, payload: unknown, error: string): void {
    this.db.tx(() => {
      this.db.run(`UPDATE effects SET attempts = ? WHERE id = ?`, row.attempts, row.id);
      this.finish(row.id, 'dead', error);
      executor.onDead?.(payload, error);
    });
    this.log.error('효과 포기', { id: row.id, kind: row.kind, error });
  }

  private finish(id: number, status: 'done' | 'dead', error: string | null): void {
    this.db.run(
      `UPDATE effects SET status = ?, last_error = COALESCE(?, last_error), finished_at = ? WHERE id = ?`,
      status, error, this.now(), id,
    );
  }
}
