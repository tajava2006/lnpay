/**
 * 하루 한 번 DB 스냅숏
 *
 * `VACUUM INTO`로 데이터 디렉터리 아래 `backups/`에 날짜별 한 벌을 남기고 최근 `keep`벌만 둔다. 오프사이트로
 * 옮기는 건 운영 PC의 기존 백업 루틴 몫이다(이 파일은 그 루틴이 집을 자리를 만든다).
 *
 * DB를 통째로 잃어도 **돈은 시드로 되찾는다**(프리이미지·어드민 키, DM-005). 이 스냅숏이 지키는 건 진행 중인
 * 거래의 장부 — 누가 어느 단계에 있었고 무엇을 결정했는지 — 다.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';
import type { Logger } from './log';

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE = /^daemon-\d{4}-\d{2}-\d{2}\.sqlite$/;

export class Backups {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly nowMs: () => number,
    private readonly log: Logger,
    private readonly keep = 7,
  ) {}

  /** 마지막 스냅숏에서 하루가 지났으면 한 벌 뜬다. 실패는 던지지 않는다 — 거래를 멈출 일이 아니다 */
  maybeRun(): boolean {
    const now = this.nowMs();
    if (now - Number(this.db.kvGet('backup.at') ?? 0) < DAY_MS) return false;
    try {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, `daemon-${new Date(now).toISOString().slice(0, 10)}.sqlite`);
      if (existsSync(path)) unlinkSync(path); // VACUUM INTO는 있는 파일에 쓰지 않는다
      this.db.raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
      this.db.kvSet('backup.at', String(now));
      for (const old of readdirSync(this.dir).filter(f => FILE.test(f)).sort().slice(0, -this.keep)) {
        unlinkSync(join(this.dir, old));
      }
      this.log.info('DB 스냅숏', { path });
      return true;
    } catch (e) {
      this.log.error('DB 스냅숏 실패', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }
}
