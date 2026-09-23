/**
 * SQLite — 데몬 상태의 진실 (PLAN-DAEMON §4.2)
 *
 * 쓰기 경로가 하나라서(DM-001) 동시성 제어가 필요 없다. 필요한 건 **원자성**뿐이다 — 상태 전이와
 * 그에 따른 효과 의도를 한 트랜잭션에 넣는다(DM-002).
 *
 * `node:sqlite`는 동기 API다. 트랜잭션 안에서 await하지 않는다 — 판단(핸들러)은 네트워크를 부르지
 * 않으므로 그럴 일이 없다. 네트워크는 효과 워커가 트랜잭션 **밖에서** 부른다.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

export type SqlParam = SQLInputValue;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  /**
   * 트랜잭션. 던지면 되돌린다.
   *
   * 중첩되면 **세이브포인트**가 된다 — 안쪽이 던진 걸 바깥이 잡고 계속 가도 안쪽 쓰기만 되돌아간다.
   * (그냥 합류시키면 잡힌 예외의 반쯤 쓴 상태가 바깥과 함께 커밋된다.)
   */
  tx<T>(fn: () => T): T {
    const name = this.depth === 0 ? null : `sp${this.depth}`;
    this.raw.exec(name ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = fn();
      this.raw.exec(name ? `RELEASE ${name}` : 'COMMIT');
      return result;
    } catch (e) {
      this.raw.exec(name ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
      throw e;
    } finally {
      this.depth -= 1;
    }
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  kvGet(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value;
  }

  kvSet(key: string, value: string): void {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  close(): void {
    this.raw.close();
  }

  /** `PRAGMA user_version`으로 어디까지 적용했는지 센다. 이미 적용한 것은 건너뛴다 */
  private migrate(): void {
    const current = Number(this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.raw.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
  }
}
