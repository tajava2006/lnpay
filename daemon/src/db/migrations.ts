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
  {
    version: 3,
    sql: `
      -- 라이트닝 오더. 공개 이벤트(30402)의 원천 — 발행은 이 행의 투영이다
      CREATE TABLE ln_orders (
        order_id              TEXT PRIMARY KEY,
        state                 TEXT NOT NULL,
        customer              TEXT NOT NULL,
        sponsor               TEXT,
        price                 INTEGER NOT NULL,
        deadline              INTEGER NOT NULL,
        payout_sat            INTEGER,
        escrow_hash           TEXT,
        escrow_bolt11         TEXT,
        escrow_settled        INTEGER NOT NULL DEFAULT 0,
        sponsor_invoice       TEXT,
        disbursed             INTEGER NOT NULL DEFAULT 0,
        payout_error          TEXT,
        customer_deposit_hash TEXT,
        sponsor_deposit_hash  TEXT,
        pending_close         TEXT,
        close_reason          TEXT,
        claimed_at            INTEGER,
        account_sent_at       INTEGER,
        account_commitment    TEXT,
        remitted_at           INTEGER,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        version               INTEGER NOT NULL DEFAULT 1,
        published_at          INTEGER NOT NULL DEFAULT 0
      );

      -- 고객 보증금을 기다리는 의뢰 — 결제되면 ln_orders로 간다
      CREATE TABLE ln_drafts (
        order_id    TEXT PRIMARY KEY,
        customer    TEXT NOT NULL,
        price       INTEGER NOT NULL,
        deadline    INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );

      -- 우리가 낸 홀드 인보이스 전부. 프리이미지는 저장하지 않는다 — 시드에서 다시 만든다(DM-005)
      CREATE TABLE ln_invoices (
        payment_hash       TEXT PRIMARY KEY,
        purpose            TEXT NOT NULL,
        order_id           TEXT NOT NULL,
        party              TEXT NOT NULL,
        attempt            INTEGER NOT NULL,
        amount_sat         INTEGER NOT NULL,
        bolt11             TEXT NOT NULL,
        pay_by             INTEGER NOT NULL,
        cltv_blocks        INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'open',
        htlc_expiry_height INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        UNIQUE (purpose, order_id, party, attempt)
      );
      CREATE INDEX ln_invoices_order ON ln_invoices (order_id);
      CREATE INDEX ln_invoices_live ON ln_invoices (status);

      -- 웹 푸시 구독 (유저가 push-subscription으로 등록)
      CREATE TABLE push_subs (
        endpoint   TEXT PRIMARY KEY,
        pubkey     TEXT NOT NULL,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        dead_at    INTEGER
      );
      CREATE INDEX push_subs_pubkey ON push_subs (pubkey);

      -- 한 번만 보내야 하는 알림 (같은 전이를 두 번 울리지 않게)
      CREATE TABLE notices (
        key     TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL
      );
    `,
  },
];
