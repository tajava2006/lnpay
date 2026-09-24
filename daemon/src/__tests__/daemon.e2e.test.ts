/**
 * P1 완료 기준 (PLAN-DAEMON §13): 가짜 릴레이 상대로 "받은 요청 → 발행" 한 바퀴 + 크래시 재시작.
 *
 * 운영자가 `ping`을 보내면 데몬이 결과를 암호화해 돌려준다. 이 한 바퀴가 수신(커서·중복)·디스패치·
 * 명령 확인·효과 대기열·발행을 전부 지난다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { tagsFor } from '../config';
import { Db } from '../db';
import { silentLogger } from '../log';
import { backoffMs } from '../effects';
import { DAEMON_VERSION, type Daemon } from '../runtime';
import { ADMIN_ACTIONS } from '@sajwo-tracker/shared/core';
import { TEST_TAGS as TAGS, adminCommand, createHarness, newKey, openResult, type Harness } from './fakes';

const harness = () => createHarness();
const sec = (h: Harness) => h.sec();
const settle = (h: Harness, daemon: Daemon) => h.settle(daemon);

const isResult = (e: Event) => e.tags.some(t => t[0] === 'action' && t[1] === ADMIN_ACTIONS.RESULT);
const results = (h: Harness): Event[] => h.relay.published.filter(isResult);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('운영자 ping — 받은 요청 → 발행 한 바퀴', () => {
  it('결과를 운영자에게 암호화해 돌려준다', async () => {
    const h = harness();
    const daemon = h.start(new Db(':memory:'));
    const cmd = adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h));
    h.relay.inject(cmd);

    await settle(h, daemon);

    const out = results(h);
    expect(out).toHaveLength(1);
    expect(out[0]!.pubkey).toBe(h.app.pubkey);
    expect(out[0]!.tags).toContainEqual(['e', cmd.id]);
    expect(out[0]!.tags).toContainEqual(['p', h.operator.pubkey]);
    expect(openResult(out[0]!, h.operator, h.app.pubkey)).toEqual({
      ok: true, cmd: 'ping', result: { pong: sec(h), version: DAEMON_VERSION },
    });
  });

  it('묵힘 시간 안에는 처리하지 않는다 — 릴레이마다 도착 순서가 다르다', async () => {
    const h = harness();
    const daemon = h.start(new Db(':memory:'));
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h)));
    await daemon.tick();
    expect(results(h)).toHaveLength(0);
    await settle(h, daemon);
    expect(results(h)).toHaveLength(1);
  });

  it('모르는 명령도 거절을 돌려준다 — 조용히 버리면 어드민 화면이 "처리 중"에서 안 넘어간다', async () => {
    const h = harness();
    const daemon = h.start(new Db(':memory:'));
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'launch-missiles' }, sec(h)));
    await settle(h, daemon);
    expect(openResult(results(h)[0]!, h.operator, h.app.pubkey)).toEqual({
      ok: false, cmd: 'launch-missiles', error: 'unknown-command',
    });
  });
});

describe('명령 확인 (§5.2)', () => {
  it('운영자가 아니면 집행하지도 답하지도 않는다', async () => {
    const h = harness();
    const daemon = h.start(new Db(':memory:'));
    const stranger = newKey();
    h.relay.inject(adminCommand(stranger, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h)));
    await settle(h, daemon);
    expect(results(h)).toHaveLength(0);
  });

  /** 폰에서 눌러놓고 한참 뒤 전달된 명령이 뒤늦게 집행되면 안 된다 */
  it('10분 넘은 명령은 버린다', async () => {
    const h = harness();
    const daemon = h.start(new Db(':memory:'));
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h) - 11 * 60));
    await settle(h, daemon);
    expect(results(h)).toHaveLength(0);
  });

  /** 2026-09-24: `pnpm dev:admin`(-dev 태그)으로 prod 데몬에 붙으려다 아무 말 없이 안 됐다 — 로그로라도 말한다 */
  it('다른 모드 태그로 온 명령은 받지 않고, 그렇다고 로그에 남긴다', async () => {
    const warnings: string[] = [];
    const h = createHarness({ log: { ...silentLogger, warn: msg => { warnings.push(msg); } } });
    const daemon = h.start(new Db(':memory:'));
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, tagsFor('prod').admin, { cmd: 'ping' }, sec(h)));
    await settle(h, daemon);
    expect(results(h)).toHaveLength(0);
    expect(warnings.some(w => /다른 모드의 운영자 명령/.test(w))).toBe(true);
  });
});

