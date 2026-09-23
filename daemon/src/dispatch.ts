/**
 * 디스패처 — `inbox`의 이벤트를 핸들러에 한 건씩 넘긴다 (PLAN-DAEMON §4.1 ②)
 *
 * - 받은 뒤 `holdMs`가 지난 것만, **created_at 순으로** 처리한다. 릴레이마다 도착 순서가 달라도
 *   같은 오더의 요청이 앞뒤 바뀌어 판단되지 않게.
 * - 핸들러는 **트랜잭션 안에서, 네트워크 없이** 판단한다. 외부 효과는 의도만 쌓는다.
 * - 핸들러가 던지면 그 쓰기를 되돌리고 이벤트는 `error`로 닫는다. 판단에 네트워크가 없으니 던진다는 건
 *   버그나 이상한 입력이다 — 다시 돌려도 같은 결과라 무한 재시도하지 않는다.
 */
import type { Db } from './db';
import type { Logger } from './log';

export interface InboxEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export type HandlerResult = { outcome: 'ok' } | { outcome: 'ignored'; reason: string };
export type Handler = (event: InboxEvent) => HandlerResult;

/** 이벤트를 어느 핸들러가 받을지. 없으면 null — `ignored:no-route`로 닫는다 */
export type Router = (event: InboxEvent) => Handler | null;

export function tagValue(event: Pick<InboxEvent, 'tags'>, name: string): string | undefined {
  return event.tags.find(t => t[0] === name)?.[1];
}

export class Dispatcher {
  constructor(
    private readonly db: Db,
    private readonly route: Router,
    private readonly nowMs: () => number,
    private readonly holdMs: number,
    private readonly log: Logger,
  ) {}

  /** 처리할 때가 된 이벤트를 전부 처리한다. 처리한 건수를 돌려준다 */
  runPending(limit = 200): number {
    const rows = this.db.all<{ id: string; raw: string }>(
      `SELECT id, raw FROM inbox WHERE processed_at IS NULL AND received_at <= ?
       ORDER BY created_at, id LIMIT ?`,
      this.nowMs() - this.holdMs, limit,
    );
    for (const row of rows) this.process(JSON.parse(row.raw) as InboxEvent);
    return rows.length;
  }

  private process(event: InboxEvent): void {
    const handler = this.route(event);
    if (!handler) {
      this.close(event.id, 'ignored:no-route');
      return;
    }
    try {
      this.db.tx(() => {
        const result = handler(event);
        this.close(event.id, result.outcome === 'ok' ? 'ok' : `ignored:${result.reason}`);
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.close(event.id, `error:${message}`);
      this.log.error('핸들러가 던졌다', { id: event.id, error: message });
    }
  }

  private close(id: string, outcome: string): void {
    this.db.run(`UPDATE inbox SET processed_at = ?, outcome = ? WHERE id = ?`, this.nowMs(), outcome, id);
  }
}
