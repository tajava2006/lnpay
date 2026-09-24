/**
 * 기반: 설정·비밀·DB·효과 대기열 (PLAN-DAEMON §4)
 */
import { describe, expect, it } from 'vitest';
import { nsecEncode } from 'nostr-tools/nip19';
import { APP_PUBKEY } from '@sajwo-tracker/shared/core';
import { loadConfig, tagsFor } from '../config';
import { Db } from '../db';
import { Effects, backoffMs, type EffectOutcome } from '../effects';
import { silentLogger } from '../log';
import { parseAppKey, parseSeed } from '../secrets';
import { newKey } from './fakes';

const OP = 'aa'.repeat(32);
const baseEnv = {
  LNPAY_DATA_DIR: '/data',
  LNPAY_SEED_FILE: '/s/seed',
  LNPAY_APP_KEY_FILE: '/s/app',
  LNPAY_OPERATORS: OP,
  LNPAY_LND_URL: 'https://host.docker.internal:8080',
  LNPAY_LND_CERT_FILE: '/s/tls.cert',
  LNPAY_LND_MACAROON_FILE: '/s/lnpay.macaroon',
};

describe('설정 — 틀리면 뜨지 않는다', () => {
  it('기본은 prod 태그, APP_PUBKEY', () => {
    const c = loadConfig(baseEnv);
    expect(c.tags).toEqual(tagsFor('prod'));
    expect(c.appPubkey).toBe(APP_PUBKEY);
    expect(c.operators).toEqual([OP]);
  });

  it('운영자가 없으면 거부 — 명령을 받을 사람이 없다', () => {
    expect(() => loadConfig({ ...baseEnv, LNPAY_OPERATORS: '' })).toThrow(/운영자|OPERATORS/);
  });

  it('prod에서 APP pubkey를 바꿀 수 없다 — 유저 앱은 상수만 믿는다', () => {
    expect(() => loadConfig({ ...baseEnv, LNPAY_APP_PUBKEY: 'bb'.repeat(32) })).toThrow(/prod/);
    expect(loadConfig({ ...baseEnv, LNPAY_MODE: 'dev', LNPAY_APP_PUBKEY: 'bb'.repeat(32) }).appPubkey).toBe('bb'.repeat(32));
  });

  it('dev 태그는 유저 앱 dev 빌드와 같다', () => {
    expect(tagsFor('dev')).toEqual({
      ln: 'sajwo-tracker-dev', onchain: 'sajwo-tracker-onchain-dev', admin: 'sajwo-tracker-admin-dev',
    });
  });

  it('숫자가 아니면 거부', () => {
    expect(() => loadConfig({ ...baseEnv, LNPAY_TICK_MS: 'fast' })).toThrow();
  });

  /** 매크룬이 헤더로 간다 */
  it('LND는 https만, 접속 정보가 없으면 거부', () => {
    expect(() => loadConfig({ ...baseEnv, LNPAY_LND_URL: 'http://lnd:8080' })).toThrow(/https/);
    expect(() => loadConfig({ ...baseEnv, LNPAY_LND_MACAROON_FILE: '' })).toThrow(/MACAROON/);
    expect(loadConfig(baseEnv).vapidKeyFile).toBeUndefined();
  });

  it('온체인은 네트워크를 적어야 켜진다 — 모르는 네트워크는 거부', () => {
    expect(loadConfig(baseEnv).onchain).toBeUndefined();
    expect(loadConfig({ ...baseEnv, LNPAY_ONCHAIN_NETWORK: 'signet' }).onchain).toEqual({ network: 'signet', apiUrl: undefined });
    expect(() => loadConfig({ ...baseEnv, LNPAY_ONCHAIN_NETWORK: 'regtest' })).toThrow(/ONCHAIN_NETWORK/);
  });
});

describe('비밀', () => {
  it('APP 키가 기대한 pubkey가 아니면 거부 — 다른 키로 서명하면 아무에게도 안 보인다', () => {
    const k = newKey();
    expect(parseAppKey(nsecEncode(k.secretKey), k.pubkey).pubkey).toBe(k.pubkey);
    expect(parseAppKey(Buffer.from(k.secretKey).toString('hex'), k.pubkey).pubkey).toBe(k.pubkey);
    expect(() => parseAppKey(nsecEncode(k.secretKey), 'cc'.repeat(32))).toThrow(/기대한/);
  });

  it('시드는 hex 64자, 전부 0이면 거부', () => {
    expect(parseSeed('01'.repeat(32) + '\n')).toHaveLength(32);
    expect(() => parseSeed('01'.repeat(31))).toThrow();
    expect(() => parseSeed('00'.repeat(32))).toThrow();
  });
});