describe('한 번만 (DM-004)', () => {
  it('같은 이벤트가 두 번 와도, 재구독으로 또 와도 한 번만 처리한다', async () => {
    const h = harness();
    h.relay.duplicateDelivery = true;
    const daemon = h.start(new Db(':memory:'));
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h)));
    await settle(h, daemon);
    daemon.ingress.reopen(); // 재구독 — 릴레이가 과거를 다시 준다
    await settle(h, daemon);
    expect(results(h)).toHaveLength(1);
  });

  /** 미래 시각으로 커서를 밀어 올리면 재구독이 진짜 이벤트를 건너뛴다 */
  it('먼 미래 시각 이벤트는 커서를 움직이지 않는다', async () => {
    const h = harness();
    const daemon = h.start(new Db(':memory:'));
    const before = daemon.ingress.since();
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h) + 24 * 3600));
    expect(daemon.ingress.since()).toBe(before);
  });
});

describe('발행 실패와 크래시 (DM-002 · §4.5)', () => {
  it('릴레이가 죽어 있으면 결과 발행을 재시도한다 — 같은 서명 이벤트로', async () => {
    const h = harness();
    const daemon = h.start(new Db(':memory:'));
    h.relay.failNext = 2;
    h.relay.failWhen = isResult;
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h)));
    await settle(h, daemon);
    expect(results(h)).toHaveLength(0);
    h.clock.now += backoffMs(1);
    await daemon.tick();
    expect(results(h)).toHaveLength(0);
    h.clock.now += backoffMs(2);
    await daemon.tick();
    expect(results(h)).toHaveLength(1);
    expect(h.relay.attempts.get(results(h)[0]!.id)).toBe(3);
  });

  /**
   * 결과를 쌓은 뒤 발행 전에 죽었다 → 재시작하면 **그 결과를** 낸다. 명령은 다시 집행하지 않는다
   * (inbox가 기억한다), 결과 이벤트 id도 죽기 전에 서명한 그것이다.
   */
  it('죽었다 살아나도 명령은 한 번, 결과는 결국 나간다', async () => {
    const h = harness();
    const dir = mkdtempSync(join(tmpdir(), 'lnpay-daemon-'));
    tmpDirs.push(dir);
    const path = join(dir, 'daemon.sqlite');

    const first = new Db(path);
    const daemonA = h.start(first);
    h.relay.failNext = 1;
    h.relay.failWhen = isResult;
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h)));
    await settle(h, daemonA);
    const pendingId = first.get<{ payload: string }>(`SELECT payload FROM effects WHERE status = 'pending'`);
    const signedBeforeCrash = (JSON.parse(pendingId!.payload) as { event: Event }).event.id;
    first.close(); // 크래시

    const second = new Db(path);
    const daemonB = h.start(second); // 재구독 — 릴레이가 같은 명령을 다시 준다
    h.clock.now += backoffMs(1);
    await settle(h, daemonB);

    const out = results(h);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(signedBeforeCrash);
    expect(second.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox`)?.n).toBe(1);
    second.close();
  });

  it('만료가 지난 결과는 포기한다 — 릴레이가 어차피 받지 않는다', async () => {
    const h = harness();
    const db = new Db(':memory:');
    const daemon = h.start(db);
    h.relay.failNext = 100;
    h.relay.failWhen = isResult;
    h.relay.inject(adminCommand(h.operator, h.app.pubkey, TAGS.admin, { cmd: 'ping' }, sec(h)));
    await settle(h, daemon);
    h.clock.now += 11 * 60_000;
    await daemon.tick();
    expect(db.get<{ status: string }>(`SELECT status FROM effects WHERE kind = 'nostr.publish'`)?.status).toBe('dead');
  });
});
