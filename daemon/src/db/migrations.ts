/**
 * 스키마 마이그레이션 — **추가만 한다.** 적용된 번호의 SQL을 고치면 이미 뜬 DB와 새 DB가 갈린다.
 */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      -- 설정·커서처럼 한 줄짜리 값
      CREATE TABLE kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- 받은 kind 1111. id가 곧 중복 방지다 (DM-004)
      CREATE TABLE inbox (
        id           TEXT PRIMARY KEY,
        pubkey       TEXT NOT NULL,
        kind         INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        raw          TEXT NOT NULL,
        received_at  INTEGER NOT NULL,
        processed_at INTEGER,
        outcome      TEXT
      );
      CREATE INDEX inbox_pending ON inbox (processed_at, created_at);

      -- 외부 효과의 의도 (§4.5). 실행 전에 죽으면 재시작 뒤 다시 집는다
      CREATE TABLE effects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        dedup       TEXT,
        payload     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        next_at     INTEGER NOT NULL,
        last_error  TEXT,
        created_at  INTEGER NOT NULL,
        finished_at INTEGER
      );
      -- 같은 일을 두 번 쌓지 않는다 — 대기 중인 것끼리만 (끝난 것은 다시 쌓을 수 있다)
      CREATE UNIQUE INDEX effects_dedup_pending ON effects (dedup) WHERE status = 'pending' AND dedup IS NOT NULL;
      CREATE INDEX effects_due ON effects (status, next_at);
    `,
  },
  {
    version: 2,
    sql: `
      -- 사람이 봐야 하는 일. dedup이 같으면 한 번만 울린다 (admin/alerts.ts)
      CREATE TABLE alerts (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup     TEXT NOT NULL UNIQUE,
        level     TEXT NOT NULL,
        track     TEXT,
        order_id  TEXT,
        message   TEXT NOT NULL,
        raised_at INTEGER NOT NULL,
        acked_at  INTEGER
      );
    `,
  },
];