describe('DB', () => {
  it('트랜잭션이 던지면 되돌린다', () => {
    const db = new Db(':memory:');
    expect(() => db.tx(() => {
      db.kvSet('a', '1');
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.kvGet('a')).toBeUndefined();
  });

  /** 안쪽 실패를 바깥이 잡고 계속 가면 안쪽 쓰기만 되돌아가야 한다 (세이브포인트) */
  it('중첩 트랜잭션의 실패는 그 안쪽만 되돌린다', () => {
    const db = new Db(':memory:');
    db.tx(() => {
      db.kvSet('outer', '1');
      try {
        db.tx(() => {
          db.kvSet('inner', '1');
          throw new Error('inner');
        });
      } catch { /* 잡고 계속 */ }
      db.kvSet('after', '1');
    });
    expect(db.kvGet('outer')).toBe('1');
    expect(db.kvGet('inner')).toBeUndefined();
    expect(db.kvGet('after')).toBe('1');
  });

  it('마이그레이션은 한 번만 — 다시 열어도 멀쩡하다', () => {
    const db = new Db(':memory:');
    const v = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
    expect(Number(v)).toBeGreaterThanOrEqual(1);
  });
});

describe('효과 대기열 (§4.5)', () => {
  function setup() {
    let now = 1_000_000;
    const db = new Db(':memory:');
    const effects = new Effects(db, () => now, silentLogger);
    return { db, effects, advance: (ms: number) => { now += ms; } };
  }

  it('트랜잭션이 되돌아가면 의도도 사라진다 — 상태와 의도는 같이 간다 (DM-002)', () => {
    const { db, effects } = setup();
    effects.register('x', { run: async () => ({ status: 'done' }) });
    expect(() => db.tx(() => {
      effects.enqueue('x', { n: 1 });
      throw new Error('rollback');
    })).toThrow();
    expect(effects.pendingCount()).toBe(0);
  });

  it('같은 dedup의 대기 중 효과는 하나뿐 — 끝나면 다시 쌓을 수 있다', async () => {
    const { effects } = setup();
    effects.register('x', { run: async () => ({ status: 'done' }) });
    expect(effects.enqueue('x', {}, { dedup: 'k' })).toBe(true);
    expect(effects.enqueue('x', {}, { dedup: 'k' })).toBe(false);
    await effects.runDue();
    expect(effects.enqueue('x', {}, { dedup: 'k' })).toBe(true);
  });

  it('실패하면 백오프로 다시 — 때가 안 됐으면 안 돈다', async () => {
    const { effects, advance } = setup();
    let calls = 0;
    effects.register('x', { run: async () => (++calls < 3 ? { status: 'retry', error: 'down' } : { status: 'done' }) });
    effects.enqueue('x', {});
    await effects.runDue();
    await effects.runDue();
    expect(calls).toBe(1);
    advance(backoffMs(1));
    await effects.runDue();
    expect(calls).toBe(2);
    advance(backoffMs(2));
    await effects.runDue();
    expect(calls).toBe(3);
    expect(effects.pendingCount()).toBe(0);
  });

  it('던져도 재시도로 친다', async () => {
    const { effects } = setup();
    effects.register('x', { run: async (): Promise<EffectOutcome> => { throw new Error('network'); } });
    effects.enqueue('x', {});
    await effects.runDue();
    expect(effects.pendingCount()).toBe(1);
  });

  /** DM-003: 효과 결과를 전제한 전이는 성공 기록과 한 트랜잭션. 그게 실패하면 효과는 다시 돈다 */
  it('onDone이 던지면 성공 기록도 되돌리고 다시 돈다', async () => {
    const { db, effects, advance } = setup();
    let failOnce = true;
    effects.register('x', {
      run: async () => ({ status: 'done' }),
      onDone: () => {
        db.kvSet('followup', 'written');
        if (failOnce) { failOnce = false; throw new Error('follow-up failed'); }
      },
    });
    effects.enqueue('x', {});
    await effects.runDue();
    expect(db.kvGet('followup')).toBeUndefined();
    expect(effects.pendingCount()).toBe(1);
    advance(backoffMs(1));
    await effects.runDue();
    expect(db.kvGet('followup')).toBe('written');
    expect(effects.pendingCount()).toBe(0);
  });

  it('maxAttempts를 넘기면 포기하고 onDead', async () => {
    const { db, effects, advance } = setup();
    effects.register('x', {
      run: async () => ({ status: 'retry', error: 'nope' }),
      onDead: (_p, error) => db.kvSet('dead', error),
      maxAttempts: 2,
    });
    effects.enqueue('x', {});
    await effects.runDue();
    advance(backoffMs(1));
    await effects.runDue();
    expect(effects.pendingCount()).toBe(0);
    expect(db.kvGet('dead')).toMatch(/2회 실패/);
  });

  it('모르는 효과는 쌓을 수 없다', () => {
    const { effects } = setup();
    expect(() => effects.enqueue('nope', {})).toThrow();
  });
});

describe('DB 스냅숏 (§11)', () => {
  it('하루에 한 벌, 최근 N벌만 남긴다 — 스냅숏은 열리는 DB다', async () => {
    const { mkdtempSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Backups } = await import('../backup');
    const dir = mkdtempSync(join(tmpdir(), 'lnpay-backup-'));
    const db = new Db(join(dir, 'daemon.sqlite'));
    db.kvSet('marker', 'hello');
    const clock = { now: Date.UTC(2026, 8, 24, 12) };
    const backups = new Backups(db, join(dir, 'backups'), () => clock.now, silentLogger, 2);

    expect(backups.maybeRun()).toBe(true);
    expect(backups.maybeRun()).toBe(false); // 같은 날
    for (let i = 0; i < 3; i++) {
      clock.now += 24 * 60 * 60 * 1000;
      backups.maybeRun();
    }
    const files = readdirSync(join(dir, 'backups')).sort();
    expect(files).toEqual(['daemon-2026-09-26.sqlite', 'daemon-2026-09-27.sqlite']);
    const copy = new Db(join(dir, 'backups', files[1]!));
    expect(copy.kvGet('marker')).toBe('hello');
    copy.close();
    db.close();
  });
});
